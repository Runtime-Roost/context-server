import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
    authenticateRequest,
    type RequestAuthProof,
} from "../auth/request-auth.js";
import {
    authenticateOpenAITunnelActorSession,
    claimActorSession,
    getActorSessionRequestStatus,
    requestActorSession,
} from "../auth/actor-sessions.js";
import {
    CHANNEL_ROLE_VALUES,
    SEARCH_SENSITIVITY_VALUES,
    WRITABLE_CONTEXT_VISIBILITY_VALUES,
    actorPurgeConfirm,
    actorPurgePreview,
    addChannelMember,
    createChannel,
    deleteContext,
    deleteChannelContext,
    contextPurgeConfirm,
    contextPurgePreview,
    getContext,
    getChannelContext,
    getDatabaseMetadata,
    getUserProfile,
    identifyActor,
    listRecentContext,
    listActorChannels,
    listChannelContext,
    removeChannelMember,
    saveContextWithActor,
    saveChannelContext,
    searchContext,
    searchChannelContext,
    updateContext,
    updateChannelContext,
    vacuumDatabase,
} from "./tools.js";

const signedRequestAuthSchema = z.object({
    key_id: z.string().min(1).describe("Enrolled actor key identifier."),
    timestamp: z.string().min(1).describe("ISO-8601 signing timestamp within five minutes of server time."),
    nonce: z.string().min(16).max(200).describe("Unique request nonce used once per actor key."),
    signature: z.string().min(1).describe("Base64url Ed25519 signature over the documented canonical request."),
});
const actorSessionAuthSchema = z.object({
    session_id: z.string().min(1).describe("Operator-approved actor session identifier."),
    session_token: z.string().min(32).describe("Opaque actor session capability returned once by claim_actor_session."),
    timestamp: z.string().min(1).describe("ISO-8601 request timestamp within five minutes of server time."),
    nonce: z.string().min(16).max(200).describe("Unique request nonce used once per actor session."),
});
const requestAuthSchema = z.union([
    signedRequestAuthSchema,
    actorSessionAuthSchema,
]);

function authenticationError(error: unknown) {
    const candidate = error instanceof Error ? error.message : "AUTHENTICATION_FAILED";
    const exposedCodes = new Set([
        "AUTHENTICATION_FAILED",
        "CHANNEL_NOT_FOUND_OR_NOT_AUTHORIZED",
        "CHANNEL_OWNER_CANNOT_BE_REMOVED",
        "ACTOR_NOT_FOUND",
        "ACTOR_SESSION_REQUEST_NOT_FOUND",
        "ACTOR_SESSION_REQUEST_REJECTED",
        "SESSION_REVOKED",
        "AUTHENTICATION_REQUIRED",
    ]);
    const code = exposedCodes.has(candidate) ? candidate : "REQUEST_REJECTED";

    return {
        isError: true,
        content: [
            {
                type: "text" as const,
                text: JSON.stringify({
                    error: {
                        code,
                        message: code === "AUTHENTICATION_FAILED"
                            ? "The signed request could not be authenticated."
                            : code === "AUTHENTICATION_REQUIRED"
                                ? "Authenticate this OpenAI session with an approved one-time PIN, or provide explicit cryptographic authentication."
                            : code === "SESSION_REVOKED"
                                ? "This actor session was revoked because a newer session became the actor's current timeline."
                            : code === "CHANNEL_NOT_FOUND_OR_NOT_AUTHORIZED"
                                ? "The channel was not found or the authenticated actor is not authorized."
                                : code === "REQUEST_REJECTED"
                                    ? "The request was rejected."
                                    : code === "ACTOR_SESSION_REQUEST_NOT_FOUND"
                                        ? "The actor-session request was not found, was not approved, expired, was already claimed, or the claim code was invalid."
                                        : code === "ACTOR_SESSION_REQUEST_REJECTED"
                                            ? "The actor-session request was rejected."
                                    : candidate,
                    },
                }),
            },
        ],
    };
}

async function authenticateTool(
    tool: string,
    payload: Record<string, unknown>,
    auth: RequestAuthProof | undefined,
    extra?: { _meta?: Record<string, unknown> },
) {
    if (auth) return authenticateRequest(tool, payload, auth);
    return authenticateOpenAITunnelActorSession(openAITunnelIdentity(extra));
}

function openAITunnelIdentity(extra?: { _meta?: Record<string, unknown> }) {
    if (process.env.TRUST_OPENAI_TUNNEL_IDENTITY?.trim().toLowerCase() !== "true") {
        throw new Error("AUTHENTICATION_REQUIRED");
    }

    const subject = extra?._meta?.["openai/subject"];
    const session = extra?._meta?.["openai/session"];

    if (
        typeof subject !== "string"
        || typeof session !== "string"
        || !subject.startsWith("v1/")
        || !session.startsWith("v1/")
        || subject.length > 500
        || session.length > 500
    ) {
        throw new Error("AUTHENTICATION_REQUIRED");
    }

    return { subject, session };
}

export class ActiveActorSession {
    #actorId: number | null = null;

    get actorId() {
        return this.#actorId;
    }

    activate(actorId: number) {
        this.#actorId = actorId;
    }
}

export function requireActorIdentificationEnabled() {
    return process.env.REQUIRE_ACTOR_IDENTIFICATION?.trim().toLowerCase() === "true";
}

export function createServer() {
    const actorSession = new ActiveActorSession();
    const server = new McpServer({
        name: "personal-context-server",
        version: "0.1.0",
    });

    server.registerTool(
        "ping",
        {
            description: "Returns pong."
        },
        async () => {
            return {
                content: [
                    {
                        type: "text",
                        text: "Pong!",
                    },
                ],
            };
        }
    );

    server.registerTool(
        "identify_actor",
        {
            description: "Resolve or create an actor and make it active for subsequent saves in this MCP session. Durable external IDs should identify an operational actor category, such as actor:openai:codex, rather than a model version or conversation.",
            inputSchema: {
                external_id: z.string().min(1).optional().describe("Optional stable actor identifier. Without one, a distinct actor is always created."),
                name: z.string().min(1).describe("Display name for a newly created actor."),
                kind: z.string().min(1).optional().describe("Optional actor category, such as ai or human."),
                metadata: z.record(z.string(), z.unknown()).optional().describe("Optional actor metadata retained for future use but not returned on context records."),
            },
        },
        async ({ external_id, name, kind, metadata }) => {
            const identified = await identifyActor({ external_id, name, kind, metadata });
            actorSession.activate(identified.actor.id);

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({ identified }),
                    },
                ],
            };
        }
    );

    server.registerTool(
        "request_actor_session",
        {
            description: "Request an operator-approved expiring actor session for a remote client that cannot hold an Ed25519 signing key. This does not authenticate the caller or grant access until a local operator approves it.",
            inputSchema: {
                actor_external_id: z.string().min(1).describe("Durable actor identity the client asks the local operator to approve."),
                client_label: z.string().min(1).max(200).optional().describe("Human-readable client or conversation label shown to the operator."),
            },
        },
        async ({ actor_external_id, client_label }, extra) => {
            try {
                const identity = process.env.TRUST_OPENAI_TUNNEL_IDENTITY?.trim().toLowerCase() === "true"
                    ? openAITunnelIdentity(extra)
                    : undefined;
                const request = await requestActorSession(
                    actor_external_id,
                    client_label,
                    identity,
                );
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({ request }),
                    }],
                };
            } catch (error) {
                return authenticationError(error);
            }
        },
    );

    server.registerTool(
        "get_actor_session_request_status",
        {
            description: "Check whether an actor-session request is pending, approved, denied, expired, or claimed. The one-time claim code is required.",
            inputSchema: {
                request_id: z.string().min(1).describe("Request identifier returned by request_actor_session."),
                claim_code: z.string().min(32).describe("Secret claim code returned with the request."),
            },
        },
        async ({ request_id, claim_code }) => {
            try {
                const request = await getActorSessionRequestStatus(request_id, claim_code);
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({ request }),
                    }],
                };
            } catch (error) {
                return authenticationError(error);
            }
        },
    );

    server.registerTool(
        "claim_actor_session",
        {
            description: "Claim a locally approved actor-session request exactly once. Returns an expiring opaque session capability; store it securely and use it in private-channel auth.",
            inputSchema: {
                request_id: z.string().min(1).describe("Approved request identifier."),
                claim_code: z.string().min(32).describe("Secret claim code returned by request_actor_session."),
            },
        },
        async ({ request_id, claim_code }) => {
            try {
                const session = await claimActorSession(request_id, claim_code);
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({ session }),
                    }],
                };
            } catch (error) {
                return authenticationError(error);
            }
        },
    );

    server.registerTool(
        "save_context",
        {
            description: "Save personal context for later retrieval. Include actor on every save unless identify_actor succeeded in this same persistent MCP session. If session continuity is uncertain, always include actor. Actor identifies who synthesized the memory; source identifies where the information came from.",
            inputSchema: {
                text: z.string().min(1).describe("The context text to save."),
                tags: z.array(z.string()).optional().describe("Optional tags for grouping or filtering the context."),
                source: z.string().optional().describe("Optional source describing where the context came from."),
                visibility: z.enum(WRITABLE_CONTEXT_VISIBILITY_VALUES).optional().describe("Visibility classification. Only whiteboard is currently writable; authenticated channel, direct, personal, and system records are staged for a later release."),
                actor: z.object({
                    external_id: z.string().min(1).describe("Stable operational actor ID, such as actor:openai:codex. Required for self-contained saves so reconnecting clients do not create duplicate anonymous actors."),
                    name: z.string().min(1).describe("Actor display name."),
                    kind: z.string().min(1).optional().describe("Optional actor category, such as ai or human."),
                    metadata: z.record(z.string(), z.unknown()).optional().describe("Optional actor metadata. Model version, client, and execution lineage belong here rather than in external_id."),
                }).optional().describe("Explicit actor identity for this save. Takes precedence over the session-active actor and survives clients that reconnect between tool calls."),
            },
        },
        async ({ text, tags, source, visibility, actor }) => {
            if (!actor && actorSession.actorId === null && requireActorIdentificationEnabled()) {
                return {
                    isError: true,
                    content: [
                        {
                            type: "text" as const,
                            text: JSON.stringify({
                                error: {
                                    code: "ACTOR_IDENTIFICATION_REQUIRED",
                                    message: "Retry save_context with an actor object. Clients that preserve MCP session continuity may instead call identify_actor first.",
                                    required_action: {
                                        tool: "save_context",
                                        include: {
                                            actor: {
                                                external_id: "actor:<provider>:<name>",
                                                name: "<display name>",
                                                kind: "ai",
                                            },
                                        },
                                    },
                                },
                            }),
                        },
                    ],
                };
            }

            const saved = await saveContextWithActor(
                text,
                tags,
                source,
                actor,
                actorSession.actorId,
                visibility,
            );

            if (saved.context.actor) {
                actorSession.activate(saved.context.actor.id);
            }

            const warning = saved.context.actor === null
                ? {
                      code: "ACTOR_NOT_IDENTIFIED",
                      message: "Saved without actor attribution. On future saves, include an actor object. Clients with persistent MCP sessions may call identify_actor first.",
                      recommended_action: {
                          tool: "save_context",
                          include: {
                              actor: {
                                  external_id: "actor:<provider>:<name>",
                                  name: "<display name>",
                                  kind: "ai",
                              },
                          },
                      },
                  }
                : undefined;

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            saved: saved.context,
                            ...(saved.actor_resolution
                                ? { actor_resolution: saved.actor_resolution }
                                : {}),
                            ...(warning ? { warning } : {}),
                        }),
                    },
                ],
            };
        }
    );

    server.registerTool(
        "search_context",
        {
            description: "Search saved personal context by query. Sensitivity controls semantic filtering strictness: low is broad, medium is balanced, and high is narrow.",
            inputSchema: {
                query: z.string().min(1).describe("The search query."),
                limit: z.number().int().positive().optional().describe("Maximum number of context items to return."),
                sensitivity: z.enum(SEARCH_SENSITIVITY_VALUES).optional().describe("Semantic filtering strictness. Low is broad (default), medium is balanced, and high is narrow and may return no results."),
                actor_external_id: z.string().min(1).optional().describe("Optional stable external actor identifier used to filter results."),
            },
        },
        async ({ query, limit, sensitivity, actor_external_id }) => {
            const selectedSensitivity = sensitivity ?? "low";
            const results = await searchContext(query, limit, selectedSensitivity, actor_external_id);

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            query,
                            limit: limit ?? 20,
                            sensitivity: selectedSensitivity,
                            ...(actor_external_id ? { actor_external_id } : {}),
                            results,
                        }),
                    },
                ],
            };
        }
    );

    server.registerTool(
        "get_user_profile",
        {
            description: "Return the active OS username alongside contexts explicitly tagged profile.",
        },
        async () => {
            const profile = await getUserProfile();

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({ profile }),
                    },
                ],
            };
        }
    );

    server.registerTool(
        "list_recent_context",
        {
            description: "List recently saved personal context items.",
            inputSchema: {
                limit: z.number().int().positive().optional().describe("Maximum number of recent context items to return."),
                actor_external_id: z.string().min(1).optional().describe("Optional stable external actor identifier used to filter results."),
            },
        },
        async ({ limit, actor_external_id }) => {
            const results = await listRecentContext(limit, actor_external_id);

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            limit: limit ?? 20,
                            ...(actor_external_id ? { actor_external_id } : {}),
                            results,
                        }),
                    },
                ],
            };
        }
    );

    server.registerTool(
        "create_channel",
        {
            description: "Create an authenticated private channel. The signing actor becomes its owner.",
            inputSchema: {
                slug: z.string().min(3).max(64).describe("Stable lowercase channel slug."),
                name: z.string().min(1).describe("Human-readable channel name."),
                description: z.string().optional().describe("Optional channel description."),
                auth: requestAuthSchema.optional().describe("Authentication using either an enrolled-key signature or an operator-approved actor session."),
            },
        },
        async ({ slug, name, description, auth }, extra) => {
            const payload = { slug, name, description };

            try {
                const authenticated = await authenticateTool("create_channel", payload, auth, extra);
                const channel = await createChannel(
                    authenticated.actor_id,
                    slug,
                    name,
                    description,
                );
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({ channel }),
                    }],
                };
            } catch (error) {
                return authenticationError(error);
            }
        },
    );

    server.registerTool(
        "add_channel_member",
        {
            description: "Add or restore a durable actor's membership in a channel. Requires an authenticated owner or admin.",
            inputSchema: {
                channel: z.string().min(3).max(64).describe("Channel slug."),
                actor_external_id: z.string().min(1).describe("Durable actor external ID to add."),
                role: z.enum(CHANNEL_ROLE_VALUES).optional().describe("Membership role. Defaults to member."),
                can_read: z.boolean().optional().describe("Whether the member may read channel history. Defaults to true."),
                can_write: z.boolean().optional().describe("Whether the member may write channel history. Defaults to true."),
                auth: requestAuthSchema.optional().describe("Authentication using either an enrolled-key signature or an operator-approved actor session."),
            },
        },
        async ({ channel, actor_external_id, role, can_read, can_write, auth }, extra) => {
            const payload = { channel, actor_external_id, role, can_read, can_write };

            try {
                const authenticated = await authenticateTool("add_channel_member", payload, auth, extra);
                const membership = await addChannelMember(
                    authenticated.actor_id,
                    channel,
                    actor_external_id,
                    role,
                    can_read,
                    can_write,
                );
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({ membership }),
                    }],
                };
            } catch (error) {
                return authenticationError(error);
            }
        },
    );

    server.registerTool(
        "remove_channel_member",
        {
            description: "Remove an actor from a channel. Requires an authenticated owner or admin; owners cannot be removed.",
            inputSchema: {
                channel: z.string().min(3).max(64).describe("Channel slug."),
                actor_external_id: z.string().min(1).describe("Durable actor external ID to remove."),
                auth: requestAuthSchema.optional().describe("Authentication using either an enrolled-key signature or an operator-approved actor session."),
            },
        },
        async ({ channel, actor_external_id, auth }, extra) => {
            const payload = { channel, actor_external_id };

            try {
                const authenticated = await authenticateTool("remove_channel_member", payload, auth, extra);
                const membership = await removeChannelMember(
                    authenticated.actor_id,
                    channel,
                    actor_external_id,
                );
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({ membership }),
                    }],
                };
            } catch (error) {
                return authenticationError(error);
            }
        },
    );

    server.registerTool(
        "list_channels",
        {
            description: "List channels available to the authenticated actor.",
            annotations: {
                title: "List My Channels",
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                auth: requestAuthSchema.optional().describe("Authentication using either an enrolled-key signature or an operator-approved actor session."),
            },
        },
        async ({ auth }, extra) => {
            try {
                const authenticated = await authenticateTool("list_channels", {}, auth, extra);
                const channels = await listActorChannels(authenticated.actor_id);
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({ channels }),
                    }],
                };
            } catch (error) {
                return authenticationError(error);
            }
        },
    );

    server.registerTool(
        "save_channel_context",
        {
            description: "Save an authenticated channel-visible context record. The verified key determines the actor attribution.",
            inputSchema: {
                channel: z.string().min(3).max(64).describe("Channel slug."),
                text: z.string().min(1).describe("Context text to save."),
                tags: z.array(z.string()).optional().describe("Optional tags."),
                source: z.string().optional().describe("Optional provenance source."),
                auth: requestAuthSchema.optional().describe("Authentication using either an enrolled-key signature or an operator-approved actor session."),
            },
        },
        async ({ channel, text, tags, source, auth }, extra) => {
            const payload = { channel, text, tags, source };

            try {
                const authenticated = await authenticateTool("save_channel_context", payload, auth, extra);
                const saved = await saveChannelContext(
                    authenticated.actor_id,
                    channel,
                    text,
                    tags,
                    source,
                );
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({ saved }),
                    }],
                };
            } catch (error) {
                return authenticationError(error);
            }
        },
    );

    server.registerTool(
        "search_channel_context",
        {
            description: "Search one channel's history after authenticating current read membership.",
            annotations: {
                title: "Search Channel History",
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                channel: z.string().min(3).max(64).describe("Channel slug."),
                query: z.string().min(1).describe("Search query."),
                limit: z.number().int().positive().optional().describe("Maximum result count."),
                sensitivity: z.enum(SEARCH_SENSITIVITY_VALUES).optional().describe("Semantic filtering strictness."),
                auth: requestAuthSchema.optional().describe("Authentication using either an enrolled-key signature or an operator-approved actor session."),
            },
        },
        async ({ channel, query, limit, sensitivity, auth }, extra) => {
            const payload = { channel, query, limit, sensitivity };

            try {
                const authenticated = await authenticateTool("search_channel_context", payload, auth, extra);
                const selectedSensitivity = sensitivity ?? "low";
                const results = await searchChannelContext(
                    authenticated.actor_id,
                    channel,
                    query,
                    limit,
                    selectedSensitivity,
                );
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({
                            channel,
                            query,
                            limit: limit ?? 20,
                            sensitivity: selectedSensitivity,
                            results,
                        }),
                    }],
                };
            } catch (error) {
                return authenticationError(error);
            }
        },
    );

    server.registerTool(
        "list_channel_context",
        {
            description: "List recent history from one channel after authenticating current read membership.",
            annotations: {
                title: "List Channel History",
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                channel: z.string().min(3).max(64).describe("Channel slug."),
                limit: z.number().int().positive().optional().describe("Maximum result count."),
                auth: requestAuthSchema.optional().describe("Authentication using either an enrolled-key signature or an operator-approved actor session."),
            },
        },
        async ({ channel, limit, auth }, extra) => {
            const payload = { channel, limit };

            try {
                const authenticated = await authenticateTool("list_channel_context", payload, auth, extra);
                const results = await listChannelContext(
                    authenticated.actor_id,
                    channel,
                    limit,
                );
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({ channel, limit: limit ?? 20, results }),
                    }],
                };
            } catch (error) {
                return authenticationError(error);
            }
        },
    );

    server.registerTool(
        "get_channel_context",
        {
            description: "Get one exact channel record after authenticating current read membership. Missing and unauthorized records both return null.",
            annotations: {
                title: "Get Channel Record",
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                id: z.number().int().positive().describe("Exact context ID."),
                auth: requestAuthSchema.optional().describe("Authentication using either an enrolled-key signature or an operator-approved actor session."),
            },
        },
        async ({ id, auth }, extra) => {
            const payload = { id };

            try {
                const authenticated = await authenticateTool("get_channel_context", payload, auth, extra);
                const context = await getChannelContext(authenticated.actor_id, id);
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({ id, context }),
                    }],
                };
            } catch (error) {
                return authenticationError(error);
            }
        },
    );

    server.registerTool(
        "update_channel_context",
        {
            description: "Update a channel record as its authenticated author or a channel owner/admin.",
            inputSchema: {
                id: z.number().int().positive().describe("Exact context ID."),
                text: z.string().min(1).optional().describe("Optional replacement text."),
                tags: z.array(z.string()).optional().describe("Optional replacement tags."),
                source: z.string().optional().describe("Optional replacement source."),
                auth: requestAuthSchema.optional().describe("Authentication using either an enrolled-key signature or an operator-approved actor session."),
            },
        },
        async ({ id, text, tags, source, auth }, extra) => {
            const payload = { id, text, tags, source };

            try {
                const authenticated = await authenticateTool("update_channel_context", payload, auth, extra);
                const updated = await updateChannelContext(
                    authenticated.actor_id,
                    id,
                    text,
                    tags,
                    source,
                );
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({ id, updated }),
                    }],
                };
            } catch (error) {
                return authenticationError(error);
            }
        },
    );

    server.registerTool(
        "delete_channel_context",
        {
            description: "Delete a channel record as its authenticated author or a channel owner/admin.",
            inputSchema: {
                id: z.number().int().positive().describe("Exact context ID."),
                auth: requestAuthSchema.optional().describe("Authentication using either an enrolled-key signature or an operator-approved actor session."),
            },
        },
        async ({ id, auth }, extra) => {
            const payload = { id };

            try {
                const authenticated = await authenticateTool("delete_channel_context", payload, auth, extra);
                const deleted = await deleteChannelContext(authenticated.actor_id, id);
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({ id, deleted }),
                    }],
                };
            } catch (error) {
                return authenticationError(error);
            }
        },
    );

    server.registerTool(
        "database_metadata",
        {
            description: "Return simple database metadata, including saved context count and storage sizes.",
        },
        async () => {
            const metadata = await getDatabaseMetadata();

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({ metadata }),
                    },
                ],
            };
        }
    );

    server.registerTool(
        "get_context",
        {
            description: "Get a saved personal context item by its exact id.",
            inputSchema: {
                id: z.number().int().positive().describe("The id of the context item to retrieve."),
            },
        },
        async ({ id }) => {
            const context = await getContext(id);

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            id,
                            context,
                        }),
                    },
                ],
            };
        }
    );

    server.registerTool(
        "delete_context",
        {
            description: "Delete a saved personal context item by id.",
            inputSchema: {
                id: z.number().int().positive().describe("The id of the context item to delete."),
            },
        },
        async ({ id }) => {
            const deleted = await deleteContext(id);

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            id,
                            deleted,
                        }),
                    },
                ],
            };
        }
    );

    server.registerTool(
        "update_context",
        {
            description: "Update a saved personal context item by id.",
            inputSchema: {
                id: z.number().int().positive().describe("The id of the context item to update."),
                text: z.string().min(1).optional().describe("Optional replacement context text."),
                tags: z.array(z.string()).optional().describe("Optional replacement tags."),
                source: z.string().optional().describe("Optional replacement source."),
                visibility: z.enum(WRITABLE_CONTEXT_VISIBILITY_VALUES).optional().describe("Optional replacement visibility. Only whiteboard is currently writable."),
            },
        },
        async ({ id, text, tags, source, visibility }) => {
            const updated = await updateContext(id, text, tags, source, visibility);

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            id,
                            updated,
                        }),
                    },
                ],
            };
        }
    );

    server.registerTool(
        "context_purge_preview",
        {
            description: "Preview how many context items would be deleted before a cutoff date. Run this before context_purge_confirm.",
            inputSchema: {
                before: z.string().min(1).describe("Delete preview cutoff. Context items created before this date or timestamp are counted."),
            },
        },
        async ({ before }) => {
            const preview = await contextPurgePreview(before);

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({ preview }),
                    },
                ],
            };
        }
    );

    server.registerTool(
        "context_purge_confirm",
        {
            description: "Delete context items created before a cutoff date. Requires a recent confirmation token and expected count from context_purge_preview.",
            inputSchema: {
                before: z.string().min(1).describe("The exact cutoff date or timestamp used for context_purge_preview."),
                confirmation_token: z.string().min(1).describe("Confirmation token returned by context_purge_preview."),
                expected_count: z.number().int().nonnegative().describe("Matched count returned by context_purge_preview."),
            },
        },
        async ({ before, confirmation_token, expected_count }) => {
            const purge = await contextPurgeConfirm(before, confirmation_token, expected_count);

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({ purge }),
                    },
                ],
            };
        }
    );

    server.registerTool(
        "actor_purge_preview",
        {
            description: "Preview deletion of old anonymous actors that have no external ID and are not referenced by any context. Durable actors are never matched. Run this before actor_purge_confirm.",
            inputSchema: {
                before: z.string().min(1).describe("Last-seen cutoff. Only anonymous, unreferenced actors last seen before this date or timestamp are counted."),
            },
        },
        async ({ before }) => {
            const preview = await actorPurgePreview(before);

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({ preview }),
                    },
                ],
            };
        }
    );

    server.registerTool(
        "actor_purge_confirm",
        {
            description: "Delete old anonymous, unreferenced actors. Requires a recent matching actor_purge_preview; actors with external IDs are never deleted.",
            inputSchema: {
                before: z.string().min(1).describe("The exact cutoff used for actor_purge_preview."),
                confirmation_token: z.string().min(1).describe("Confirmation token returned by actor_purge_preview."),
                expected_count: z.number().int().nonnegative().describe("Matched count returned by actor_purge_preview."),
            },
        },
        async ({ before, confirmation_token, expected_count }) => {
            const purge = await actorPurgeConfirm(before, confirmation_token, expected_count);

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({ purge }),
                    },
                ],
            };
        }
    );

    server.registerTool(
        "vacuum_database",
        {
            description: "Run database maintenance for the managed context tables and return metadata before and after vacuuming.",
        },
        async () => {
            const vacuum = await vacuumDatabase();

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({ vacuum }),
                    },
                ],
            };
        }
    );

    return server;
}
