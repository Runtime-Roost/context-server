import assert from "node:assert/strict";
import test from "node:test";

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { createServer } = await import("../dist/mcp/server.js");

test("conversation surface advertises only the bounded conversational contract", async () => {
    const server = createServer({ surface: "conversation" });
    const client = new Client({ name: "conversation-surface-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
        const response = await client.listTools();
        const names = response.tools.map(({ name }) => name).sort();
        const serialized = JSON.stringify(response);

        assert.deepEqual(names, [
            "acknowledge_context",
            "acknowledge_direct_context",
            "bind_sso_session",
            "get_actor_session_request_status",
            "get_channel_context",
            "get_context",
            "get_personal_context",
            "list_direct_inbox",
            "request_actor_session",
            "save_channel_context",
            "save_context",
            "save_personal_context",
            "search_channel_context",
            "search_context",
            "search_personal_context",
            "send_direct_context",
        ]);
        assert.ok(serialized.length < 25_000, `conversation schema was ${serialized.length} characters`);
    } finally {
        await client.close();
        await server.close();
    }
});

test("full surface remains available for local administration", async () => {
    const server = createServer();
    const client = new Client({ name: "full-surface-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
        const response = await client.listTools();
        assert.equal(response.tools.length, 67);
        assert.ok(response.tools.some(({ name }) => name === "vacuum_database"));
        assert.ok(response.tools.some(({ name }) => name === "connect_contexts"));
        assert.ok(response.tools.some(({ name }) => name === "disconnect_contexts"));
        assert.ok(response.tools.some(({ name }) => name === "update_context_lifecycle"));
        assert.ok(response.tools.some(({ name }) => name === "preview_auto_archive"));
        assert.ok(response.tools.some(({ name }) => name === "confirm_auto_archive"));
    } finally {
        await client.close();
        await server.close();
    }
});
