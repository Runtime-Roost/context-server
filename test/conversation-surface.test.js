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
        for (const name of ["actor_purge_preview", "actor_purge_confirm", "vacuum_database"]) {
            const tool = response.tools.find((candidate) => candidate.name === name);
            assert.ok(tool?.inputSchema.properties.auth.anyOf, `${name} must expose optional actor authentication`);
            assert.ok(!tool.inputSchema.required?.includes("auth"), `${name} must allow trusted tunnel-bound auth`);
        }
    } finally {
        await client.close();
        await server.close();
    }
});

test("full-surface maintenance tools authorize before preview, purge, or vacuum work", async () => {
    const previousTrust = process.env.TRUST_OPENAI_TUNNEL_IDENTITY;
    process.env.TRUST_OPENAI_TUNNEL_IDENTITY = "true";
    const calls = [];
    const server = createServer({
        authority: {
            async authorize(_identity, tool, payload) {
                calls.push({ tool, payload });
                throw new Error("CAPABILITY_REQUIRED");
            },
        },
    });
    const client = new Client({ name: "maintenance-authorization-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
        const requests = [
            { name: "actor_purge_preview", arguments: { before: "2020-01-01T00:00:00Z" } },
            { name: "actor_purge_confirm", arguments: { before: "2020-01-01T00:00:00Z", confirmation_token: "unused", expected_count: 0 } },
            { name: "vacuum_database", arguments: {} },
        ];
        for (const request of requests) {
            const result = await client.callTool({ ...request, _meta: {
                "openai/subject": "v1/maintenance-authorization-subject",
                "openai/session": "v1/maintenance-authorization-session",
            } });
            assert.equal(result.isError, true, request.name);
            const body = JSON.parse(result.content.find(({ type }) => type === "text").text);
            assert.equal(body.error.code, "CAPABILITY_REQUIRED", request.name);
        }
        assert.deepEqual(calls.map(({ tool }) => tool), [
            "actor_purge_preview",
            "actor_purge_confirm",
            "vacuum_database",
        ]);
    } finally {
        await client.close();
        await server.close();
        if (previousTrust === undefined) delete process.env.TRUST_OPENAI_TUNNEL_IDENTITY;
        else process.env.TRUST_OPENAI_TUNNEL_IDENTITY = previousTrust;
    }
});

test("conversation surface rejects explicit actor credentials that could bypass its Roost policy", async () => {
    const calls = [];
    const server = createServer({
        surface: "conversation",
        authority: {
            async authorize(...args) { calls.push(args); throw new Error("CAPABILITY_REQUIRED"); },
        },
    });
    const client = new Client({ name: "conversation-auth-boundary-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
        const result = await client.callTool({
            name: "send_direct_context",
            arguments: {
                recipient_external_id: "actor:test:recipient",
                text: "must not bypass Roost policy",
                auth: {
                    session_id: "00000000-0000-4000-8000-000000000001",
                    session_token: "s".repeat(32),
                    timestamp: new Date().toISOString(),
                    nonce: "n".repeat(16),
                },
            },
        });
        assert.equal(result.isError, true);
        const body = JSON.parse(result.content.find(({ type }) => type === "text").text);
        assert.equal(body.error.code, "EXPLICIT_AUTH_NOT_ALLOWED");
        assert.equal(calls.length, 0);
    } finally {
        await client.close();
        await server.close();
    }
});

test("conversation authorization fails closed when Roost authority is unavailable", async () => {
    const previous = {
        trust: process.env.TRUST_OPENAI_TUNNEL_IDENTITY,
        require: process.env.REQUIRE_CONTEXT_AUTHENTICATION,
        keyPath: process.env.ROOST_SSO_OPERATOR_KEY_PATH,
        configHome: process.env.XDG_CONFIG_HOME,
    };
    process.env.TRUST_OPENAI_TUNNEL_IDENTITY = "true";
    process.env.REQUIRE_CONTEXT_AUTHENTICATION = "false";
    delete process.env.ROOST_SSO_OPERATOR_KEY_PATH;
    process.env.XDG_CONFIG_HOME = `/tmp/context-authority-missing-${process.pid}-${Date.now()}`;

    const server = createServer({ surface: "conversation" });
    const client = new Client({ name: "conversation-missing-authority-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
        const result = await client.callTool({
            name: "search_context",
            arguments: { query: "must not fall back to an actor session" },
            _meta: {
                "openai/subject": "v1/conversation-auth-boundary-subject",
                "openai/session": "v1/conversation-auth-boundary-session",
            },
        });
        assert.equal(result.isError, true);
        const body = JSON.parse(result.content.find(({ type }) => type === "text").text);
        assert.equal(body.error.code, "AUTHORITY_NOT_CONFIGURED");
    } finally {
        await client.close();
        await server.close();
        if (previous.trust === undefined) delete process.env.TRUST_OPENAI_TUNNEL_IDENTITY;
        else process.env.TRUST_OPENAI_TUNNEL_IDENTITY = previous.trust;
        if (previous.require === undefined) delete process.env.REQUIRE_CONTEXT_AUTHENTICATION;
        else process.env.REQUIRE_CONTEXT_AUTHENTICATION = previous.require;
        if (previous.keyPath === undefined) delete process.env.ROOST_SSO_OPERATOR_KEY_PATH;
        else process.env.ROOST_SSO_OPERATOR_KEY_PATH = previous.keyPath;
        if (previous.configHome === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = previous.configHome;
    }
});
