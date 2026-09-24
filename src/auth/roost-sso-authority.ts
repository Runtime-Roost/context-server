import { createHash } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { db, initializeDatabase } from "../storage/db.js";
import type { AuthenticatedActor } from "./request-auth.js";
import type { OpenAITunnelIdentity } from "./actor-sessions.js";

type AuthorityResponse = Record<string, unknown>;

function conversation(identity: OpenAITunnelIdentity) {
    return createHash("sha256")
        .update("roost-sso:trusted-openai-conversation:v1\0")
        .update(identity.subject)
        .update("\0")
        .update(identity.session)
        .digest("hex");
}

async function readPrivateKey(path: string) {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const info = await handle.stat();
        if (!info.isFile() || (info.mode & 0o777) !== 0o600) {
            throw new Error("AUTHORITY_KEY_PERMISSIONS_INVALID");
        }
        return (await handle.readFile("utf8")).trim();
    } finally {
        await handle.close();
    }
}

export interface ContextAuthority {
    bind(identity: OpenAITunnelIdentity, bindingId: string): Promise<AuthenticatedActor>;
    activate(identity: OpenAITunnelIdentity): Promise<AuthenticatedActor>;
    authorize(identity: OpenAITunnelIdentity): Promise<AuthenticatedActor>;
}

export class RoostContextAuthority implements ContextAuthority {
    readonly #baseUrl: string;
    readonly #keyPath: string;
    #key = "";

    constructor(baseUrl: string, keyPath: string) {
        if (!/^http:\/\/(127\.0\.0\.1|\[::1\])(?::[0-9]+)?$/.test(baseUrl)) {
            throw new Error("AUTHORITY_URL_MUST_BE_LOOPBACK");
        }
        this.#baseUrl = baseUrl;
        this.#keyPath = keyPath;
    }

    async #call(path: string, body: unknown) {
        this.#key ||= await readPrivateKey(this.#keyPath);
        const response = await fetch(`${this.#baseUrl}${path}`, {
            method: "POST",
            headers: {
                authorization: `Bearer ${this.#key}`,
                "content-type": "application/json",
            },
            body: JSON.stringify(body),
        });
        const result = await response.json() as AuthorityResponse;
        if (!response.ok) {
            throw new Error(typeof result.error === "string"
                ? result.error
                : `AUTHORITY_REQUEST_FAILED:${response.status}`);
        }
        return result;
    }

    async #actor(externalId: unknown): Promise<AuthenticatedActor> {
        if (typeof externalId !== "string" || !externalId) {
            throw new Error("AUTHORITY_ACTOR_INVALID");
        }
        await initializeDatabase();
        const result = await db.query<{ id: number | string; external_id: string; name: string }>(
            "SELECT id, external_id, name FROM actors WHERE external_id = $1",
            [externalId],
        );
        const actor = result.rows[0];
        if (!actor) throw new Error("ACTOR_NOT_FOUND");
        return {
            actor_id: Number(actor.id),
            actor_external_id: actor.external_id,
            actor_name: actor.name,
            key_id: "roost-sso-authority",
        };
    }

    async bind(identity: OpenAITunnelIdentity, bindingId: string) {
        if (!/^rsb_[0-9a-f-]{36}$/.test(bindingId)) throw new Error("SSO_BINDING_INVALID");
        const result = await this.#call(`/v1/internal/service-bindings/${bindingId}/consume`, {
            target_conversation_id: conversation(identity),
            audience: "context-server",
        });
        const binding = result.binding as AuthorityResponse | undefined;
        return this.#actor(binding?.actor_id);
    }

    async activate(identity: OpenAITunnelIdentity) {
        const result = await this.#call("/v1/internal/service-bindings/consume-pending", {
            target_conversation_id: conversation(identity),
            audience: "context-server",
        });
        const binding = result.binding as AuthorityResponse | undefined;
        return this.#actor(binding?.actor_id);
    }

    async authorize(identity: OpenAITunnelIdentity) {
        const result = await this.#call("/v1/internal/authorize", {
            target_conversation_id: conversation(identity),
            audience: "context-server",
            required_capabilities: [],
        });
        const authorization = result.authorization as AuthorityResponse | undefined;
        return this.#actor(authorization?.actor_id);
    }
}

export function configuredContextAuthority() {
    const configuredKeyPath = process.env.ROOST_SSO_OPERATOR_KEY_PATH?.trim();
    const trustedTunnelIdentity = process.env.TRUST_OPENAI_TUNNEL_IDENTITY === "true";
    const defaultKeyPath = join(
        process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config"),
        "roost-sso",
        "operator.key",
    );
    if (!configuredKeyPath && (!trustedTunnelIdentity || !existsSync(defaultKeyPath))) return undefined;
    const keyPath = configuredKeyPath || defaultKeyPath;
    return new RoostContextAuthority(
        process.env.ROOST_SSO_AUTHORITY_URL?.trim() || "http://127.0.0.1:4310",
        keyPath,
    );
}
