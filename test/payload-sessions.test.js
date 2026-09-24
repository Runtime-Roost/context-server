import assert from "node:assert/strict";
import test from "node:test";

process.env.PGDATABASE ??= "personal_context";
process.env.EMBEDDINGS_ENABLED = "false";

const { identifyActor, savePersonalContext } = await import("../dist/mcp/tools.js");
const { db } = await import("../dist/storage/db.js");
const {
  cancelContextJob, getContextJob, readContextPayload, startContextPayloadJob,
} = await import("../dist/storage/payload-sessions.js");

test("payload reads are authorized, version-pinned, bounded, and UTF-8 safe", async () => {
  const owner = await identifyActor({ external_id: `actor:test:payload-owner-${Date.now()}`, name: "Payload owner" });
  const outsider = await identifyActor({ external_id: `actor:test:payload-outsider-${Date.now()}`, name: "Payload outsider" });
  const text = `alpha 🖍️ beta ${"z".repeat(200)}`;
  const saved = await savePersonalContext(owner.actor.id, text, ["payload-test"], "test");
  try {
    const ref = saved.payload_ref;
    assert.equal(await readContextPayload(outsider.actor.id, ref.id, 0, 8), null);
    const first = await readContextPayload(owner.actor.id, ref.id, 0, 8);
    assert.ok(Buffer.byteLength(first.text, "utf8") <= 8);
    assert.equal(first.byte_start, 0);
    assert.equal(first.next_offset, first.byte_stop);
    const second = await readContextPayload(owner.actor.id, ref.id, first.next_offset, 8);
    assert.equal(Buffer.from(first.text + second.text, "utf8").subarray(0, first.byte_stop + (second.byte_stop - second.byte_start)).toString("utf8"), first.text + second.text);
    assert.match(first.payload_ref.sha256, /^[0-9a-f]{64}$/);
  } finally {
    await db.query("DELETE FROM actors WHERE id = ANY($1::bigint[])", [[owner.actor.id, outsider.actor.id]]);
  }
});

test("retrieval jobs are actor and conversation scoped and produce payload references", async () => {
  const actor = await identifyActor({ external_id: `actor:test:job-owner-${Date.now()}`, name: "Job owner" });
  const saved = await savePersonalContext(actor.actor.id, "job payload", ["job-test"], "test");
  try {
    const started = await startContextPayloadJob(actor.actor.id, "conversation-a", saved.id);
    assert.equal(started.status, "QUEUED");
    assert.equal(await getContextJob(actor.actor.id, "conversation-b", started.job_id), null);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const complete = await getContextJob(actor.actor.id, "conversation-a", started.job_id);
    assert.equal(complete.status, "COMPLETE");
    assert.equal(complete.payload_ref.id, saved.payload_ref.id);
    assert.equal(await cancelContextJob(actor.actor.id, "conversation-a", started.job_id), null);
  } finally {
    await db.query("DELETE FROM actors WHERE id = $1", [actor.actor.id]);
  }
});

test.after(async () => { await db.end(); });
