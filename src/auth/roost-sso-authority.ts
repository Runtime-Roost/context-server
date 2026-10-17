import { createHash } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { db, initializeDatabase } from "../storage/db.js";
import { resolveAuthorizedPayloadContextClass } from "../storage/payload-sessions.js";
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
    authorize(identity: OpenAITunnelIdentity, tool: string, payload?: Record<string, unknown>): Promise<AuthenticatedActor>;
}

const SUPERVISOR_CAPABILITY = "context.supervisor.read";
const WHITEBOARD_READ_CAPABILITIES = ["context.whiteboard.read", SUPERVISOR_CAPABILITY];
const WHITEBOARD_WRITE_CAPABILITIES = ["context.whiteboard.write"];
const CHANNEL_READ_CAPABILITIES = ["context.channel.read", SUPERVISOR_CAPABILITY];
const CHANNEL_WRITE_CAPABILITIES = ["context.channel.write"];
const PERSONAL_READ_CAPABILITIES = ["context.personal.read", SUPERVISOR_CAPABILITY];
const GROUP_READ_CAPABILITIES = ["context.group.read", SUPERVISOR_CAPABILITY];
const DIRECT_READ_CAPABILITIES = ["messaging.direct.read", SUPERVISOR_CAPABILITY];

// This map is the Roost boundary for every authenticated data operation. Keep
// broad/authenticated identity separate from each operation's resource scope.
// Unknown tools fail closed below rather than inheriting an accidental allow.
const TOOL_CAPABILITIES: Readonly<Record<string, readonly string[]>> = {
    search_context: WHITEBOARD_READ_CAPABILITIES,
    assemble_context: WHITEBOARD_READ_CAPABILITIES,
    get_user_profile: ["context.admin.read", SUPERVISOR_CAPABILITY],
    list_recent_context: WHITEBOARD_READ_CAPABILITIES,
    save_context: WHITEBOARD_WRITE_CAPABILITIES,
    update_context: WHITEBOARD_WRITE_CAPABILITIES,
    delete_context: WHITEBOARD_WRITE_CAPABILITIES,
    connect_contexts: WHITEBOARD_WRITE_CAPABILITIES,
    disconnect_contexts: WHITEBOARD_WRITE_CAPABILITIES,
    update_context_lifecycle: WHITEBOARD_WRITE_CAPABILITIES,
    acknowledge_context: WHITEBOARD_WRITE_CAPABILITIES,
    preview_auto_archive: WHITEBOARD_READ_CAPABILITIES,
    confirm_auto_archive: WHITEBOARD_WRITE_CAPABILITIES,
    context_purge_preview: ["context.whiteboard.purge"],
    context_purge_confirm: ["context.whiteboard.purge"],

    create_channel: ["context.channel.manage"],
    add_channel_member: ["context.channel.manage"],
    remove_channel_member: ["context.channel.manage"],
    list_channels: CHANNEL_READ_CAPABILITIES,
    search_channel_context: CHANNEL_READ_CAPABILITIES,
    list_channel_context: CHANNEL_READ_CAPABILITIES,
    get_channel_context: CHANNEL_READ_CAPABILITIES,
    save_channel_context: CHANNEL_WRITE_CAPABILITIES,
    update_channel_context: CHANNEL_WRITE_CAPABILITIES,
    delete_channel_context: CHANNEL_WRITE_CAPABILITIES,

    create_access_group: ["context.access_group.manage"],
    add_access_group_member: ["context.access_group.manage"],
    remove_access_group_member: ["context.access_group.manage"],
    list_access_groups: ["context.access_group.read", SUPERVISOR_CAPABILITY],
    search_group_context: GROUP_READ_CAPABILITIES,
    list_group_context: GROUP_READ_CAPABILITIES,
    get_group_context: GROUP_READ_CAPABILITIES,
    save_group_context: ["context.group.write"],
    update_group_context: ["context.group.write"],
    delete_group_context: ["context.group.write"],

    send_direct_context: ["messaging.direct.send"],
    list_direct_inbox: DIRECT_READ_CAPABILITIES,
    get_direct_context: DIRECT_READ_CAPABILITIES,
    acknowledge_direct_context: ["messaging.direct.acknowledge"],

    save_personal_context: ["context.personal.write"],
    search_personal_context: PERSONAL_READ_CAPABILITIES,
    list_personal_context: PERSONAL_READ_CAPABILITIES,
    get_personal_context: PERSONAL_READ_CAPABILITIES,
    update_personal_context: ["context.personal.write"],
    delete_personal_context: ["context.personal.write"],
    get_write_receipt: ["context.write_receipt.read", SUPERVISOR_CAPABILITY],

    start_context_payload_job: ["context.payload.job.start"],
    get_context_job: ["context.payload.job.read", SUPERVISOR_CAPABILITY],
    cancel_context_job: ["context.payload.job.cancel"],
    begin_payload_upload: ["context.payload.write"],
    append_payload_chunk: ["context.payload.write"],
    finalize_payload_upload: ["context.payload.write"],
    attach_payload_to_context: ["context.payload.attach"],

    database_metadata: ["context.admin.read", SUPERVISOR_CAPABILITY],
    actor_purge_preview: ["context.admin.purge"],
    actor_purge_confirm: ["context.admin.purge"],
    vacuum_database: ["context.admin.maintenance"],

    begin_attachment_upload: ["context.attachment.write"],
    append_attachment_chunk: ["context.attachment.write"],
    cancel_attachment_upload: ["context.attachment.write"],
    finalize_attachment_upload: ["context.attachment.write"],
    link_attachment_to_context: ["context.attachment.write"],
    delete_attachment: ["context.attachment.write"],
    get_attachment_quota: ["context.attachment.read", SUPERVISOR_CAPABILITY],
    get_attachment: ["context.attachment.read", SUPERVISOR_CAPABILITY],
    list_attachments: ["context.attachment.read", SUPERVISOR_CAPABILITY],
    read_attachment_chunk: ["context.attachment.read", SUPERVISOR_CAPABILITY],
    list_context_attachments: ["context.attachment.read", SUPERVISOR_CAPABILITY],
};

function readCapabilitiesForClass(contextClass: unknown): readonly string[] | undefined {
    switch (contextClass) {
        case "whiteboard": return WHITEBOARD_READ_CAPABILITIES;
        case "channel": return CHANNEL_READ_CAPABILITIES;
        case "personal": return PERSONAL_READ_CAPABILITIES;
        case "group": return GROUP_READ_CAPABILITIES;
        case "direct": return DIRECT_READ_CAPABILITIES;
        default: return undefined;
    }
}

function requiredCapabilitiesForTool(tool: string, payload: Record<string, unknown>) {
    if (tool === "get_context") return readCapabilitiesForClass(payload.class ?? "whiteboard");
    if (tool === "read_payload") return readCapabilitiesForClass(payload.class);
    return TOOL_CAPABILITIES[tool];
}

export function enforceRoostToolCapability(
    capabilities: unknown,
    tool: string,
    payload: Record<string, unknown> = {},
) {
    if (!Array.isArray(capabilities) || !capabilities.every((value) => typeof value === "string")) {
        throw new Error("AUTHORITY_CAPABILITIES_INVALID");
    }

    const requiredCapabilities = requiredCapabilitiesForTool(tool, payload);
    if (!requiredCapabilities) throw new Error("CAPABILITY_REQUIRED");

    const granted = new Set(capabilities);
    if (!requiredCapabilities.some((capability) => granted.has(capability))) {
        throw new Error("CAPABILITY_REQUIRED");
    }
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

    async authorize(identity: OpenAITunnelIdentity, tool: string, payload: Record<string, unknown> = {}) {
        const result = await this.#call("/v1/internal/authorize", {
            target_conversation_id: conversation(identity),
            audience: "context-server",
            required_capabilities: [],
        });
        const authorization = result.authorization as AuthorityResponse | undefined;
        const actor = await this.#actor(authorization?.actor_id);
        let scopedPayload = payload;
        if (tool === "read_payload") {
            const payloadRef = payload.payload_ref;
            if (typeof payloadRef !== "string") throw new Error("CAPABILITY_REQUIRED");
            const contextClass = await resolveAuthorizedPayloadContextClass(actor.actor_id, payloadRef);
            if (!contextClass) throw new Error("CAPABILITY_REQUIRED");
            scopedPayload = { ...payload, class: contextClass };
        }
        enforceRoostToolCapability(authorization?.capabilities, tool, scopedPayload);
        return actor;
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
