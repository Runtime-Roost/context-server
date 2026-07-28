import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { WakeDecision, WakeHistoryEntry } from "./policy.js";
import type { WakeDeliveryAttempt, WakeOutboxRecord } from "./delivery.js";

export async function readWakeHistory(path: string): Promise<WakeHistoryEntry[]> {
    try {
        const content = await readFile(resolve(path), "utf8");
        return content
            .split(/\r?\n/)
            .filter(Boolean)
            .map((line, index) => {
                let parsed: Partial<WakeHistoryEntry> & { type?: string };
                try {
                    parsed = JSON.parse(line) as Partial<WakeHistoryEntry>;
                } catch {
                    throw new Error(`Invalid wake audit JSON on line ${index + 1}.`);
                }
                if (parsed.type === "wake_outbox" || parsed.type === "wake_delivery") return null;
                if (
                    typeof parsed.evaluated_at !== "string"
                    || !Number.isFinite(new Date(parsed.evaluated_at).getTime())
                    || (parsed.decision !== "allow" && parsed.decision !== "deny")
                    || typeof parsed.event_id !== "string"
                    || parsed.event_id.length === 0
                    || typeof parsed.target_actor_external_id !== "string"
                    || parsed.target_actor_external_id.length === 0
                ) {
                    throw new Error(`Invalid wake audit record on line ${index + 1}.`);
                }
                return parsed as WakeHistoryEntry;
            })
            .filter((entry): entry is WakeHistoryEntry => entry !== null);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
    }
}

export async function withWakeAuditLock<T>(path: string, operation: () => Promise<T>) {
    const lockPath = `${resolve(path)}.lock`;
    await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
    let lock;
    try {
        lock = await open(lockPath, "wx", 0o600);
        await lock.write(`${process.pid}\n`);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            throw new Error("Wake policy evaluation is already in progress.");
        }
        throw error;
    }
    try {
        return await operation();
    } finally {
        await lock.close();
        await unlink(lockPath).catch(() => undefined);
    }
}

export async function appendWakeAudit(path: string, decision: WakeDecision) {
    const absolutePath = resolve(path);
    await mkdir(dirname(absolutePath), { recursive: true, mode: 0o700 });
    const handle = await open(absolutePath, "a", 0o600);
    try {
        await handle.write(`${JSON.stringify(decision)}\n`);
        await handle.sync();
    } finally {
        await handle.close();
    }
}

export async function appendWakeDecisionAndOutbox(
    path: string,
    decision: WakeDecision,
    outbox: WakeOutboxRecord,
) {
    const absolutePath = resolve(path);
    await mkdir(dirname(absolutePath), { recursive: true, mode: 0o700 });
    const handle = await open(absolutePath, "a", 0o600);
    try {
        await handle.write(`${JSON.stringify(decision)}\n${JSON.stringify(outbox)}\n`);
        await handle.sync();
    } finally {
        await handle.close();
    }
}

export async function appendWakeDeliveryAudit(path: string, attempt: WakeDeliveryAttempt) {
    const absolutePath = resolve(path);
    await mkdir(dirname(absolutePath), { recursive: true, mode: 0o700 });
    const handle = await open(absolutePath, "a", 0o600);
    try {
        await handle.write(`${JSON.stringify({ type: "wake_delivery", ...attempt })}\n`);
        await handle.sync();
    } finally {
        await handle.close();
    }
}

export async function readWakeOutbox(path: string, eventId: string): Promise<WakeOutboxRecord | null> {
    let content: string;
    try {
        content = await readFile(resolve(path), "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
    }
    const records = content.split(/\r?\n/).filter(Boolean).map((line, index) => {
        try {
            return JSON.parse(line) as Record<string, unknown>;
        } catch {
            throw new Error(`Invalid wake audit JSON on line ${index + 1}.`);
        }
    });
    const accepted = records.some((record) =>
        record.type === "wake_delivery"
        && record.event_id === eventId
        && record.outcome === "accepted"
    );
    if (accepted) return null;
    const outbox = records.find((record) => record.type === "wake_outbox" && record.event_id === eventId);
    if (!outbox) return null;
    if (
        typeof outbox.created_at !== "string"
        || typeof outbox.invocation_sha256 !== "string"
        || typeof outbox.invocation !== "object"
        || outbox.invocation === null
    ) {
        throw new Error(`Invalid wake outbox record for ${eventId}.`);
    }
    return outbox as unknown as WakeOutboxRecord;
}
