import assert from "node:assert/strict";
import test from "node:test";

process.env.PGDATABASE ??= "personal_context";
process.env.EMBEDDINGS_ENABLED = "false";

const { db } = await import("../dist/storage/db.js");
const {
    acknowledgeDirectContext,
    getDirectContext,
    identifyActor,
    listDirectInbox,
    saveDirectContext,
} = await import("../dist/mcp/tools.js");

function uniqueValue(prefix) {
    return `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

test("direct inbox delivery is deterministic, recipient-only, and acknowledgement-aware", async () => {
    const sender = await identifyActor({
        external_id: uniqueValue("actor:test:direct-sender"),
        name: "Direct Sender",
        kind: "ai",
    });
    const recipient = await identifyActor({
        external_id: uniqueValue("actor:test:direct-recipient"),
        name: "Direct Recipient",
        kind: "ai",
    });
    const outsider = await identifyActor({
        external_id: uniqueValue("actor:test:direct-outsider"),
        name: "Direct Outsider",
        kind: "ai",
    });
    const contextIds = [];

    try {
        const first = await saveDirectContext(
            sender.actor.id,
            recipient.actor.external_id,
            uniqueValue("first-direct-message"),
            ["direct-inbox-test"],
            "direct inbox test",
        );
        const second = await saveDirectContext(
            sender.actor.id,
            recipient.actor.external_id,
            uniqueValue("second-direct-message"),
            ["direct-inbox-test"],
            "direct inbox test",
        );
        contextIds.push(first.context.id, second.context.id);

        assert.ok(second.sequence > first.sequence);
        assert.equal(first.context.visibility, "direct");
        assert.equal(first.context.actor.id, sender.actor.id);

        const inbox = await listDirectInbox(recipient.actor.id, { limit: 10 });
        const delivered = inbox.filter(({ context }) => contextIds.includes(context.id));
        assert.deepEqual(delivered.map(({ context }) => context.id), [second.context.id, first.context.id]);
        assert.ok(delivered.every(({ acknowledged_at }) => acknowledged_at === null));

        assert.ok((await listDirectInbox(sender.actor.id, { limit: 100 })).every(({ context }) => !contextIds.includes(context.id)));
        assert.ok((await listDirectInbox(outsider.actor.id, { limit: 100 })).every(({ context }) => !contextIds.includes(context.id)));
        assert.equal(await getDirectContext(sender.actor.id, first.context.id), null);
        assert.equal(await getDirectContext(outsider.actor.id, first.context.id), null);
        assert.equal((await getDirectContext(recipient.actor.id, first.context.id))?.context.id, first.context.id);

        const since = await listDirectInbox(recipient.actor.id, {
            limit: 10,
            sinceSequence: first.sequence,
        });
        assert.deepEqual(
            since.filter(({ context }) => contextIds.includes(context.id)).map(({ context }) => context.id),
            [second.context.id],
        );

        assert.equal(await acknowledgeDirectContext(sender.actor.id, first.context.id), null);
        const acknowledged = await acknowledgeDirectContext(recipient.actor.id, first.context.id);
        assert.equal(acknowledged?.acknowledged, true);
        assert.ok(acknowledged?.acknowledged_at);
        const acknowledgedAgain = await acknowledgeDirectContext(recipient.actor.id, first.context.id);
        assert.equal(acknowledgedAgain?.acknowledged_at, acknowledged?.acknowledged_at);

        const unread = await listDirectInbox(recipient.actor.id, { limit: 10, unreadOnly: true });
        assert.ok(unread.some(({ context }) => context.id === second.context.id));
        assert.ok(unread.every(({ context }) => context.id !== first.context.id));

        await assert.rejects(
            saveDirectContext(sender.actor.id, uniqueValue("actor:test:missing-recipient"), "undeliverable"),
            /Recipient actor is not registered/,
        );
    } finally {
        if (contextIds.length > 0) {
            await db.query("DELETE FROM contexts WHERE id = ANY($1::bigint[])", [contextIds]);
        }
        await db.query("DELETE FROM actors WHERE id = ANY($1::bigint[])", [[sender.actor.id, recipient.actor.id, outsider.actor.id]]);
    }
});

test.after(async () => {
    await db.end();
});
