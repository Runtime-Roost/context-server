import {
    createHash,
    randomBytes,
    randomUUID,
    timingSafeEqual,
} from "node:crypto";

import { db, initializeDatabase } from "../storage/db.js";
import type { AuthenticatedActor } from "./request-auth.js";

export type ActorSessionProof = {
    session_id: string;
    session_token: string;
    timestamp: string;
    nonce: string;
};

type SessionRequestRow = {
    request_id: string;
    actor_id: number | string;
    actor_external_id: string;
    actor_name: string;
    client_label: string | null;
    claim_secret_hash: string;
    status: "pending" | "approved" | "claimed" | "denied" | "expired";
    requested_at: string | Date;
    request_expires_at: string | Date;
    approved_session_ttl_seconds: number | null;
    activation_pin_hash?: string | null;
    openai_subject_hash?: string | null;
    openai_session_hash?: string | null;
};

export type OpenAITunnelIdentity = {
    subject: string;
    session: string;
};

const REQUEST_TTL_MS = 15 * 60 * 1000;
const MAX_PENDING_REQUESTS_PER_ACTOR = 3;
const DEFAULT_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const RENEWAL_WINDOW_SECONDS = 7 * 24 * 60 * 60;
const RENEWED_LEASE_SECONDS = 30 * 24 * 60 * 60;
const SESSION_CLOCK_SKEW_MS = 5 * 60 * 1000;
const SESSION_NONCE_TTL_MS = 10 * 60 * 1000;
const TOKEN_HASH_DOMAIN = "personal-context-server:actor-session:v1";
const OPENAI_IDENTITY_HASH_DOMAIN = "personal-context-server:openai-tunnel-identity:v1";

function hashCapability(value: string) {
    return createHash("sha256")
        .update(TOKEN_HASH_DOMAIN)
        .update("\0")
        .update(value)
        .digest("hex");
}

function hashOpenAIIdentity(value: string) {
    return createHash("sha256")
        .update(OPENAI_IDENTITY_HASH_DOMAIN)
        .update("\0")
        .update(value)
        .digest("hex");
}

function hashesEqual(left: string, right: string) {
    const leftBuffer = Buffer.from(left, "hex");
    const rightBuffer = Buffer.from(right, "hex");
    return leftBuffer.length === rightBuffer.length
        && timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeTimestamp(value: string | Date) {
    return value instanceof Date ? value.toISOString() : value;
}

function normalizeSessionTtl(ttlSeconds?: number) {
    if (ttlSeconds === undefined) return DEFAULT_SESSION_TTL_SECONDS;
    const normalized = Math.trunc(ttlSeconds);

    if (normalized < 300 || normalized > MAX_SESSION_TTL_SECONDS) {
        throw new Error("Session TTL must be between 300 and 2592000 seconds.");
    }

    return normalized;
}

export async function requestActorSession(
    actorExternalId: string,
    clientLabel?: string,
    identity?: OpenAITunnelIdentity,
) {
    await initializeDatabase();
    const actor = await db.query(
        "SELECT 1 FROM actors WHERE external_id = $1",
        [actorExternalId],
    );
    if (actor.rowCount !== 1) {
        throw new Error("ACTOR_NOT_FOUND");
    }
    const requestId = `asr_${randomUUID()}`;
    const claimCode = randomBytes(32).toString("base64url");
    const claimSecretHash = hashCapability(claimCode);
    const requestExpiresAt = new Date(Date.now() + REQUEST_TTL_MS);
    const result = await db.query<SessionRequestRow>(
        `
            WITH expired AS (
                UPDATE actor_session_requests
                SET status = 'expired'
                WHERE status IN ('pending', 'approved')
                  AND request_expires_at <= NOW()
            ),
            target AS (
                SELECT actors.id, actors.external_id, actors.name
                FROM actors
                WHERE actors.external_id = $1
                  AND (
                      SELECT COUNT(*)
                      FROM actor_session_requests
                      WHERE actor_session_requests.actor_id = actors.id
                        AND actor_session_requests.status IN ('pending', 'approved')
                        AND actor_session_requests.request_expires_at > NOW()
                  ) < $6
            ),
            inserted AS (
                INSERT INTO actor_session_requests (
                    request_id,
                    actor_id,
                    client_label,
                    claim_secret_hash,
                    request_expires_at,
                    openai_subject_hash,
                    openai_session_hash
                )
                SELECT $2, target.id, $3, $4, $5, $7, $8
                FROM target
                RETURNING *
            )
            SELECT
                inserted.request_id,
                inserted.actor_id,
                target.external_id AS actor_external_id,
                target.name AS actor_name,
                inserted.client_label,
                inserted.claim_secret_hash,
                inserted.status,
                inserted.requested_at,
                inserted.request_expires_at,
                inserted.approved_session_ttl_seconds,
                inserted.openai_subject_hash,
                inserted.openai_session_hash
            FROM inserted
            INNER JOIN target ON target.id = inserted.actor_id
        `,
        [
            actorExternalId,
            requestId,
            clientLabel?.trim() || null,
            claimSecretHash,
            requestExpiresAt.toISOString(),
            MAX_PENDING_REQUESTS_PER_ACTOR,
            identity ? hashOpenAIIdentity(identity.subject) : null,
            identity ? hashOpenAIIdentity(identity.session) : null,
        ],
    );
    const request = result.rows[0];

    if (!request) {
        throw new Error("ACTOR_SESSION_PENDING_LIMIT_REACHED");
    }

    const response = {
        request_id: request.request_id,
        actor_external_id: request.actor_external_id,
        actor_name: request.actor_name,
        client_label: request.client_label,
        status: request.status,
        request_expires_at: normalizeTimestamp(request.request_expires_at),
        next_action: identity
            ? "Ask the local operator to approve this request_id. Approval activates this exact OpenAI conversation; no second authentication call is needed."
            : "Ask the local operator to approve this request_id, then call claim_actor_session with request_id and claim_code.",
    };

    return identity ? response : { ...response, claim_code: claimCode };
}

async function getVerifiedRequest(requestId: string, claimCode: string) {
    const result = await db.query<SessionRequestRow>(
        `
            SELECT
                actor_session_requests.request_id,
                actor_session_requests.actor_id,
                actors.external_id AS actor_external_id,
                actors.name AS actor_name,
                actor_session_requests.client_label,
                actor_session_requests.claim_secret_hash,
                actor_session_requests.status,
                actor_session_requests.requested_at,
                actor_session_requests.request_expires_at,
                actor_session_requests.approved_session_ttl_seconds
            FROM actor_session_requests
            INNER JOIN actors ON actors.id = actor_session_requests.actor_id
            WHERE actor_session_requests.request_id = $1
        `,
        [requestId],
    );
    const request = result.rows[0];

    if (!request || !hashesEqual(request.claim_secret_hash, hashCapability(claimCode))) {
        throw new Error("ACTOR_SESSION_REQUEST_NOT_FOUND");
    }

    return request;
}

export async function getActorSessionRequestStatus(
    requestId: string,
    claimCode: string,
) {
    await initializeDatabase();
    const request = await getVerifiedRequest(requestId, claimCode);
    const expired = new Date(request.request_expires_at).getTime() <= Date.now();
    const status = expired && ["pending", "approved"].includes(request.status)
        ? "expired"
        : request.status;

    if (status === "expired" && request.status !== "expired") {
        await db.query(
            "UPDATE actor_session_requests SET status = 'expired' WHERE request_id = $1",
            [requestId],
        );
    }

    return {
        request_id: request.request_id,
        actor_external_id: request.actor_external_id,
        client_label: request.client_label,
        status,
        request_expires_at: normalizeTimestamp(request.request_expires_at),
    };
}

export async function approveActorSessionRequest(
    requestId: string,
    expectedActorExternalId: string,
    sessionTtlSeconds?: number,
) {
    await initializeDatabase();
    const ttl = normalizeSessionTtl(sessionTtlSeconds);
    const claimExpiresAt = new Date(Date.now() + REQUEST_TTL_MS);
    const result = await db.query<SessionRequestRow>(
        `
            UPDATE actor_session_requests
            SET
                status = 'approved',
                approved_at = NOW(),
                approved_session_ttl_seconds = $3,
                request_expires_at = $4
            FROM actors
            WHERE actor_session_requests.request_id = $1
              AND actor_session_requests.actor_id = actors.id
              AND actors.external_id = $2
              AND actor_session_requests.status = 'pending'
              AND actor_session_requests.request_expires_at > NOW()
            RETURNING
                actor_session_requests.request_id,
                actor_session_requests.actor_id,
                actors.external_id AS actor_external_id,
                actors.name AS actor_name,
                actor_session_requests.client_label,
                actor_session_requests.claim_secret_hash,
                actor_session_requests.status,
                actor_session_requests.requested_at,
                actor_session_requests.request_expires_at,
                actor_session_requests.approved_session_ttl_seconds,
                actor_session_requests.activation_pin_hash
                , actor_session_requests.openai_subject_hash
                , actor_session_requests.openai_session_hash
        `,
        [
            requestId,
            expectedActorExternalId,
            ttl,
            claimExpiresAt.toISOString(),
        ],
    );
    const request = result.rows[0];

    if (!request) {
        throw new Error("No unexpired pending actor-session request matched.");
    }

    const approved = {
        request_id: request.request_id,
        actor_external_id: request.actor_external_id,
        actor_name: request.actor_name,
        client_label: request.client_label,
        status: request.status,
        approved_session_ttl_seconds: request.approved_session_ttl_seconds,
        claim_expires_at: normalizeTimestamp(request.request_expires_at),
    };

    if (request.openai_subject_hash && request.openai_session_hash) {
        const session = await activateOpenAITunnelActorSession(requestId);
        return {
            ...approved,
            status: "claimed",
            activated_session: session,
        };
    }

    return approved;
}

async function activateOpenAITunnelActorSession(requestId: string) {
    await initializeDatabase();
    const client = await db.connect();
    const sessionId = `as_${randomUUID()}`;
    const internalTokenHash = hashCapability(randomBytes(32).toString("base64url"));

    try {
        await client.query("BEGIN");
        const result = await client.query<SessionRequestRow>(
            `
                SELECT
                    actor_session_requests.request_id,
                    actor_session_requests.actor_id,
                    actors.external_id AS actor_external_id,
                    actors.name AS actor_name,
                    actor_session_requests.client_label,
                    actor_session_requests.claim_secret_hash,
                    actor_session_requests.activation_pin_hash,
                    actor_session_requests.openai_subject_hash,
                    actor_session_requests.openai_session_hash,
                    actor_session_requests.status,
                    actor_session_requests.requested_at,
                    actor_session_requests.request_expires_at,
                    actor_session_requests.approved_session_ttl_seconds
                FROM actor_session_requests
                INNER JOIN actors ON actors.id = actor_session_requests.actor_id
                WHERE actor_session_requests.request_id = $1
                FOR UPDATE
            `,
            [requestId],
        );
        const request = result.rows[0];

        if (
            !request
            || request.status !== "approved"
            || new Date(request.request_expires_at).getTime() <= Date.now()
            || !request.approved_session_ttl_seconds
            || !request.openai_subject_hash
            || !request.openai_session_hash
        ) {
            throw new Error("ACTOR_SESSION_REQUEST_NOT_FOUND");
        }
        const subjectHash = request.openai_subject_hash;
        const openaiSessionHash = request.openai_session_hash;

        await client.query(
            "SELECT id FROM actors WHERE id = $1 FOR UPDATE",
            [request.actor_id],
        );
        const predecessor = await client.query<{ session_id: string }>(
            `
                SELECT session_id
                FROM actor_sessions
                WHERE actor_id = $1
                  AND revoked_at IS NULL
                ORDER BY created_at DESC, session_id DESC
                LIMIT 1
                FOR UPDATE
            `,
            [request.actor_id],
        );
        const predecessorSessionId = predecessor.rows[0]?.session_id ?? null;
        const expiresAt = new Date(
            Date.now() + request.approved_session_ttl_seconds * 1000,
        );

        await client.query(
            `
                UPDATE actor_sessions
                SET
                    revoked_at = NOW(),
                    revocation_reason = 'replaced_by_new_claim'
                WHERE actor_id = $1
                  AND revoked_at IS NULL
            `,
            [request.actor_id],
        );
        await client.query(
            `
                INSERT INTO actor_sessions (
                    session_id,
                    actor_id,
                    token_hash,
                    client_label,
                    expires_at,
                    predecessor_session_id,
                    openai_subject_hash,
                    openai_session_hash,
                    lease_expires_at,
                    lifecycle_kind,
                    renewal_enabled
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $5, 'trusted_openai_thread', $9)
            `,
            [
                sessionId,
                request.actor_id,
                internalTokenHash,
                request.client_label,
                expiresAt.toISOString(),
                predecessorSessionId,
                subjectHash,
                openaiSessionHash,
                request.approved_session_ttl_seconds === RENEWED_LEASE_SECONDS,
            ],
        );
        if (predecessorSessionId) {
            await client.query(
                "UPDATE actor_sessions SET replaced_by_session_id = $1 WHERE session_id = $2",
                [sessionId, predecessorSessionId],
            );
        }
        await client.query(
            `
                UPDATE actor_session_requests
                SET status = 'claimed', claimed_at = NOW(), activation_pin_hash = NULL
                WHERE request_id = $1
            `,
            [requestId],
        );
        await client.query("COMMIT");

        return {
            session_id: sessionId,
            actor_external_id: request.actor_external_id,
            actor_name: request.actor_name,
            client_label: request.client_label,
            expires_at: expiresAt.toISOString(),
            predecessor_session_id: predecessorSessionId,
            authentication: "openai_session_binding",
        };
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

export async function authenticateOpenAITunnelActorSession(
    identity: OpenAITunnelIdentity,
): Promise<AuthenticatedActor> {
    await initializeDatabase();
    const subjectHash = hashOpenAIIdentity(identity.subject);
    const openaiSessionHash = hashOpenAIIdentity(identity.session);
    const result = await db.query<{
        session_id: string;
        actor_id: number | string;
        actor_external_id: string;
        actor_name: string;
        expires_at: string | Date;
        revoked_at: string | Date | null;
    }>(
        `
            SELECT
                actor_sessions.session_id,
                actor_sessions.actor_id,
                actors.external_id AS actor_external_id,
                actors.name AS actor_name,
                actor_sessions.lease_expires_at AS expires_at,
                actor_sessions.revoked_at
            FROM actor_sessions
            INNER JOIN actors ON actors.id = actor_sessions.actor_id
            WHERE actor_sessions.openai_subject_hash = $1
              AND actor_sessions.openai_session_hash = $2
              AND actors.external_id IS NOT NULL
            ORDER BY actor_sessions.created_at DESC
            LIMIT 1
        `,
        [subjectHash, openaiSessionHash],
    );
    const session = result.rows[0];

    if (!session) throw new Error("AUTHENTICATION_REQUIRED");
    if (session.revoked_at) throw new Error("SESSION_REVOKED");
    if (new Date(session.expires_at).getTime() <= Date.now()) {
        throw new Error("AUTHENTICATION_REQUIRED");
    }

    const touched = await db.query(
        `
            UPDATE actor_sessions
            SET
                last_used_at = NOW(),
                lease_expires_at = CASE
                    WHEN renewal_enabled AND lease_expires_at <= NOW() + ($2 * INTERVAL '1 second')
                        THEN NOW() + ($3 * INTERVAL '1 second')
                    ELSE lease_expires_at
                END,
                expires_at = CASE
                    WHEN renewal_enabled AND lease_expires_at <= NOW() + ($2 * INTERVAL '1 second')
                        THEN NOW() + ($3 * INTERVAL '1 second')
                    ELSE expires_at
                END,
                last_renewed_at = CASE
                    WHEN renewal_enabled AND lease_expires_at <= NOW() + ($2 * INTERVAL '1 second') THEN NOW()
                    ELSE last_renewed_at
                END,
                renewal_count = CASE
                    WHEN renewal_enabled AND lease_expires_at <= NOW() + ($2 * INTERVAL '1 second') THEN renewal_count + 1
                    ELSE renewal_count
                END
            WHERE session_id = $1
              AND revoked_at IS NULL
              AND external_deleted_at IS NULL
              AND lease_expires_at > NOW()
            RETURNING session_id
        `,
        [session.session_id, RENEWAL_WINDOW_SECONDS, RENEWED_LEASE_SECONDS],
    );
    if (touched.rowCount !== 1) throw new Error("SESSION_REVOKED");

    return {
        actor_id: Number(session.actor_id),
        actor_external_id: session.actor_external_id,
        actor_name: session.actor_name,
        key_id: session.session_id,
    };
}

export async function denyActorSessionRequest(requestId: string) {
    await initializeDatabase();
    const result = await db.query(
        `
            UPDATE actor_session_requests
            SET status = 'denied', denied_at = NOW()
            WHERE request_id = $1
              AND status IN ('pending', 'approved')
            RETURNING request_id, actor_id, status, denied_at
        `,
        [requestId],
    );

    return result.rows[0] ?? null;
}

export async function claimActorSession(
    requestId: string,
    claimCode: string,
) {
    await initializeDatabase();
    const client = await db.connect();
    const sessionId = `as_${randomUUID()}`;
    const sessionToken = randomBytes(32).toString("base64url");
    const tokenHash = hashCapability(sessionToken);

    try {
        await client.query("BEGIN");
        const result = await client.query<SessionRequestRow>(
            `
                SELECT
                    actor_session_requests.request_id,
                    actor_session_requests.actor_id,
                    actors.external_id AS actor_external_id,
                    actors.name AS actor_name,
                    actor_session_requests.client_label,
                    actor_session_requests.claim_secret_hash,
                    actor_session_requests.status,
                    actor_session_requests.requested_at,
                    actor_session_requests.request_expires_at,
                    actor_session_requests.approved_session_ttl_seconds
                FROM actor_session_requests
                INNER JOIN actors ON actors.id = actor_session_requests.actor_id
                WHERE actor_session_requests.request_id = $1
                FOR UPDATE
            `,
            [requestId],
        );
        const request = result.rows[0];

        if (
            !request
            || request.status !== "approved"
            || new Date(request.request_expires_at).getTime() <= Date.now()
            || !hashesEqual(request.claim_secret_hash, hashCapability(claimCode))
            || !request.approved_session_ttl_seconds
        ) {
            throw new Error("ACTOR_SESSION_REQUEST_NOT_FOUND");
        }

        // Claims for different requests belonging to the same durable actor must
        // serialize on that actor, not merely on the individual request row.
        await client.query(
            "SELECT id FROM actors WHERE id = $1 FOR UPDATE",
            [request.actor_id],
        );

        const expiresAt = new Date(
            Date.now() + request.approved_session_ttl_seconds * 1000,
        );
        const predecessor = await client.query<{ session_id: string }>(
            `
                SELECT session_id
                FROM actor_sessions
                WHERE actor_id = $1
                  AND revoked_at IS NULL
                ORDER BY created_at DESC, session_id DESC
                LIMIT 1
                FOR UPDATE
            `,
            [request.actor_id],
        );
        const predecessorSessionId = predecessor.rows[0]?.session_id ?? null;

        await client.query(
            `
                UPDATE actor_sessions
                SET
                    revoked_at = NOW(),
                    revocation_reason = 'replaced_by_new_claim'
                WHERE actor_id = $1
                  AND revoked_at IS NULL
            `,
            [request.actor_id],
        );
        await client.query(
            `
                INSERT INTO actor_sessions (
                    session_id,
                    actor_id,
                    token_hash,
                    client_label,
                    expires_at,
                    predecessor_session_id,
                    lease_expires_at,
                    lifecycle_kind,
                    renewal_enabled
                )
                VALUES ($1, $2, $3, $4, $5, $6, $5, 'native_bearer', $7)
            `,
            [
                sessionId,
                request.actor_id,
                tokenHash,
                request.client_label,
                expiresAt.toISOString(),
                predecessorSessionId,
                request.approved_session_ttl_seconds === RENEWED_LEASE_SECONDS,
            ],
        );
        if (predecessorSessionId) {
            await client.query(
                `
                    UPDATE actor_sessions
                    SET replaced_by_session_id = $1
                    WHERE session_id = $2
                `,
                [sessionId, predecessorSessionId],
            );
        }
        await client.query(
            `
                UPDATE actor_session_requests
                SET status = 'claimed', claimed_at = NOW()
                WHERE request_id = $1
            `,
            [requestId],
        );
        await client.query("COMMIT");

        return {
            session_id: sessionId,
            session_token: sessionToken,
            actor_external_id: request.actor_external_id,
            actor_name: request.actor_name,
            client_label: request.client_label,
            expires_at: expiresAt.toISOString(),
            predecessor_session_id: predecessorSessionId,
            warning: "Store this session capability securely. It is returned only once and grants the approved actor's channel access until expiry or revocation.",
        };
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

export async function authenticateActorSession(
    auth: ActorSessionProof,
): Promise<AuthenticatedActor> {
    await initializeDatabase();
    const timestamp = new Date(auth.timestamp);
    const now = new Date();

    if (
        Number.isNaN(timestamp.getTime())
        || Math.abs(now.getTime() - timestamp.getTime()) > SESSION_CLOCK_SKEW_MS
        || auth.nonce.length < 16
        || auth.nonce.length > 200
    ) {
        throw new Error("AUTHENTICATION_FAILED");
    }

    const result = await db.query<{
        session_id: string;
        actor_id: number | string;
        actor_external_id: string;
        actor_name: string;
        token_hash: string;
        expires_at: string | Date;
        revoked_at: string | Date | null;
    }>(
        `
            SELECT
                actor_sessions.session_id,
                actor_sessions.actor_id,
                actors.external_id AS actor_external_id,
                actors.name AS actor_name,
                actor_sessions.token_hash,
                actor_sessions.lease_expires_at AS expires_at,
                actor_sessions.revoked_at
            FROM actor_sessions
            INNER JOIN actors ON actors.id = actor_sessions.actor_id
            WHERE actor_sessions.session_id = $1
              AND actors.external_id IS NOT NULL
        `,
        [auth.session_id],
    );
    const session = result.rows[0];

    if (!session || !hashesEqual(session.token_hash, hashCapability(auth.session_token))) {
        throw new Error("AUTHENTICATION_FAILED");
    }
    if (session.revoked_at) {
        throw new Error("SESSION_REVOKED");
    }
    if (new Date(session.expires_at).getTime() <= now.getTime()) {
        throw new Error("AUTHENTICATION_FAILED");
    }

    const client = await db.connect();

    try {
        await client.query("BEGIN");
        await client.query("DELETE FROM actor_session_nonces WHERE expires_at < NOW()");
        const nonce = await client.query(
            `
                INSERT INTO actor_session_nonces (session_id, nonce, expires_at)
                VALUES ($1, $2, $3)
                ON CONFLICT DO NOTHING
                RETURNING nonce
            `,
            [
                auth.session_id,
                auth.nonce,
                new Date(now.getTime() + SESSION_NONCE_TTL_MS).toISOString(),
            ],
        );

        if (nonce.rowCount !== 1) {
            throw new Error("AUTHENTICATION_FAILED");
        }

        const touched = await client.query(
            `
                UPDATE actor_sessions
                SET last_used_at = NOW()
                WHERE session_id = $1
                  AND revoked_at IS NULL
                  AND lease_expires_at > NOW()
                  AND external_deleted_at IS NULL
                RETURNING session_id
            `,
            [auth.session_id],
        );

        if (touched.rowCount !== 1) {
            const current = await client.query<{ revoked_at: string | Date | null }>(
                "SELECT revoked_at FROM actor_sessions WHERE session_id = $1",
                [auth.session_id],
            );
            throw new Error(current.rows[0]?.revoked_at ? "SESSION_REVOKED" : "AUTHENTICATION_FAILED");
        }

        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }

    return {
        actor_id: Number(session.actor_id),
        actor_external_id: session.actor_external_id,
        actor_name: session.actor_name,
        key_id: session.session_id,
    };
}

export async function renewActorSession(auth: ActorSessionProof) {
    const authenticated = await authenticateActorSession(auth);
    const client = await db.connect();
    const replacementToken = randomBytes(32).toString("base64url");
    const replacementHash = hashCapability(replacementToken);

    try {
        await client.query("BEGIN");
        await client.query("SELECT id FROM actors WHERE id = $1 FOR UPDATE", [authenticated.actor_id]);
        const current = await client.query<{
            session_id: string;
            token_hash: string;
            credential_generation: number;
            renewal_enabled: boolean;
        }>(`
            SELECT session_id, token_hash, credential_generation, renewal_enabled
            FROM actor_sessions
            WHERE actor_id = $1
              AND session_id = $2
              AND lifecycle_kind = 'native_bearer'
              AND revoked_at IS NULL
              AND external_deleted_at IS NULL
              AND lease_expires_at > NOW()
            FOR UPDATE
        `, [authenticated.actor_id, auth.session_id]);
        const session = current.rows[0];
        if (!session || !hashesEqual(session.token_hash, hashCapability(auth.session_token))) {
            throw new Error("SESSION_REVOKED");
        }
        if (!session.renewal_enabled) throw new Error("SESSION_RENEWAL_NOT_ALLOWED");

        const renewed = await client.query<{
            session_id: string;
            lease_expires_at: string | Date;
            credential_generation: number;
            renewal_count: number;
        }>(`
            UPDATE actor_sessions
            SET
                token_hash = $2,
                expires_at = NOW() + ($3 * INTERVAL '1 second'),
                lease_expires_at = NOW() + ($3 * INTERVAL '1 second'),
                last_renewed_at = NOW(),
                last_used_at = NOW(),
                renewal_count = renewal_count + 1,
                credential_generation = credential_generation + 1
            WHERE session_id = $1
            RETURNING session_id, lease_expires_at, credential_generation, renewal_count
        `, [session.session_id, replacementHash, RENEWED_LEASE_SECONDS]);
        await client.query("COMMIT");
        const value = renewed.rows[0]!;
        return {
            session_id: value.session_id,
            session_token: replacementToken,
            actor_external_id: authenticated.actor_external_id,
            actor_name: authenticated.actor_name,
            expires_at: normalizeTimestamp(value.lease_expires_at),
            credential_generation: value.credential_generation,
            renewal_count: value.renewal_count,
            warning: "Replace the previous session token immediately. The old token is no longer valid.",
        };
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

export async function recordExternalActorSessionLifecycleEvent(
    identity: OpenAITunnelIdentity,
    event: { event_id: string; event: "thread_deleted"; occurred_at: string },
) {
    if (event.event_id.length < 8 || event.event_id.length > 200) throw new Error("INVALID_EXTERNAL_LIFECYCLE_EVENT");
    const occurredAt = new Date(event.occurred_at);
    if (Number.isNaN(occurredAt.getTime()) || occurredAt.getTime() > Date.now() + SESSION_CLOCK_SKEW_MS) {
        throw new Error("INVALID_EXTERNAL_LIFECYCLE_EVENT");
    }
    await initializeDatabase();
    const subjectHash = hashOpenAIIdentity(identity.subject);
    const sessionHash = hashOpenAIIdentity(identity.session);
    const client = await db.connect();
    try {
        await client.query("BEGIN");
        const matched = await client.query<{ session_id: string; external_lifecycle_event_id: string | null }>(`
            SELECT session_id, external_lifecycle_event_id
            FROM actor_sessions
            WHERE openai_subject_hash = $1 AND openai_session_hash = $2
            ORDER BY created_at DESC
            LIMIT 1
            FOR UPDATE
        `, [subjectHash, sessionHash]);
        const session = matched.rows[0];
        if (!session) {
            await client.query("COMMIT");
            return { matched: false, event: event.event };
        }
        if (session.external_lifecycle_event_id && session.external_lifecycle_event_id !== event.event_id) {
            throw new Error("EXTERNAL_LIFECYCLE_EVENT_CONFLICT");
        }
        await client.query(`
            UPDATE actor_sessions
            SET
                external_deleted_at = COALESCE(external_deleted_at, $2),
                external_lifecycle_event_id = COALESCE(external_lifecycle_event_id, $3),
                revoked_at = COALESCE(revoked_at, NOW()),
                revocation_reason = COALESCE(revocation_reason, 'external_thread_deleted')
            WHERE session_id = $1
        `, [session.session_id, occurredAt.toISOString(), event.event_id]);
        await client.query("COMMIT");
        return { matched: true, session_id: session.session_id, event: event.event };
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

export async function revokeActorSession(sessionId: string) {
    await initializeDatabase();
    const result = await db.query(
        `
            UPDATE actor_sessions
            SET revoked_at = NOW()
            WHERE session_id = $1
              AND revoked_at IS NULL
            RETURNING session_id, actor_id, revoked_at
        `,
        [sessionId],
    );

    return result.rows[0] ?? null;
}
