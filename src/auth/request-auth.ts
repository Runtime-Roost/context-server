import {
    createHash,
    createPublicKey,
    randomUUID,
    verify,
} from "node:crypto";

import { db, initializeDatabase } from "../storage/db.js";
import {
    authenticateActorSession,
    type ActorSessionProof,
} from "./actor-sessions.js";

export type SignedRequestAuthProof = {
    key_id: string;
    timestamp: string;
    nonce: string;
    signature: string;
};
export type RequestAuthProof = SignedRequestAuthProof | ActorSessionProof;

export type AuthenticatedActor = {
    actor_id: number;
    actor_external_id: string;
    actor_name: string;
    key_id: string;
};

type ActorKeyRow = {
    actor_id: number | string;
    actor_external_id: string | null;
    actor_name: string;
    key_id: string;
    public_key_pem: string;
    status: "active" | "revoked";
};

const AUTH_DOMAIN = "personal-context-server:v1";
const AUTH_CLOCK_SKEW_MS = 5 * 60 * 1000;
const AUTH_NONCE_TTL_MS = 10 * 60 * 1000;

function canonicalize(value: unknown): string {
    if (value === null) return "null";

    switch (typeof value) {
        case "string":
            return JSON.stringify(value);
        case "boolean":
            return value ? "true" : "false";
        case "number":
            if (!Number.isFinite(value)) {
                throw new Error("Signed request payload contains a non-finite number.");
            }
            return JSON.stringify(value);
        case "object": {
            if (Array.isArray(value)) {
                return `[${value.map((item) => canonicalize(item)).join(",")}]`;
            }

            const record = value as Record<string, unknown>;
            const entries = Object.keys(record)
                .filter((key) => record[key] !== undefined)
                .sort()
                .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`);
            return `{${entries.join(",")}}`;
        }
        default:
            throw new Error(`Unsupported signed request value type: ${typeof value}.`);
    }
}

export function buildRequestSigningMessage(
    tool: string,
    payload: Record<string, unknown>,
    timestamp: string,
    nonce: string,
) {
    return [
        AUTH_DOMAIN,
        tool,
        timestamp,
        nonce,
        canonicalize(payload),
    ].join("\n");
}

function decodeBase64Url(value: string) {
    if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) {
        throw new Error("signature must use base64url encoding.");
    }

    return Buffer.from(value, "base64url");
}

export function publicKeyFingerprint(publicKeyPem: string) {
    const publicKey = createPublicKey(publicKeyPem);

    if (publicKey.asymmetricKeyType !== "ed25519") {
        throw new Error("Only Ed25519 actor keys are supported.");
    }

    const der = publicKey.export({ type: "spki", format: "der" });
    return createHash("sha256").update(der).digest("hex");
}

export async function enrollActorKey(
    actorExternalId: string,
    publicKeyPem: string,
    label?: string,
) {
    await initializeDatabase();
    const fingerprint = publicKeyFingerprint(publicKeyPem);
    const keyId = `ak_${fingerprint.slice(0, 24)}`;
    const result = await db.query<{
        key_id: string;
        actor_id: number | string;
        actor_external_id: string;
        label: string | null;
        fingerprint_sha256: string;
        status: string;
        created_at: string | Date;
    }>(
        `
            INSERT INTO actor_keys (
                key_id,
                actor_id,
                label,
                public_key_pem,
                fingerprint_sha256
            )
            SELECT $2, actors.id, $3, $4, $5
            FROM actors
            WHERE actors.external_id = $1
            ON CONFLICT DO NOTHING
            RETURNING
                key_id,
                actor_id,
                $1::text AS actor_external_id,
                label,
                fingerprint_sha256,
                status,
                created_at
        `,
        [actorExternalId, keyId, label ?? null, publicKeyPem, fingerprint],
    );

    const enrolled = result.rows[0] ?? (
        await db.query<{
            key_id: string;
            actor_id: number | string;
            actor_external_id: string;
            label: string | null;
            fingerprint_sha256: string;
            status: string;
            created_at: string | Date;
        }>(
            `
                SELECT
                    actor_keys.key_id,
                    actor_keys.actor_id,
                    actors.external_id AS actor_external_id,
                    actor_keys.label,
                    actor_keys.fingerprint_sha256,
                    actor_keys.status,
                    actor_keys.created_at
                FROM actor_keys
                INNER JOIN actors ON actors.id = actor_keys.actor_id
                WHERE actor_keys.key_id = $1
                  AND actors.external_id = $2
            `,
            [keyId, actorExternalId],
        )
    ).rows[0];

    if (!enrolled) {
        throw new Error(`No durable actor exists with external_id ${actorExternalId}.`);
    }

    return {
        key_id: enrolled.key_id,
        actor_id: Number(enrolled.actor_id),
        actor_external_id: enrolled.actor_external_id,
        label: enrolled.label,
        fingerprint_sha256: enrolled.fingerprint_sha256,
        status: enrolled.status,
        created_at: enrolled.created_at instanceof Date
            ? enrolled.created_at.toISOString()
            : enrolled.created_at,
    };
}

export async function revokeActorKey(keyId: string) {
    await initializeDatabase();
    const result = await db.query(
        `
            UPDATE actor_keys
            SET status = 'revoked', revoked_at = NOW()
            WHERE key_id = $1
              AND status = 'active'
            RETURNING key_id, actor_id, status, revoked_at
        `,
        [keyId],
    );

    return result.rows[0] ?? null;
}

export async function authenticateRequest(
    tool: string,
    payload: Record<string, unknown>,
    auth: RequestAuthProof,
): Promise<AuthenticatedActor> {
    if ("session_id" in auth) {
        return authenticateActorSession(auth);
    }

    await initializeDatabase();

    const timestamp = new Date(auth.timestamp);
    const now = new Date();

    if (Number.isNaN(timestamp.getTime())) {
        throw new Error("AUTHENTICATION_FAILED");
    }

    if (Math.abs(now.getTime() - timestamp.getTime()) > AUTH_CLOCK_SKEW_MS) {
        throw new Error("AUTHENTICATION_FAILED");
    }

    if (auth.nonce.length < 16 || auth.nonce.length > 200) {
        throw new Error("AUTHENTICATION_FAILED");
    }

    const keyResult = await db.query<ActorKeyRow>(
        `
            SELECT
                actor_keys.actor_id,
                actors.external_id AS actor_external_id,
                actors.name AS actor_name,
                actor_keys.key_id,
                actor_keys.public_key_pem,
                actor_keys.status
            FROM actor_keys
            INNER JOIN actors ON actors.id = actor_keys.actor_id
            WHERE actor_keys.key_id = $1
              AND actor_keys.status = 'active'
              AND actors.external_id IS NOT NULL
        `,
        [auth.key_id],
    );
    const key = keyResult.rows[0];

    if (!key || key.status !== "active" || !key.actor_external_id) {
        throw new Error("AUTHENTICATION_FAILED");
    }

    const message = buildRequestSigningMessage(
        tool,
        payload,
        auth.timestamp,
        auth.nonce,
    );
    let signature: Buffer;

    try {
        signature = decodeBase64Url(auth.signature);
    } catch {
        throw new Error("AUTHENTICATION_FAILED");
    }

    if (!verify(null, Buffer.from(message, "utf8"), key.public_key_pem, signature)) {
        throw new Error("AUTHENTICATION_FAILED");
    }

    const client = await db.connect();

    try {
        await client.query("BEGIN");
        await client.query("DELETE FROM auth_nonces WHERE expires_at < NOW()");
        const nonceResult = await client.query(
            `
                INSERT INTO auth_nonces (key_id, nonce, expires_at)
                VALUES ($1, $2, $3)
                ON CONFLICT DO NOTHING
                RETURNING nonce
            `,
            [
                auth.key_id,
                auth.nonce,
                new Date(now.getTime() + AUTH_NONCE_TTL_MS).toISOString(),
            ],
        );

        if (nonceResult.rowCount !== 1) {
            throw new Error("AUTHENTICATION_FAILED");
        }

        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }

    return {
        actor_id: Number(key.actor_id),
        actor_external_id: key.actor_external_id,
        actor_name: key.actor_name,
        key_id: key.key_id,
    };
}

export function createRequestNonce() {
    return randomUUID();
}
