import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

process.env.PGDATABASE ??= "personal_context";
process.env.EMBEDDINGS_ENABLED = "false";

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const {
    approveActorSessionRequest,
    recordExternalActorSessionLifecycleEvent,
    requestActorSession,
    revokeActorSession,
} = await import("../dist/auth/actor-sessions.js");
const {
    decideActorSessionRequest,
    listPendingActorSessionRequests,
} = await import("../dist/auth/operator-actor-sessions.js");
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

async function requestAndApprove(client, actorExternalId, label, ttlSeconds = 3600) {
    const requested = textResult(await client.callTool({
        name: "request_actor_session",
        arguments: {
            actor_external_id: actorExternalId,
            client_label: label,
        },
    })).request;
    await approveActorSessionRequest(requested.request_id, actorExternalId, ttlSeconds);
    const claimed = textResult(await client.callTool({
        name: "claim_actor_session",
        arguments: {
            request_id: requested.request_id,
            claim_code: requested.claim_code,
        },
    })).session;
    return { requested, claimed };
}

test("actor-session requests distinguish unknown canonical actors from local capacity", async () => {
    const connection = await connectTestClient();
    const unknownActor = uniqueValue("Blake");
    const actorExternalId = uniqueValue("actor:test:request-capacity");
    const actor = await identifyActor({ external_id: actorExternalId, name: "Request Capacity", kind: "ai" });
    const requestIds = [];
    try {
        const unknown = await connection.client.callTool({
            name: "request_actor_session",
            arguments: { actor_external_id: unknownActor, client_label: "wrong identity" },
        });
        assert.equal(unknown.isError, true);
        assert.deepEqual(textResult(unknown).error, {
            code: "ACTOR_NOT_FOUND",
            actor_external_id: unknownActor,
            message: "No durable actor matches the supplied actor_external_id. Use the exact canonical actor identity assigned by the operator; a display name or human name is not an actor identity.",
        });

        for (let index = 0; index < 3; index += 1) {
            const result = textResult(await connection.client.callTool({
                name: "request_actor_session",
                arguments: { actor_external_id: actorExternalId, client_label: `pending ${index + 1}` },
            }));
            requestIds.push(result.request.request_id);
        }
        const atCapacity = await connection.client.callTool({
            name: "request_actor_session",
            arguments: { actor_external_id: actorExternalId, client_label: "one too many" },
        });
        assert.equal(atCapacity.isError, true);
        assert.equal(textResult(atCapacity).error.code, "ACTOR_SESSION_PENDING_LIMIT_REACHED");
        assert.match(textResult(atCapacity).error.message, /maximum number of unexpired pending or approved/);
    } finally {
        if (requestIds.length > 0) {
            await db.query("DELETE FROM actor_session_requests WHERE request_id = ANY($1::text[])", [requestIds]);
        }
        await db.query("DELETE FROM actors WHERE id = $1", [actor.actor.id]);
        await connection.close();
    }
});

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
            `UPDATE actor_sessions SET expires_at = NOW() - INTERVAL '1 second',
                lease_expires_at = NOW() - INTERVAL '1 second' WHERE session_id = $1`,
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
        assert.equal(
            requested.next_action,
            "Ask the local operator to approve this request_id. Approval activates this exact OpenAI conversation; no second authentication call is needed.",
        );
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
        assert.match(
            textResult(otherConversation).error.message,
            /approve that exact request in Agent Companion/,
        );
        assert.match(textResult(otherConversation).error.message, /Do not use a PIN/);

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

test("trusted OpenAI use renews only the exact current thread inside the renewal window", async () => {
    const previousTrust = process.env.TRUST_OPENAI_TUNNEL_IDENTITY;
    process.env.TRUST_OPENAI_TUNNEL_IDENTITY = "true";
    const actorExternalId = uniqueValue("actor:test:openai-renewal");
    const actor = await identifyActor({ external_id: actorExternalId, name: "OpenAI Renewal", kind: "ai" });
    const connection = await connectTestClient();
    const meta = openAITunnelMeta("renewal-account", uniqueValue("renewal-thread"));
    let requestId;
    let sessionId;
    try {
        const requested = textResult(await connection.client.callTool({
            name: "request_actor_session",
            arguments: { actor_external_id: actorExternalId, client_label: "renewal-thread" },
            _meta: meta,
        })).request;
        requestId = requested.request_id;
        const approved = await approveActorSessionRequest(requestId, actorExternalId, 2_592_000);
        sessionId = approved.activated_session.session_id;
        await db.query(`UPDATE actor_sessions SET expires_at = NOW() + INTERVAL '1 day',
            lease_expires_at = NOW() + INTERVAL '1 day' WHERE session_id = $1`, [sessionId]);

        const authenticated = await connection.client.callTool({ name: "list_channels", arguments: {}, _meta: meta });
        assert.notEqual(authenticated.isError, true);
        const stored = await db.query(`SELECT lease_expires_at, last_renewed_at, renewal_count,
            credential_generation, lifecycle_kind FROM actor_sessions WHERE session_id = $1`, [sessionId]);
        assert.equal(stored.rows[0].lifecycle_kind, "trusted_openai_thread");
        assert.equal(stored.rows[0].renewal_count, 1);
        assert.equal(stored.rows[0].credential_generation, 1);
        assert.ok(stored.rows[0].last_renewed_at);
        const remainingDays = (new Date(stored.rows[0].lease_expires_at).getTime() - Date.now()) / 86_400_000;
        assert.ok(remainingDays > 29 && remainingDays <= 30.01);
    } finally {
        if (requestId) await db.query("DELETE FROM actor_session_requests WHERE request_id = $1", [requestId]);
        if (sessionId) await db.query("DELETE FROM actor_sessions WHERE session_id = $1", [sessionId]);
        await db.query("DELETE FROM actors WHERE id = $1", [actor.actor.id]);
        await connection.close();
        if (previousTrust === undefined) delete process.env.TRUST_OPENAI_TUNNEL_IDENTITY;
        else process.env.TRUST_OPENAI_TUNNEL_IDENTITY = previousTrust;
    }
});

test("one approved Roost SSO grant binds exactly one Context Server conversation", async () => {
    const previousTrust = process.env.TRUST_OPENAI_TUNNEL_IDENTITY;
    process.env.TRUST_OPENAI_TUNNEL_IDENTITY = "true";
    const actorExternalId = uniqueValue("actor:test:roost-sso-binding");
    const actor = await identifyActor({ external_id: actorExternalId, name: "Roost SSO Actor", kind: "ai" });
    const connection = await connectTestClient();
    const ssoMeta = openAITunnelMeta("shared-sso-subject", uniqueValue("roost-session"));
    const contextMeta = openAITunnelMeta("shared-sso-subject", uniqueValue("context-session"));
    const competingMeta = openAITunnelMeta("shared-sso-subject", uniqueValue("competing-context-session"));
    let requestId;
    let sessionId;
    try {
        const requested = textResult(await connection.client.callTool({
            name: "request_actor_session",
            arguments: { actor_external_id: actorExternalId, client_label: "roost-sso" },
            _meta: ssoMeta,
        })).request;
        requestId = requested.request_id;
        await db.query(`UPDATE actor_session_requests SET federation_issuer = 'roost-sso',
            federation_audience = 'context-server' WHERE request_id = $1`, [requestId]);
        const approved = await approveActorSessionRequest(requestId, actorExternalId, 3600);
        sessionId = approved.activated_session.session_id;

        const handoff = await db.query(`SELECT binding_id
            FROM actor_session_service_bindings WHERE source_session_id = $1`, [sessionId]);
        assert.equal(handoff.rowCount, 1);
        const bound = await connection.client.callTool({
            name: "request_actor_session",
            arguments: {
                actor_external_id: actorExternalId,
                client_label: `roost-sso:${handoff.rows[0].binding_id}`,
            },
            _meta: contextMeta,
        });
        assert.notEqual(bound.isError, true);
        assert.equal(textResult(bound).request.authentication, "roost_sso_service_binding");

        const firstContextUse = await connection.client.callTool({
            name: "list_channels", arguments: {}, _meta: contextMeta,
        });
        assert.notEqual(firstContextUse.isError, true);
        const repeatContextUse = await connection.client.callTool({
            name: "list_channels", arguments: {}, _meta: contextMeta,
        });
        assert.notEqual(repeatContextUse.isError, true);

        const competingContext = await connection.client.callTool({
            name: "list_channels", arguments: {}, _meta: competingMeta,
        });
        assert.equal(competingContext.isError, true);
        assert.equal(textResult(competingContext).error.code, "AUTHENTICATION_REQUIRED");
        const differentSubject = await connection.client.callTool({
            name: "list_channels", arguments: {},
            _meta: openAITunnelMeta("different-sso-subject", "context-session"),
        });
        assert.equal(differentSubject.isError, true);

        const binding = await db.query(`SELECT bound_at, service_subject_hash, service_session_hash
            FROM actor_session_service_bindings WHERE source_session_id = $1`, [sessionId]);
        assert.equal(binding.rowCount, 1);
        assert.ok(binding.rows[0].bound_at);
        assert.ok(binding.rows[0].service_subject_hash);
        assert.ok(binding.rows[0].service_session_hash);
    } finally {
        if (requestId) await db.query("DELETE FROM actor_session_requests WHERE request_id = $1", [requestId]);
        if (sessionId) await db.query("DELETE FROM actor_sessions WHERE session_id = $1", [sessionId]);
        await db.query("DELETE FROM actors WHERE id = $1", [actor.actor.id]);
        await connection.close();
        if (previousTrust === undefined) delete process.env.TRUST_OPENAI_TUNNEL_IDENTITY;
        else process.env.TRUST_OPENAI_TUNNEL_IDENTITY = previousTrust;
    }
});

test("native renewal preserves session identity and immediately rotates its token", async () => {
    const actorExternalId = uniqueValue("actor:test:native-renewal");
    const actor = await identifyActor({ external_id: actorExternalId, name: "Native Renewal", kind: "ai" });
    const connection = await connectTestClient();
    let requestId;
    let sessionId;
    try {
        const initial = await requestAndApprove(connection.client, actorExternalId, "native-renewal", 2_592_000);
        requestId = initial.requested.request_id;
        sessionId = initial.claimed.session_id;
        const renewed = textResult(await connection.client.callTool({
            name: "renew_actor_session",
            arguments: { auth: sessionAuth(initial.claimed) },
        })).session;
        assert.equal(renewed.session_id, sessionId);
        assert.notEqual(renewed.session_token, initial.claimed.session_token);
        assert.equal(renewed.credential_generation, 2);
        assert.equal(renewed.renewal_count, 1);

        const oldToken = await connection.client.callTool({
            name: "list_channels", arguments: { auth: sessionAuth(initial.claimed) },
        });
        assert.equal(oldToken.isError, true);
        assert.equal(textResult(oldToken).error.code, "AUTHENTICATION_FAILED");
        const currentToken = await connection.client.callTool({
            name: "list_channels", arguments: { auth: sessionAuth(renewed) },
        });
        assert.notEqual(currentToken.isError, true);
    } finally {
        if (requestId) await db.query("DELETE FROM actor_session_requests WHERE request_id = $1", [requestId]);
        if (sessionId) await db.query("DELETE FROM actor_sessions WHERE session_id = $1", [sessionId]);
        await db.query("DELETE FROM actors WHERE id = $1", [actor.actor.id]);
        await connection.close();
    }
});

test("short fixed actor sessions cannot widen themselves into renewable leases", async () => {
    const actorExternalId = uniqueValue("actor:test:fixed-session");
    const actor = await identifyActor({ external_id: actorExternalId, name: "Fixed Session", kind: "ai" });
    const connection = await connectTestClient();
    let requestId;
    let sessionId;
    try {
        const fixed = await requestAndApprove(connection.client, actorExternalId, "fixed-session", 3600);
        requestId = fixed.requested.request_id;
        sessionId = fixed.claimed.session_id;
        const attempted = await connection.client.callTool({
            name: "renew_actor_session", arguments: { auth: sessionAuth(fixed.claimed) },
        });
        assert.equal(attempted.isError, true);
        assert.equal(textResult(attempted).error.code, "SESSION_RENEWAL_NOT_ALLOWED");
        const stored = await db.query("SELECT renewal_enabled, renewal_count FROM actor_sessions WHERE session_id = $1", [sessionId]);
        assert.equal(stored.rows[0].renewal_enabled, false);
        assert.equal(stored.rows[0].renewal_count, 0);
    } finally {
        if (requestId) await db.query("DELETE FROM actor_session_requests WHERE request_id = $1", [requestId]);
        if (sessionId) await db.query("DELETE FROM actor_sessions WHERE session_id = $1", [sessionId]);
        await db.query("DELETE FROM actors WHERE id = $1", [actor.actor.id]);
        await connection.close();
    }
});

test("verified external deletion revokes only the exact bound OpenAI thread idempotently", async () => {
    const previousTrust = process.env.TRUST_OPENAI_TUNNEL_IDENTITY;
    process.env.TRUST_OPENAI_TUNNEL_IDENTITY = "true";
    const actorExternalId = uniqueValue("actor:test:external-deletion");
    const actor = await identifyActor({ external_id: actorExternalId, name: "External Deletion", kind: "ai" });
    const connection = await connectTestClient();
    const firstMeta = openAITunnelMeta("deletion-account", uniqueValue("deleted-thread"));
    const secondMeta = openAITunnelMeta("deletion-account", uniqueValue("current-thread"));
    const requestIds = [];
    try {
        let activeSession;
        for (const [meta, label] of [[firstMeta, "deleted-thread"], [secondMeta, "current-thread"]]) {
            const requested = textResult(await connection.client.callTool({
                name: "request_actor_session", arguments: { actor_external_id: actorExternalId, client_label: label }, _meta: meta,
            })).request;
            requestIds.push(requested.request_id);
            activeSession = (await approveActorSessionRequest(requested.request_id, actorExternalId, 2_592_000)).activated_session;
        }
        const event = { event_id: uniqueValue("openai-event"), event: "thread_deleted", occurred_at: new Date().toISOString() };
        const first = await recordExternalActorSessionLifecycleEvent({ subject: firstMeta["openai/subject"], session: firstMeta["openai/session"] }, event);
        const replay = await recordExternalActorSessionLifecycleEvent({ subject: firstMeta["openai/subject"], session: firstMeta["openai/session"] }, event);
        assert.deepEqual(replay, first);
        const current = await connection.client.callTool({ name: "list_channels", arguments: {}, _meta: secondMeta });
        assert.notEqual(current.isError, true);
        const active = await db.query("SELECT revoked_at FROM actor_sessions WHERE session_id = $1", [activeSession.session_id]);
        assert.equal(active.rows[0].revoked_at, null);
    } finally {
        await db.query("DELETE FROM actor_session_requests WHERE request_id = ANY($1::text[])", [requestIds]);
        await db.query("DELETE FROM actor_sessions WHERE actor_id = $1", [actor.actor.id]);
        await db.query("DELETE FROM actors WHERE id = $1", [actor.actor.id]);
        await connection.close();
        if (previousTrust === undefined) delete process.env.TRUST_OPENAI_TUNNEL_IDENTITY;
        else process.env.TRUST_OPENAI_TUNNEL_IDENTITY = previousTrust;
    }
});

test("operator adapter lists sanitized requests and binds decisions to reviewed metadata", async () => {
    const actorExternalId = uniqueValue("actor:test:operator-review");
    const actor = await identifyActor({ external_id: actorExternalId, name: "Operator Review", kind: "ai" });
    const requested = await requestActorSession(actorExternalId, "Phone-bound request");
    try {
        const listed = await listPendingActorSessionRequests();
        const pending = listed.find(({ request_id }) => request_id === requested.request_id);
        assert.deepEqual(pending, {
            request_id: requested.request_id,
            actor_external_id: actorExternalId,
            actor_name: "Operator Review",
            client_label: "Phone-bound request",
            requested_at: pending.requested_at,
            request_expires_at: pending.request_expires_at,
            binding: "native_client",
            status: "pending",
        });
        assert.equal("claim_code" in pending, false);
        await assert.rejects(decideActorSessionRequest(requested.request_id, {
            approved: true,
            expected_actor_external_id: actorExternalId,
            expected_client_label: "Changed label",
            ttl_seconds: 3600,
        }), /No exact unexpired pending/);
        const denied = await decideActorSessionRequest(requested.request_id, {
            approved: false,
            expected_actor_external_id: actorExternalId,
            expected_client_label: "Phone-bound request",
        });
        assert.equal(denied.status, "denied");
    } finally {
        await db.query("DELETE FROM actor_session_requests WHERE request_id = $1", [requested.request_id]);
        await db.query("DELETE FROM actors WHERE id = $1", [actor.actor.id]);
    }
});

test.after(async () => {
    await db.end();
});
