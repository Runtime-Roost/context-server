import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

process.env.PGDATABASE ??= "personal_context";
process.env.EMBEDDINGS_ENABLED = "false";

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const {
    approveActorSessionRequest,
    revokeActorSession,
} = await import("../dist/auth/actor-sessions.js");
const { createServer } = await import("../dist/mcp/server.js");
const { db } = await import("../dist/storage/db.js");
const { getContext, identifyActor } = await import("../dist/mcp/tools.js");

function uniqueValue(prefix) {
    return `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function textResult(result) {
    const item = result.content.find((content) => content.type === "text");
    assert.ok(item);
    return JSON.parse(item.text);
}

function sessionAuth(session, overrides = {}) {
    return {
        session_id: session.session_id,
        session_token: overrides.session_token ?? session.session_token,
        timestamp: overrides.timestamp ?? new Date().toISOString(),
        nonce: overrides.nonce ?? randomUUID(),
    };
}

function openAITunnelMeta(subject, session) {
    return {
        "openai/subject": `v1/${subject}`,
        "openai/session": `v1/${session}`,
    };
}

async function connectTestClient() {
    const server = createServer();
    const client = new Client({ name: "actor-session-bootstrap-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
    ]);

    return {
        client,
        server,
        async close() {
            await client.close();
            await server.close();
        },
    };
}

async function requestAndApprove(client, actorExternalId, label) {
    const requested = textResult(await client.callTool({
        name: "request_actor_session",
        arguments: {
            actor_external_id: actorExternalId,
            client_label: label,
        },
    })).request;
    await approveActorSessionRequest(requested.request_id, actorExternalId, 3600);
    const claimed = textResult(await client.callTool({
        name: "claim_actor_session",
        arguments: {
            request_id: requested.request_id,
            claim_code: requested.claim_code,
        },
    })).session;
    return { requested, claimed };
}

test("operator-approved actor sessions bootstrap remote private-channel clients safely", async () => {
    const ownerExternalId = uniqueValue("actor:test:session-owner");
    const memberExternalId = uniqueValue("actor:test:session-member");
    const owner = await identifyActor({ external_id: ownerExternalId, name: "Session Owner", kind: "ai" });
    const member = await identifyActor({ external_id: memberExternalId, name: "Session Member", kind: "ai" });
    const slug = uniqueValue("session-channel").toLowerCase().replaceAll(":", "-");
    const marker = uniqueValue("session-private-message");
    const connection = await connectTestClient();
    const requestIds = [];
    const sessionIds = [];
    let channelId;
    let contextId;

    try {
        const pending = textResult(await connection.client.callTool({
            name: "request_actor_session",
            arguments: {
                actor_external_id: ownerExternalId,
                client_label: "remote-owner-test",
            },
        })).request;
        requestIds.push(pending.request_id);
        assert.equal(pending.status, "pending");
        assert.ok(pending.claim_code.length >= 32);

        const wrongStatus = await connection.client.callTool({
            name: "get_actor_session_request_status",
            arguments: {
                request_id: pending.request_id,
                claim_code: `${pending.claim_code.slice(0, -1)}x`,
            },
        });
        assert.equal(wrongStatus.isError, true);
        assert.equal(textResult(wrongStatus).error.code, "ACTOR_SESSION_REQUEST_NOT_FOUND");

        const prematureClaim = await connection.client.callTool({
            name: "claim_actor_session",
            arguments: {
                request_id: pending.request_id,
                claim_code: pending.claim_code,
            },
        });
        assert.equal(prematureClaim.isError, true);

        await assert.rejects(
            approveActorSessionRequest(pending.request_id, memberExternalId, 3600),
        );
        await approveActorSessionRequest(pending.request_id, ownerExternalId, 3600);
        const approvedStatus = textResult(await connection.client.callTool({
            name: "get_actor_session_request_status",
            arguments: {
                request_id: pending.request_id,
                claim_code: pending.claim_code,
            },
        })).request;
        assert.equal(approvedStatus.status, "approved");

        const ownerSession = textResult(await connection.client.callTool({
            name: "claim_actor_session",
            arguments: {
                request_id: pending.request_id,
                claim_code: pending.claim_code,
            },
        })).session;
        sessionIds.push(ownerSession.session_id);
        assert.equal(ownerSession.actor_external_id, ownerExternalId);

        const secondClaim = await connection.client.callTool({
            name: "claim_actor_session",
            arguments: {
                request_id: pending.request_id,
                claim_code: pending.claim_code,
            },
        });
        assert.equal(secondClaim.isError, true);

        const createPayload = { slug, name: "Remote Session Channel" };
        const replayNonce = randomUUID();
        const createAuth = sessionAuth(ownerSession, { nonce: replayNonce });
        const created = textResult(await connection.client.callTool({
            name: "create_channel",
            arguments: { ...createPayload, auth: createAuth },
        }));
        channelId = created.channel.id;

        const replayed = await connection.client.callTool({
            name: "create_channel",
            arguments: { ...createPayload, auth: createAuth },
        });
        assert.equal(replayed.isError, true);
        assert.equal(textResult(replayed).error.code, "AUTHENTICATION_FAILED");

        const memberBootstrap = await requestAndApprove(
            connection.client,
            memberExternalId,
            "remote-member-test",
        );
        requestIds.push(memberBootstrap.requested.request_id);
        sessionIds.push(memberBootstrap.claimed.session_id);

        const added = textResult(await connection.client.callTool({
            name: "add_channel_member",
            arguments: {
                channel: slug,
                actor_external_id: memberExternalId,
                auth: sessionAuth(ownerSession),
            },
        }));
        assert.equal(added.membership.actor_external_id, memberExternalId);

        const saved = textResult(await connection.client.callTool({
            name: "save_channel_context",
            arguments: {
                channel: slug,
                text: marker,
                auth: sessionAuth(memberBootstrap.claimed),
            },
        }));
        contextId = saved.saved.id;
        assert.equal(saved.saved.actor.external_id, memberExternalId);
        assert.equal(saved.saved.visibility, "channel");
        assert.equal(await getContext(contextId), null);

        const memberRead = textResult(await connection.client.callTool({
            name: "get_channel_context",
            arguments: {
                id: contextId,
                auth: sessionAuth(memberBootstrap.claimed),
            },
        }));
        assert.equal(memberRead.context.id, contextId);

        await revokeActorSession(memberBootstrap.claimed.session_id);
        const revokedRead = await connection.client.callTool({
            name: "get_channel_context",
            arguments: {
                id: contextId,
                auth: sessionAuth(memberBootstrap.claimed),
            },
        });
        assert.equal(revokedRead.isError, true);
        assert.equal(textResult(revokedRead).error.code, "SESSION_REVOKED");

        await db.query(
            "UPDATE actor_sessions SET expires_at = NOW() - INTERVAL '1 second' WHERE session_id = $1",
            [ownerSession.session_id],
        );
        const expiredOwner = await connection.client.callTool({
            name: "list_channels",
            arguments: { auth: sessionAuth(ownerSession) },
        });
        assert.equal(expiredOwner.isError, true);
        assert.equal(textResult(expiredOwner).error.code, "AUTHENTICATION_FAILED");
    } finally {
        if (contextId) {
            await db.query("DELETE FROM contexts WHERE id = $1", [contextId]);
        }
        if (channelId) {
            await db.query("DELETE FROM channels WHERE id = $1", [channelId]);
        }
        await db.query(
            "DELETE FROM actor_session_requests WHERE request_id = ANY($1::text[])",
            [requestIds],
        );
        await db.query(
            "DELETE FROM actor_sessions WHERE session_id = ANY($1::text[])",
            [sessionIds],
        );
        await db.query(
            "DELETE FROM actors WHERE id = ANY($1::bigint[])",
            [[owner.actor.id, member.actor.id]],
        );
        await connection.close();
    }
});

test("claiming a replacement atomically hands off the actor timeline", async () => {
    const actorExternalId = uniqueValue("actor:test:session-handoff");
    const actor = await identifyActor({
        external_id: actorExternalId,
        name: "Session Handoff Actor",
        kind: "ai",
    });
    const connection = await connectTestClient();
    const requestIds = [];
    const sessionIds = [];

    try {
        const initial = await requestAndApprove(
            connection.client,
            actorExternalId,
            "initial-thread",
        );
        requestIds.push(initial.requested.request_id);
        sessionIds.push(initial.claimed.session_id);

        const replacementRequest = textResult(await connection.client.callTool({
            name: "request_actor_session",
            arguments: {
                actor_external_id: actorExternalId,
                client_label: "replacement-thread",
            },
        })).request;
        requestIds.push(replacementRequest.request_id);

        // Merely requesting or approving a replacement must not lock out the
        // actor's current conversation.
        await connection.client.callTool({
            name: "list_channels",
            arguments: { auth: sessionAuth(initial.claimed) },
        });
        await approveActorSessionRequest(
            replacementRequest.request_id,
            actorExternalId,
            3600,
        );
        await connection.client.callTool({
            name: "list_channels",
            arguments: { auth: sessionAuth(initial.claimed) },
        });

        const replacement = textResult(await connection.client.callTool({
            name: "claim_actor_session",
            arguments: {
                request_id: replacementRequest.request_id,
                claim_code: replacementRequest.claim_code,
            },
        })).session;
        sessionIds.push(replacement.session_id);
        assert.equal(
            replacement.predecessor_session_id,
            initial.claimed.session_id,
        );

        const oldTimeline = await connection.client.callTool({
            name: "list_channels",
            arguments: { auth: sessionAuth(initial.claimed) },
        });
        assert.equal(oldTimeline.isError, true);
        assert.equal(textResult(oldTimeline).error.code, "SESSION_REVOKED");

        const newTimeline = await connection.client.callTool({
            name: "list_channels",
            arguments: { auth: sessionAuth(replacement) },
        });
        assert.notEqual(newTimeline.isError, true);

        const stored = await db.query(
            `
                SELECT
                    session_id,
                    revoked_at,
                    revocation_reason,
                    predecessor_session_id,
                    replaced_by_session_id
                FROM actor_sessions
                WHERE session_id = ANY($1::text[])
                ORDER BY created_at
            `,
            [sessionIds],
        );
        const oldRow = stored.rows.find((row) => row.session_id === initial.claimed.session_id);
        const newRow = stored.rows.find((row) => row.session_id === replacement.session_id);
        assert.ok(oldRow.revoked_at);
        assert.equal(oldRow.revocation_reason, "replaced_by_new_claim");
        assert.equal(oldRow.replaced_by_session_id, replacement.session_id);
        assert.equal(newRow.revoked_at, null);
        assert.equal(newRow.predecessor_session_id, initial.claimed.session_id);
    } finally {
        await db.query(
            "DELETE FROM actor_session_requests WHERE request_id = ANY($1::text[])",
            [requestIds],
        );
        await db.query(
            "DELETE FROM actor_sessions WHERE session_id = ANY($1::text[])",
            [sessionIds],
        );
        await db.query("DELETE FROM actors WHERE id = $1", [actor.actor.id]);
        await connection.close();
    }
});

test("simultaneous claims cannot leave two writable timelines", async () => {
    const actorExternalId = uniqueValue("actor:test:session-race");
    const actor = await identifyActor({
        external_id: actorExternalId,
        name: "Session Race Actor",
        kind: "ai",
    });
    const connection = await connectTestClient();
    const requestIds = [];
    const sessionIds = [];

    try {
        const requests = [];
        for (const label of ["race-a", "race-b"]) {
            const requested = textResult(await connection.client.callTool({
                name: "request_actor_session",
                arguments: { actor_external_id: actorExternalId, client_label: label },
            })).request;
            await approveActorSessionRequest(requested.request_id, actorExternalId, 3600);
            requestIds.push(requested.request_id);
            requests.push(requested);
        }

        const results = await Promise.all(requests.map(async (request) => textResult(
            await connection.client.callTool({
                name: "claim_actor_session",
                arguments: {
                    request_id: request.request_id,
                    claim_code: request.claim_code,
                },
            }),
        ).session));
        sessionIds.push(...results.map((session) => session.session_id));

        const active = await db.query(
            `
                SELECT session_id
                FROM actor_sessions
                WHERE actor_id = $1
                  AND revoked_at IS NULL
            `,
            [actor.actor.id],
        );
        assert.equal(active.rowCount, 1);

        const authResults = await Promise.all(results.map((session) =>
            connection.client.callTool({
                name: "list_channels",
                arguments: { auth: sessionAuth(session) },
            }),
        ));
        assert.equal(authResults.filter((result) => result.isError !== true).length, 1);
        const revoked = authResults.find((result) => result.isError === true);
        assert.equal(textResult(revoked).error.code, "SESSION_REVOKED");
    } finally {
        await db.query(
            "DELETE FROM actor_session_requests WHERE request_id = ANY($1::text[])",
            [requestIds],
        );
        await db.query(
            "DELETE FROM actor_sessions WHERE actor_id = $1",
            [actor.actor.id],
        );
        await db.query("DELETE FROM actors WHERE id = $1", [actor.actor.id]);
        await connection.close();
    }
});

test("local approval binds the exact requesting OpenAI conversation", async () => {
    const previousTrust = process.env.TRUST_OPENAI_TUNNEL_IDENTITY;
    process.env.TRUST_OPENAI_TUNNEL_IDENTITY = "true";
    const actorExternalId = uniqueValue("actor:test:openai-binding");
    const actor = await identifyActor({
        external_id: actorExternalId,
        name: "OpenAI Bound Actor",
        kind: "ai",
    });
    const connection = await connectTestClient();
    const requestIds = [];
    const sessionIds = [];
    const firstMeta = openAITunnelMeta("same-account", "first-conversation");
    const secondMeta = openAITunnelMeta("same-account", "second-conversation");

    try {
        const requested = textResult(await connection.client.callTool({
            name: "request_actor_session",
            arguments: {
                actor_external_id: actorExternalId,
                client_label: "openai-first-thread",
            },
            _meta: firstMeta,
        })).request;
        requestIds.push(requested.request_id);
        assert.equal(requested.claim_code, undefined);
        const approved = await approveActorSessionRequest(
            requested.request_id,
            actorExternalId,
            3600,
        );
        assert.equal(approved.status, "claimed");
        const activated = approved.activated_session;
        sessionIds.push(activated.session_id);
        assert.equal(activated.authentication, "openai_session_binding");
        assert.equal(activated.actor_external_id, actorExternalId);

        const automatic = await connection.client.callTool({
            name: "list_channels",
            arguments: {},
            _meta: firstMeta,
        });
        assert.notEqual(automatic.isError, true);

        const otherConversation = await connection.client.callTool({
            name: "list_channels",
            arguments: {},
            _meta: secondMeta,
        });
        assert.equal(otherConversation.isError, true);
        assert.equal(textResult(otherConversation).error.code, "AUTHENTICATION_REQUIRED");

        const otherSubject = await connection.client.callTool({
            name: "list_channels",
            arguments: {},
            _meta: openAITunnelMeta("different-account", "first-conversation"),
        });
        assert.equal(otherSubject.isError, true);
        assert.equal(textResult(otherSubject).error.code, "AUTHENTICATION_REQUIRED");

        const replacementRequest = textResult(await connection.client.callTool({
            name: "request_actor_session",
            arguments: {
                actor_external_id: actorExternalId,
                client_label: "openai-second-thread",
            },
            _meta: secondMeta,
        })).request;
        requestIds.push(replacementRequest.request_id);
        const replacementApproval = await approveActorSessionRequest(
            replacementRequest.request_id,
            actorExternalId,
            3600,
        );
        const replacement = replacementApproval.activated_session;
        sessionIds.push(replacement.session_id);
        assert.equal(replacement.predecessor_session_id, activated.session_id);

        const superseded = await connection.client.callTool({
            name: "list_channels",
            arguments: {},
            _meta: firstMeta,
        });
        assert.equal(superseded.isError, true);
        assert.equal(textResult(superseded).error.code, "SESSION_REVOKED");

        const current = await connection.client.callTool({
            name: "list_channels",
            arguments: {},
            _meta: secondMeta,
        });
        assert.notEqual(current.isError, true);
    } finally {
        await db.query(
            "DELETE FROM actor_session_requests WHERE request_id = ANY($1::text[])",
            [requestIds],
        );
        await db.query(
            "DELETE FROM actor_sessions WHERE actor_id = $1",
            [actor.actor.id],
        );
        await db.query("DELETE FROM actors WHERE id = $1", [actor.actor.id]);
        await connection.close();
        if (previousTrust === undefined) {
            delete process.env.TRUST_OPENAI_TUNNEL_IDENTITY;
        } else {
            process.env.TRUST_OPENAI_TUNNEL_IDENTITY = previousTrust;
        }
    }
});

test.after(async () => {
    await db.end();
});
