import assert from "node:assert/strict";
import test from "node:test";

process.env.PGDATABASE ??= "personal_context";
process.env.EMBEDDINGS_ENABLED = "false";
process.env.REQUIRE_CONTEXT_AUTHENTICATION = "true";
process.env.TRUST_OPENAI_TUNNEL_IDENTITY = "true";

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { createServer } = await import("../dist/mcp/server.js");
const { enforceRoostToolCapability } = await import("../dist/auth/roost-sso-authority.js");
const { db } = await import("../dist/storage/db.js");
const { identifyActor } = await import("../dist/mcp/tools.js");

const chatgptIdentity = {
    subject: "v1/direct-message-chatgpt-subject",
    session: "v1/direct-message-chatgpt-session",
};
const readerIdentity = {
    subject: "v1/direct-message-reader-subject",
    session: "v1/direct-message-reader-session",
};
const differentConversation = {
    subject: chatgptIdentity.subject,
    session: "v1/direct-message-chatgpt-other-session",
};

function identityKey(identity) {
    return `${identity.subject}\0${identity.session}`;
}

function errorBody(result) {
    return JSON.parse(result.content.find(({ type }) => type === "text").text);
}

function rememberUnexpectedSend(result, contextIds) {
    if (result.isError === true) return;
    const body = errorBody(result);
    const contextId = body.sent?.context?.id;
    if (contextId !== undefined) contextIds.push(contextId);
}

test("ChatGPT can send a private message to registered Codex; a Whiteboard reader and wrong conversation cannot", async () => {
    const sender = await identifyActor({
        external_id: "actor:openai:chatgpt",
        name: "ChatGPT",
        kind: "ai",
    });
    const recipient = await identifyActor({
        external_id: "actor:openai:codex",
        name: "Codex",
        kind: "ai",
    });
    const reader = await identifyActor({
        external_id: `actor:test:whiteboard-reader-${process.pid}-${Date.now()}`,
        name: "Whiteboard reader test actor",
        kind: "ai",
    });
    const grants = new Map([
        [identityKey(chatgptIdentity), {
            actor: sender.actor,
            capabilities: ["messaging.direct.send:actor:openai:codex"],
        }],
        [identityKey(readerIdentity), { actor: reader.actor, capabilities: ["context.whiteboard.read"] }],
    ]);
    const authorizationCalls = [];
    const authority = {
        async authorize(identity, tool, payload) {
            authorizationCalls.push({ identity, tool, payload });
            const grant = grants.get(identityKey(identity));
            if (!grant) throw new Error("AUTHENTICATION_REQUIRED");
            enforceRoostToolCapability(grant.capabilities, tool, payload);
            return {
                actor_id: grant.actor.id,
                actor_external_id: grant.actor.external_id,
                actor_name: grant.actor.name,
                key_id: "roost-sso-authority-test",
            };
        },
    };
    const server = createServer({ surface: "conversation", authority });
    const client = new Client({ name: "roost-direct-authorization-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const contextIds = [];
    const additionalRecipientIds = [];

    try {
        const sent = await client.callTool({
            name: "send_direct_context",
            arguments: {
                recipient_external_id: recipient.actor.external_id,
                text: "authorized ChatGPT-to-Codex regression check",
                source: "roost direct authorization test",
            },
            _meta: {
                "openai/subject": chatgptIdentity.subject,
                "openai/session": chatgptIdentity.session,
            },
        });
        assert.notEqual(sent.isError, true);
        const sentBody = JSON.parse(sent.content.find(({ type }) => type === "text").text);
        assert.equal(sentBody.sent.context.visibility, "direct");
        assert.equal(sentBody.sent.context.actor.external_id, "actor:openai:chatgpt");
        contextIds.push(sentBody.sent.context.id);

        const deniedReader = await client.callTool({
            name: "send_direct_context",
            arguments: {
                recipient_external_id: recipient.actor.external_id,
                text: "must be denied for a Whiteboard-only actor",
            },
            _meta: {
                "openai/subject": readerIdentity.subject,
                "openai/session": readerIdentity.session,
            },
        });
        rememberUnexpectedSend(deniedReader, contextIds);
        assert.equal(deniedReader.isError, true);
        assert.equal(errorBody(deniedReader).error.code, "CAPABILITY_REQUIRED");

        const unauthorizedRecipient = await identifyActor({
            external_id: `actor:test:unapproved-recipient-${process.pid}-${Date.now()}`,
            name: "Registered but unauthorized recipient",
            kind: "ai",
        });
        additionalRecipientIds.push(unauthorizedRecipient.actor.external_id);
        const deniedRecipient = await client.callTool({
            name: "send_direct_context",
            arguments: {
                recipient_external_id: unauthorizedRecipient.actor.external_id,
                text: "must be denied outside the explicit Codex recipient scope",
            },
            _meta: {
                "openai/subject": chatgptIdentity.subject,
                "openai/session": chatgptIdentity.session,
            },
        });
        rememberUnexpectedSend(deniedRecipient, contextIds);
        assert.equal(deniedRecipient.isError, true);
        assert.equal(errorBody(deniedRecipient).error.code, "CAPABILITY_REQUIRED");

        const deniedUnregisteredRecipient = await client.callTool({
            name: "send_direct_context",
            arguments: {
                recipient_external_id: "actor:openai:unregistered-target",
                text: "must be denied for an unregistered and unauthorized recipient",
            },
            _meta: {
                "openai/subject": chatgptIdentity.subject,
                "openai/session": chatgptIdentity.session,
            },
        });
        rememberUnexpectedSend(deniedUnregisteredRecipient, contextIds);
        assert.equal(deniedUnregisteredRecipient.isError, true);
        assert.equal(errorBody(deniedUnregisteredRecipient).error.code, "CAPABILITY_REQUIRED");

        const deniedOtherConversation = await client.callTool({
            name: "send_direct_context",
            arguments: {
                recipient_external_id: recipient.actor.external_id,
                text: "must not reuse another conversation binding",
            },
            _meta: {
                "openai/subject": differentConversation.subject,
                "openai/session": differentConversation.session,
            },
        });
        rememberUnexpectedSend(deniedOtherConversation, contextIds);
        assert.equal(deniedOtherConversation.isError, true);
        assert.equal(errorBody(deniedOtherConversation).error.code, "AUTHENTICATION_REQUIRED");

        assert.deepEqual(authorizationCalls.map(({ tool }) => tool), [
            "send_direct_context",
            "send_direct_context",
            "send_direct_context",
            "send_direct_context",
            "send_direct_context",
        ]);
        assert.equal(authorizationCalls[0].payload.recipient_external_id, "actor:openai:codex");
    } finally {
        if (contextIds.length > 0) {
            await db.query("DELETE FROM contexts WHERE id = ANY($1::bigint[])", [contextIds]);
        }
        await db.query(
            "DELETE FROM actors WHERE external_id = ANY($1::text[])",
            [["actor:openai:chatgpt", "actor:openai:codex", reader.actor.external_id, ...additionalRecipientIds]],
        );
        await client.close();
        await server.close();
    }
});

test.after(async () => {
    await db.end();
});
