import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { evaluateWakePolicy, wakeEventSchema, wakePolicySchema } = await import("../dist/wake/policy.js");
const { readWakeHistory } = await import("../dist/wake/audit.js");
const { runDryRun } = await import("../dist/wake/cli.js");

const now = new Date("2026-07-28T14:05:00.000Z");
const policy = wakePolicySchema.parse({
    version: 1,
    mode: "dry-run",
    target_actor_external_id: "actor:openai:codex",
    allowed_requester_actors: ["actor:human:blake"],
    allowed_trigger_types: ["explicit_user_request"],
    allowed_sources: ["personal-context-server"],
    allowed_channels: ["mamagpt-codex-private"],
    cooldown_seconds: 300,
    max_event_age_seconds: 900,
    rate_limit: { max_wakes: 2, window_seconds: 3600 },
    invocation_timeout_seconds: 900,
    payload: {
        max_summary_chars: 12,
        max_context_ids: 2,
        allowed_metadata_keys: ["priority"],
    },
});

function event(overrides = {}) {
    return wakeEventSchema.parse({
        event_id: randomUUID(),
        trigger_type: "explicit_user_request",
        source: "personal-context-server",
        requested_by_actor: "actor:human:blake",
        occurred_at: "2026-07-28T14:00:00.000Z",
        channel: "mamagpt-codex-private",
        summary: "A deliberately longer bounded summary",
        context_ids: [1266, 1267, 1266, 1268],
        metadata: { priority: "normal", secret: "must not cross boundary" },
        ...overrides,
    });
}

test("wake policy allows only a bounded dry-run invocation payload", () => {
    const decision = evaluateWakePolicy(policy, event(), [], now);
    assert.equal(decision.decision, "allow");
    assert.equal(decision.invocation.dry_run, true);
    assert.equal(decision.invocation.summary, "A deliberate");
    assert.deepEqual(decision.invocation.context_ids, [1266, 1267]);
    assert.deepEqual(decision.invocation.metadata, { priority: "normal" });
    assert.equal("secret" in decision.invocation.metadata, false);
});

test("deliver mode produces the same bounded invocation with execution explicitly enabled", () => {
    const decision = evaluateWakePolicy({ ...policy, mode: "deliver" }, event(), [], now);
    assert.equal(decision.decision, "allow");
    assert.equal(decision.invocation.dry_run, false);
});

test("wake policy fails closed across identity, trigger, source, channel, time, replay, cooldown, and rate limits", () => {
    const candidate = event({
        requested_by_actor: "actor:openai:chatgpt",
        trigger_type: "ambient_activity",
        source: "untrusted-app",
        channel: "public",
        occurred_at: "2026-07-28T13:00:00.000Z",
    });
    const history = [
        {
            evaluated_at: "2026-07-28T14:04:00.000Z",
            decision: "allow",
            event_id: candidate.event_id,
            target_actor_external_id: "actor:openai:codex",
        },
        {
            evaluated_at: "2026-07-28T13:30:00.000Z",
            decision: "allow",
            event_id: randomUUID(),
            target_actor_external_id: "actor:openai:codex",
        },
    ];
    const decision = evaluateWakePolicy(policy, candidate, history, now);
    assert.equal(decision.decision, "deny");
    assert.equal(decision.invocation, null);
    assert.deepEqual(new Set(decision.reasons), new Set([
        "REQUESTER_NOT_ALLOWED",
        "TRIGGER_NOT_ALLOWED",
        "SOURCE_NOT_ALLOWED",
        "CHANNEL_NOT_ALLOWED",
        "EVENT_TOO_OLD",
        "DUPLICATE_EVENT",
        "COOLDOWN_ACTIVE",
        "RATE_LIMIT_EXCEEDED",
    ]));
});

test("disabled policy always denies", () => {
    const decision = evaluateWakePolicy({ ...policy, mode: "disabled" }, event(), [], now);
    assert.equal(decision.decision, "deny");
    assert.deepEqual(decision.reasons, ["POLICY_DISABLED"]);
});

test("malformed audit history fails closed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wake-audit-invalid-"));
    const audit = join(directory, "audit.jsonl");
    try {
        await writeFile(audit, "{\"decision\":\"allow\"}\n", { mode: 0o600 });
        await assert.rejects(readWakeHistory(audit), /Invalid wake audit record on line 1/);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("dry-run CLI audits an allow and rejects replay without launching anything", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wake-cli-"));
    const policyPath = join(directory, "policy.json");
    const eventPath = join(directory, "event.json");
    const auditPath = join(directory, "audit.jsonl");
    const candidate = event();
    try {
        await writeFile(policyPath, JSON.stringify(policy), { mode: 0o600 });
        await writeFile(eventPath, JSON.stringify(candidate), { mode: 0o600 });
        const options = {
            policy: policyPath,
            event: eventPath,
            audit: auditPath,
            now: now.toISOString(),
            pretty: false,
        };
        const first = await runDryRun(options);
        assert.equal(first.decision, "allow");

        const replay = await runDryRun(options);
        assert.equal(replay.decision, "deny");
        assert.deepEqual(replay.reasons, ["DUPLICATE_EVENT", "COOLDOWN_ACTIVE"]);

        const lines = (await readFile(auditPath, "utf8")).trim().split("\n").map(JSON.parse);
        assert.equal(lines.length, 2);
        assert.equal(lines[0].decision, "allow");
        assert.equal(lines[1].decision, "deny");
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
