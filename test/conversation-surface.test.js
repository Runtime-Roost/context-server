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
            "acknowledge_direct_context",
            "activate_roost_session",
            "assemble_context",
            "cancel_context_job",
            "get_channel_context",
            "get_context",
            "get_context_job",
            "get_personal_context",
            "list_direct_inbox",
            "read_payload",
            "save_channel_context",
            "save_context",
            "save_personal_context",
            "search_channel_context",
            "search_context",
            "search_personal_context",
            "send_direct_context",
            "start_context_payload_job",
        ]);
        assert.ok(serialized.length < 25_000, `conversation schema was ${serialized.length} characters`);
        for (const name of ["save_personal_context", "search_personal_context", "get_personal_context"]) {
            const tool = response.tools.find((candidate) => candidate.name === name);
            assert.ok(tool);
            assert.deepEqual(tool.inputSchema.properties.auth.not, {});
        }
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
        assert.equal(response.tools.length, 77);
        assert.ok(response.tools.some(({ name }) => name === "vacuum_database"));
        assert.ok(response.tools.some(({ name }) => name === "connect_contexts"));
        assert.ok(response.tools.some(({ name }) => name === "disconnect_contexts"));
        assert.ok(response.tools.some(({ name }) => name === "update_context_lifecycle"));
        assert.ok(response.tools.some(({ name }) => name === "preview_auto_archive"));
        assert.ok(response.tools.some(({ name }) => name === "confirm_auto_archive"));
        assert.ok(response.tools.some(({ name }) => name === "assemble_context"));
        for (const name of ["begin_payload_upload", "append_payload_chunk", "finalize_payload_upload", "attach_payload_to_context"]) {
            assert.ok(response.tools.some((tool) => tool.name === name));
        }
        for (const name of ["save_personal_context", "search_personal_context", "get_personal_context"]) {
            const tool = response.tools.find((candidate) => candidate.name === name);
            assert.ok(tool?.inputSchema.properties.auth.anyOf);
        }
    } finally {
        await client.close();
        await server.close();
    }
});
