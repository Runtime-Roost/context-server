import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { runWakePolicy } = await import("../dist/wake/cli.js");

const secret = "a-deliberately-long-test-secret-with-32-bytes";

async function listen(socketPath, responses) {
    const requests = [];
    const server = createServer((request, response) => {
        const chunks = [];
        request.on("data", (chunk) => chunks.push(chunk));
        request.on("end", () => {
            const body = Buffer.concat(chunks);
            const timestamp = request.headers["x-agent-runtime-timestamp"];
            const eventId = request.headers["idempotency-key"];
            const expected = createHmac("sha256", secret)
                .update(Buffer.concat([Buffer.from(`${timestamp}\n${eventId}\n`), body]))
                .digest("hex");
            requests.push({ request, body: body.toString("utf8"), expected });
            const status = responses.shift() ?? 202;
            response.writeHead(status, { "content-type": "application/json" });
            response.end(JSON.stringify(status === 202
                ? { job_id: randomUUID(), status: "queued" }
                : { error: "temporarily unavailable" }));
        });
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
    });
    return {
        requests,
        close: () => new Promise((resolve, reject) =>
            server.close((error) => error ? reject(error) : resolve())),
    };
}

test("deliver mode signs the exact bounded body, retries, audits, and preserves a retryable outbox", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wake-delivery-"));
    const socketPath = join(directory, "runtime.sock");
    const credentialPath = join(directory, "credential");
    const policyPath = join(directory, "policy.json");
    const eventPath = join(directory, "event.json");
    const deliveryPath = join(directory, "delivery.json");
    const auditPath = join(directory, "audit.jsonl");
    const eventId = randomUUID();
    await writeFile(credentialPath, secret, { mode: 0o600 });
    await writeFile(policyPath, JSON.stringify({
        version: 1,
        mode: "deliver",
        target_actor_external_id: "actor:openai:codex",
        allowed_requester_actors: ["actor:human:blake"],
        allowed_trigger_types: ["explicit_user_request"],
        allowed_sources: ["personal-context-server"],
        cooldown_seconds: 0,
        max_event_age_seconds: 900,
        rate_limit: { max_wakes: 2, window_seconds: 3600 },
        invocation_timeout_seconds: 900,
        payload: {
            max_summary_chars: 20,
            max_context_ids: 1,
            allowed_metadata_keys: ["priority"],
        },
    }));
    await writeFile(eventPath, JSON.stringify({
        event_id: eventId,
        trigger_type: "explicit_user_request",
        source: "personal-context-server",
        requested_by_actor: "actor:human:blake",
        occurred_at: "2026-07-28T14:00:00.000Z",
        summary: "bounded summary that is longer",
        context_ids: [12, 13],
        metadata: { priority: "normal", secret: "drop me" },
    }));
    const deliveryConfig = {
        version: 1,
        socket_path: socketPath,
        endpoint: "/v1/wakes",
        credential_file: credentialPath,
        connect_timeout_ms: 1000,
        request_timeout_ms: 1000,
        retry: { max_attempts: 1, base_delay_ms: 0 },
        max_response_bytes: 4096,
    };
    await writeFile(deliveryPath, JSON.stringify(deliveryConfig));

    let runtime = await listen(socketPath, [500]);
    try {
        const first = await runWakePolicy({
            policy: policyPath,
            event: eventPath,
            audit: auditPath,
            delivery: deliveryPath,
            now: "2026-07-28T14:05:00.000Z",
            pretty: false,
        });
        assert.equal(first.delivery.accepted, false);
        assert.equal(runtime.requests[0].request.method, "POST");
        assert.equal(runtime.requests[0].request.url, "/v1/wakes");
        assert.equal(runtime.requests[0].request.headers["idempotency-key"], eventId);
        assert.equal(
            runtime.requests[0].request.headers["x-agent-runtime-signature"],
            `sha256=${runtime.requests[0].expected}`,
        );
        const body = JSON.parse(runtime.requests[0].body);
        assert.equal(body.trigger.event_id, eventId);
        assert.equal(body.dry_run, false);
        assert.equal(body.summary, "bounded summary that");
        assert.deepEqual(body.context_ids, [12]);
        assert.deepEqual(body.metadata, { priority: "normal" });
    } finally {
        await runtime.close();
    }

    runtime = await listen(socketPath, [202]);
    try {
        const retried = await runWakePolicy({
            audit: auditPath,
            delivery: deliveryPath,
            retryEvent: eventId,
            pretty: false,
        });
        assert.equal(retried.delivery.accepted, true);
        assert.equal(runtime.requests[0].body.includes("drop me"), false);
        await assert.rejects(
            runWakePolicy({
                audit: auditPath,
                delivery: deliveryPath,
                retryEvent: eventId,
                pretty: false,
            }),
            /No pending wake delivery/,
        );
        const records = (await readFile(auditPath, "utf8")).trim().split("\n").map(JSON.parse);
        assert.equal(records.filter((record) => record.type === "wake_outbox").length, 1);
        assert.deepEqual(
            records.filter((record) => record.type === "wake_delivery").map((record) => record.outcome),
            ["retryable", "accepted"],
        );
    } finally {
        await runtime.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test("wake delivery refuses a symlinked credential", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wake-credential-"));
    const credentialPath = join(directory, "credential");
    const symlinkPath = join(directory, "credential-link");
    await writeFile(credentialPath, secret, { mode: 0o600 });
    await symlink(credentialPath, symlinkPath);
    const { deliverWakeInvocation } = await import("../dist/wake/delivery.js");
    try {
        await assert.rejects(
            deliverWakeInvocation({
                version: 1,
                socket_path: join(directory, "unused.sock"),
                endpoint: "/v1/wakes",
                credential_file: symlinkPath,
                connect_timeout_ms: 100,
                request_timeout_ms: 100,
                retry: { max_attempts: 1, base_delay_ms: 0 },
                max_response_bytes: 1024,
            }, {
                decision: "allow",
                reasons: [],
                evaluated_at: new Date().toISOString(),
                policy_version: 1,
                mode: "deliver",
                event_id: "00000000-0000-4000-8000-000000000001",
                target_actor_external_id: "actor:openai:codex",
                invocation: {
                    target_actor_external_id: "actor:openai:codex",
                    requested_by_actor: "actor:human:blake",
                    trigger: {
                        event_id: "00000000-0000-4000-8000-000000000001",
                        type: "explicit_user_request",
                        source: "personal-context-server",
                        occurred_at: "2026-07-28T14:00:00.000Z",
                        channel: null,
                    },
                    summary: null,
                    context_ids: [],
                    metadata: {},
                    timeout_seconds: 60,
                    policy_version: 1,
                    dry_run: false,
                },
            }),
            /must not be a symbolic link/,
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
