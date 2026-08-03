import { createHash, createHmac } from "node:crypto";
import { constants } from "node:fs";
import http from "node:http";
import { open } from "node:fs/promises";

import { z } from "zod";

import { wakeInvocationSchema, type WakeDecision } from "./policy.js";

export const wakeDeliveryConfigSchema = z.object({
    version: z.literal(1),
    socket_path: z.string().min(1).max(4_096).refine((value) => value.startsWith("/"), {
        message: "socket_path must be absolute",
    }),
    endpoint: z.string().regex(/^\/[a-zA-Z0-9/_-]*$/).max(500).default("/v1/wakes"),
    credential_file: z.string().min(1).max(4_096).refine((value) => value.startsWith("/"), {
        message: "credential_file must be absolute",
    }),
    connect_timeout_ms: z.number().int().positive().max(60_000).default(2_000),
    request_timeout_ms: z.number().int().positive().max(300_000).default(10_000),
    retry: z.object({
        max_attempts: z.number().int().positive().max(10).default(3),
        base_delay_ms: z.number().int().nonnegative().max(60_000).default(250),
    }).strict(),
    max_response_bytes: z.number().int().positive().max(1_048_576).default(16_384),
}).strict();

export type WakeDeliveryConfig = z.infer<typeof wakeDeliveryConfigSchema>;

export type WakeDeliveryAttempt = {
    attempted_at: string;
    attempt: number;
    event_id: string;
    outcome: "accepted" | "retryable" | "rejected";
    status_code: number | null;
    response_body: string | null;
    error: string | null;
};

export type WakeDeliveryResult = {
    event_id: string;
    accepted: boolean;
    attempts: WakeDeliveryAttempt[];
};

export type WakeOutboxRecord = {
    type: "wake_outbox";
    created_at: string;
    event_id: string;
    invocation_sha256: string;
    invocation: NonNullable<WakeDecision["invocation"]>;
};

export function createWakeOutboxRecord(decision: WakeDecision): WakeOutboxRecord {
    if (decision.decision !== "allow" || !decision.invocation || decision.invocation.dry_run) {
        throw new Error("Only an allowed non-dry-run invocation can enter the wake outbox.");
    }
    const encoded = Buffer.from(JSON.stringify(decision.invocation), "utf8");
    return {
        type: "wake_outbox",
        created_at: new Date().toISOString(),
        event_id: decision.event_id,
        invocation_sha256: createHash("sha256").update(encoded).digest("hex"),
        invocation: decision.invocation,
    };
}

export function decisionFromOutbox(record: WakeOutboxRecord): WakeDecision {
    const invocation = wakeInvocationSchema.parse(record.invocation);
    const encoded = Buffer.from(JSON.stringify(invocation), "utf8");
    const digest = createHash("sha256").update(encoded).digest("hex");
    if (digest !== record.invocation_sha256 || record.event_id !== invocation.trigger.event_id) {
        throw new Error(`Wake outbox integrity check failed for ${record.event_id}.`);
    }
    return {
        decision: "allow",
        reasons: [],
        evaluated_at: record.created_at,
        policy_version: invocation.policy_version,
        mode: "deliver",
        event_id: record.event_id,
        target_actor_external_id: invocation.target_actor_external_id,
        invocation,
    };
}

export function canonicalWakeRequest(
    timestamp: string,
    idempotencyKey: string,
    body: Buffer,
) {
    return Buffer.concat([
        Buffer.from(`${timestamp}\n${idempotencyKey}\n`, "utf8"),
        body,
    ]);
}

async function readCredential(path: string) {
    let handle;
    try {
        handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ELOOP") {
            throw new Error("Wake delivery credential must not be a symbolic link.");
        }
        throw error;
    }
    try {
        const credentialStat = await handle.stat();
        if (!credentialStat.isFile()) {
            throw new Error("Wake delivery credential must be a regular file.");
        }
        if ((credentialStat.mode & 0o077) !== 0) {
            throw new Error("Wake delivery credential must not be accessible by group or other.");
        }
        return (await handle.readFile("utf8")).trimEnd();
    } finally {
        await handle.close();
    }
}

function wait(delayMs: number) {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function requestOnce(
    config: WakeDeliveryConfig,
    body: Buffer,
    eventId: string,
    secret: string,
): Promise<{ statusCode: number; body: string }> {
    const timestamp = new Date().toISOString();
    const canonical = canonicalWakeRequest(timestamp, eventId, body);
    const signature = createHmac("sha256", secret).update(canonical).digest("hex");

    return new Promise((resolve, reject) => {
        const request = http.request({
            socketPath: config.socket_path,
            path: config.endpoint,
            method: "POST",
            headers: {
                "content-type": "application/json",
                "content-length": body.byteLength,
                "idempotency-key": eventId,
                "x-agent-runtime-timestamp": timestamp,
                "x-agent-runtime-signature": `sha256=${signature}`,
            },
            timeout: config.request_timeout_ms,
        });
        const connectTimer = setTimeout(() => {
            request.destroy(new Error("Agent runtime connection timed out."));
        }, config.connect_timeout_ms);
        request.once("socket", (socket) => socket.once("connect", () => clearTimeout(connectTimer)));
        request.once("error", (error) => {
            clearTimeout(connectTimer);
            reject(error);
        });
        request.once("timeout", () => request.destroy(new Error("Agent runtime request timed out.")));
        request.once("response", (response) => {
            clearTimeout(connectTimer);
            const chunks: Buffer[] = [];
            let length = 0;
            response.on("data", (chunk: Buffer) => {
                length += chunk.length;
                if (length > config.max_response_bytes) {
                    request.destroy(new Error("Agent runtime response exceeded max_response_bytes."));
                    return;
                }
                chunks.push(chunk);
            });
            response.once("error", reject);
            response.once("end", () => resolve({
                statusCode: response.statusCode ?? 0,
                body: Buffer.concat(chunks).toString("utf8"),
            }));
        });
        request.end(body);
    });
}

export async function deliverWakeInvocation(
    config: WakeDeliveryConfig,
    decision: WakeDecision,
    onAttempt?: (attempt: WakeDeliveryAttempt) => Promise<void>,
): Promise<WakeDeliveryResult> {
    if (decision.decision !== "allow" || !decision.invocation || decision.invocation.dry_run) {
        throw new Error("Only an allowed non-dry-run wake invocation can be delivered.");
    }
    const secret = await readCredential(config.credential_file);
    if (Buffer.byteLength(secret, "utf8") < 32) {
        throw new Error("Wake delivery credential must contain at least 32 bytes.");
    }

    const body = Buffer.from(JSON.stringify(decision.invocation), "utf8");
    const attempts: WakeDeliveryAttempt[] = [];
    for (let attempt = 1; attempt <= config.retry.max_attempts; attempt += 1) {
        try {
            const response = await requestOnce(config, body, decision.event_id, secret);
            const accepted = response.statusCode === 202;
            const retryable = response.statusCode === 408
                || response.statusCode === 425
                || response.statusCode === 429
                || response.statusCode >= 500;
            const recorded: WakeDeliveryAttempt = {
                attempted_at: new Date().toISOString(),
                attempt,
                event_id: decision.event_id,
                outcome: accepted ? "accepted" : retryable ? "retryable" : "rejected",
                status_code: response.statusCode,
                response_body: response.body || null,
                error: null,
            };
            attempts.push(recorded);
            await onAttempt?.(recorded);
            if (accepted) return { event_id: decision.event_id, accepted: true, attempts };
            if (!retryable) return { event_id: decision.event_id, accepted: false, attempts };
        } catch (error) {
            const recorded: WakeDeliveryAttempt = {
                attempted_at: new Date().toISOString(),
                attempt,
                event_id: decision.event_id,
                outcome: "retryable",
                status_code: null,
                response_body: null,
                error: error instanceof Error ? error.message : String(error),
            };
            attempts.push(recorded);
            await onAttempt?.(recorded);
        }
        if (attempt < config.retry.max_attempts) {
            await wait(config.retry.base_delay_ms * 2 ** (attempt - 1));
        }
    }
    return { event_id: decision.event_id, accepted: false, attempts };
}
