import assert from "node:assert/strict";
import test from "node:test";

process.env.PGDATABASE ??= "personal_context";
process.env.EMBEDDINGS_ENABLED = "false";
process.env.REQUIRE_CONTEXT_AUTHENTICATION = "true";
process.env.TRUST_OPENAI_TUNNEL_IDENTITY = "true";

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { createServer } = await import("../dist/mcp/server.js");
const { db } = await import("../dist/storage/db.js");
const { identifyActor, savePersonalContext } = await import("../dist/mcp/tools.js");

const tunnelMeta = {
    "openai/subject": "v1/context-authority-subject",
    "openai/session": "v1/context-authority-session",
};

test("Roost authority binding authenticates later protected Context calls", async () => {
    const externalId = `actor:test:roost-authority-${process.pid}-${Date.now()}`;
    const identified = await identifyActor({ external_id: externalId, name: "Roost authority test", kind: "ai" });
    const marker = `roost-authority-${Date.now()}`;
    const saved = await savePersonalContext(identified.actor.id, marker, ["roost-authority-test"], "test");
    const calls = [];
    const authenticated = {
        actor_id: identified.actor.id,
        actor_external_id: externalId,
        actor_name: identified.actor.name,
        key_id: "roost-sso-authority",
    };
    const authority = {
        async bind(identity, bindingId) {
            calls.push({ operation: "bind", identity, bindingId });
            return authenticated;
        },
        async authorize(identity) {
            calls.push({ operation: "authorize", identity });
            return authenticated;
        },
    };
    const server = createServer({ surface: "conversation", authority });
    const client = new Client({ name: "roost-authority-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
        const bound = await client.callTool({
            name: "bind_sso_session",
            arguments: { binding_handle: "rsb_00000000-0000-4000-8000-000000000001" },
            _meta: tunnelMeta,
        });
        assert.notEqual(bound.isError, true);

        const searched = await client.callTool({
            name: "search_personal_context",
            arguments: { query: marker, limit: 5 },
            _meta: tunnelMeta,
        });
        assert.notEqual(searched.isError, true);
        const body = JSON.parse(searched.content.find(({ type }) => type === "text").text);
        assert.ok(body.results.some(({ id }) => id === saved.id));
        assert.deepEqual(calls.map(({ operation }) => operation), ["bind", "authorize"]);
        assert.ok(calls.every(({ identity }) => identity.subject === tunnelMeta["openai/subject"]
            && identity.session === tunnelMeta["openai/session"]));
    } finally {
        await client.close();
        await server.close();
        await db.query("DELETE FROM contexts WHERE id = $1", [saved.id]);
        await db.query("DELETE FROM actors WHERE id = $1", [identified.actor.id]);
    }
});

test.after(async () => {
    await db.end();
});
