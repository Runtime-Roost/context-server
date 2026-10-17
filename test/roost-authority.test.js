import assert from "node:assert/strict";
import test from "node:test";

process.env.PGDATABASE ??= "personal_context";
process.env.EMBEDDINGS_ENABLED = "false";
process.env.REQUIRE_CONTEXT_AUTHENTICATION = "true";
process.env.TRUST_OPENAI_TUNNEL_IDENTITY = "true";

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { createServer } = await import("../dist/mcp/server.js");
const { configuredContextAuthority, enforceRoostToolCapability } = await import("../dist/auth/roost-sso-authority.js");
const { db } = await import("../dist/storage/db.js");
const { identifyActor, savePersonalContext } = await import("../dist/mcp/tools.js");

const tunnelMeta = {
    "openai/subject": "v1/context-authority-subject",
    "openai/session": "v1/context-authority-session",
};

test("Roost capabilities limit shared Whiteboard and channel tools to their grants", () => {
    const supervisor = ["context.supervisor.read"];
    for (const tool of ["get_context", "search_context", "search_personal_context", "list_direct_inbox", "get_direct_context"]) {
        assert.doesNotThrow(() => enforceRoostToolCapability(supervisor, tool));
    }
    for (const tool of ["save_context", "save_channel_context", "send_direct_context", "acknowledge_direct_context", "save_personal_context", "start_context_payload_job"]) {
        assert.throws(() => enforceRoostToolCapability(supervisor, tool), /CAPABILITY_REQUIRED/);
    }

    const whiteboardReader = ["context.whiteboard.read"];
    assert.doesNotThrow(() => enforceRoostToolCapability(whiteboardReader, "search_context"));
    assert.doesNotThrow(() => enforceRoostToolCapability(whiteboardReader, "get_context", { class: "whiteboard" }));
    assert.doesNotThrow(() => enforceRoostToolCapability(whiteboardReader, "read_payload", { class: "whiteboard" }));
    assert.throws(() => enforceRoostToolCapability(whiteboardReader, "save_context"), /CAPABILITY_REQUIRED/);
    assert.throws(() => enforceRoostToolCapability(whiteboardReader, "search_channel_context"), /CAPABILITY_REQUIRED/);
    assert.throws(() => enforceRoostToolCapability(whiteboardReader, "get_context", { class: "channel" }), /CAPABILITY_REQUIRED/);
    for (const [tool, payload] of [
        ["send_direct_context", {}],
        ["list_direct_inbox", {}],
        ["acknowledge_direct_context", {}],
        ["save_personal_context", {}],
        ["search_personal_context", {}],
        ["start_context_payload_job", {}],
        ["get_context", { class: "direct" }],
        ["read_payload", { class: "direct" }],
        ["actor_purge_preview", { before: "2020-01-01" }],
        ["actor_purge_confirm", { before: "2020-01-01", confirmation_token: "token", expected_count: 0 }],
        ["vacuum_database", {}],
        ["new_future_write_tool", {}],
    ]) {
        assert.throws(() => enforceRoostToolCapability(whiteboardReader, tool, payload), /CAPABILITY_REQUIRED/, tool);
    }

    const channelReader = ["context.channel.read"];
    assert.doesNotThrow(() => enforceRoostToolCapability(channelReader, "search_channel_context"));
    assert.throws(() => enforceRoostToolCapability(channelReader, "search_context"), /CAPABILITY_REQUIRED/);
    assert.throws(() => enforceRoostToolCapability(channelReader, "save_context"), /CAPABILITY_REQUIRED/);

    assert.doesNotThrow(() => enforceRoostToolCapability(["context.whiteboard.write"], "save_context"));
    assert.doesNotThrow(() => enforceRoostToolCapability(["context.channel.write"], "save_channel_context"));
    assert.throws(() => enforceRoostToolCapability(["context.channel.write"], "save_context"), /CAPABILITY_REQUIRED/);
    assert.throws(() => enforceRoostToolCapability(["context.read"], "search_context"), /CAPABILITY_REQUIRED/);
    assert.throws(() => enforceRoostToolCapability(["context.write"], "save_context"), /CAPABILITY_REQUIRED/);

    const directMessenger = ["messaging.direct.send:actor:openai:codex"];
    assert.doesNotThrow(() => enforceRoostToolCapability(directMessenger, "send_direct_context", {
        recipient_external_id: "actor:openai:codex",
    }));
    assert.throws(() => enforceRoostToolCapability(directMessenger, "send_direct_context", {
        recipient_external_id: "actor:openai:other",
    }), /CAPABILITY_REQUIRED/);
    assert.throws(() => enforceRoostToolCapability(directMessenger, "send_direct_context", {
        recipient_external_id: "actor:openai:codex" + "x".repeat(260),
    }), /CAPABILITY_REQUIRED/);
    assert.throws(() => enforceRoostToolCapability(directMessenger, "save_context"), /CAPABILITY_REQUIRED/);
    assert.throws(() => enforceRoostToolCapability(directMessenger, "list_direct_inbox"), /CAPABILITY_REQUIRED/);

    assert.throws(() => enforceRoostToolCapability(["context.personal.write"], "send_direct_context"), /CAPABILITY_REQUIRED/);
    assert.doesNotThrow(() => enforceRoostToolCapability(["context.personal.write"], "save_personal_context"));
    assert.doesNotThrow(() => enforceRoostToolCapability(["context.admin.purge"], "actor_purge_preview", { before: "2020-01-01" }));
    assert.doesNotThrow(() => enforceRoostToolCapability(["context.admin.purge"], "actor_purge_confirm", { before: "2020-01-01", confirmation_token: "token", expected_count: 0 }));
    assert.doesNotThrow(() => enforceRoostToolCapability(["context.admin.maintenance"], "vacuum_database"));
    assert.throws(() => enforceRoostToolCapability(["context.admin.purge"], "vacuum_database"), /CAPABILITY_REQUIRED/);
    assert.throws(() => enforceRoostToolCapability(undefined, "get_context"), /AUTHORITY_CAPABILITIES_INVALID/);
});

test("trusted tunnel identity enables the conventional local Roost authority", () => {
    const previousTrust = process.env.TRUST_OPENAI_TUNNEL_IDENTITY;
    const previousPath = process.env.ROOST_SSO_OPERATOR_KEY_PATH;
    const previousConfigHome = process.env.XDG_CONFIG_HOME;
    try {
        delete process.env.ROOST_SSO_OPERATOR_KEY_PATH;
        process.env.XDG_CONFIG_HOME = `/tmp/context-authority-missing-${process.pid}-${Date.now()}`;
        process.env.TRUST_OPENAI_TUNNEL_IDENTITY = "false";
        assert.equal(configuredContextAuthority(), undefined);
        process.env.TRUST_OPENAI_TUNNEL_IDENTITY = "true";
        assert.equal(configuredContextAuthority(), undefined);
        process.env.ROOST_SSO_OPERATOR_KEY_PATH = "/tmp/explicit-roost-authority-key";
        assert.ok(configuredContextAuthority());
    } finally {
        if (previousTrust === undefined) delete process.env.TRUST_OPENAI_TUNNEL_IDENTITY;
        else process.env.TRUST_OPENAI_TUNNEL_IDENTITY = previousTrust;
        if (previousPath === undefined) delete process.env.ROOST_SSO_OPERATOR_KEY_PATH;
        else process.env.ROOST_SSO_OPERATOR_KEY_PATH = previousPath;
        if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = previousConfigHome;
    }
});

test("missing one-use Roost handoff gives a recovery instruction without claiming authentication", async () => {
    const authority = {
        async activate() { throw new Error("SERVICE_BINDING_INVALID"); },
    };
    const server = createServer({ surface: "conversation", authority });
    const client = new Client({ name: "roost-handoff-error-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
        const result = await client.callTool({ name: "activate_roost_session", arguments: {}, _meta: tunnelMeta });
        assert.equal(result.isError, true);
        const body = JSON.parse(result.content.find(({ type }) => type === "text").text);
        assert.equal(body.error.code, "SSO_BINDING_INVALID");
        assert.match(body.error.message, /request_context_access/);
        assert.match(body.error.message, /within two minutes/);
    } finally {
        await client.close();
        await server.close();
    }
});

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
        async activate(identity) {
            calls.push({ operation: "activate", identity });
            return authenticated;
        },
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
            name: "activate_roost_session",
            arguments: {},
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
        assert.deepEqual(calls.map(({ operation }) => operation), ["activate", "authorize"]);
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
