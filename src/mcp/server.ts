import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
    authenticateRequest,
    type RequestAuthProof,
} from "../auth/request-auth.js";
import {
    authenticateOpenAITunnelActorSession,
    bindLatestRoostSsoServiceSession,
    bindRoostSsoServiceSession,
    claimActorSession,
    getActorSessionRequestStatus,
    renewActorSession,
    requestActorSession,
} from "../auth/actor-sessions.js";
import {
    ACCESS_GROUP_ROLE_VALUES,
    CHANNEL_ROLE_VALUES,
    CONTEXT_LIFECYCLE_STATE_VALUES,
    SEARCH_SENSITIVITY_VALUES,
    type ContextRecord,
    WRITABLE_CONTEXT_VISIBILITY_VALUES,
    acknowledgeContextWithActor,
    acknowledgeDirectContext,
    actorPurgeConfirm,
    actorPurgePreview,
    assembleContext,
    addAccessGroupMember,
    addChannelMember,
    createChannel,
    createAccessGroup,
    connectContexts,
    confirmAutoArchive,
    deleteContext,
    deleteChannelContext,
    deletePersonalContext,
    deleteGroupContext,
    disconnectContexts,
    contextPurgeConfirm,
    contextPurgePreview,
    getContext,
    getDirectContext,
    getChannelContext,
    getPersonalContext,
    getGroupContext,
    getDatabaseMetadata,
    getUserProfile,
    identifyActor,
    listRecentContext,
    listDirectInbox,
    listActorChannels,
    listChannelContext,
    listPersonalContext,
    listActorAccessGroups,
    listGroupContext,
    previewAutoArchive,
    removeAccessGroupMember,
    removeChannelMember,
    saveContextWithActor,
    saveDirectContext,
    saveChannelContext,
    savePersonalContext,
    saveGroupContext,
    searchContext,
    searchChannelContext,
    searchPersonalContext,
    searchGroupContext,
    updateContext,
    updateChannelContext,
    updatePersonalContext,
    updateGroupContext,
    updateContextLifecycle,
    vacuumDatabase,
} from "./tools.js";
import {
    ATTACHMENT_RELATIONSHIP_VALUES,
    ATTACHMENT_SCOPE_VALUES,
    appendAttachmentChunk,
    beginAttachmentUpload,
    cancelAttachmentUpload,
    deleteAttachment,
    finalizeAttachmentUpload,
    getAttachment,
    getAttachmentQuota,
    linkAttachmentToContext,
    linkPayloadToContext,
    listAttachments,
    listContextAttachments,
    readAttachmentChunk,
} from "../storage/attachments.js";

const DEFAULT_CONTEXT_RESULT_LIMIT = 5;
const MAX_CONTEXT_RESULT_CONTENT_CHARS = 500;
const MAX_CONTEXT_RESULT_PAYLOAD_CHARS = 24_000;
const LIST_CONTEXT_EXCERPT_CHARS = 500;

function emitPrivateReadReceipt(
    receiptId: string,
    tool: "search_personal_context" | "list_personal_context" | "get_personal_context",
    stage: "received" | "authenticated" | "completed" | "rejected",
    details: Record<string, string | number | boolean | null> = {},
) {
    console.error(JSON.stringify({
        event: "context_server_private_read_receipt",
        receipt_id: receiptId,
        tool,
        stage,
        ...details,
    }));
}

type ProjectedContextRecord = ContextRecord & {
    content_length?: number;
    content_truncated?: boolean;
};

export function projectContextResults(
    records: ContextRecord[],
    mode: "search" | "list",
) {
    const projected: ProjectedContextRecord[] = [];
    let payloadChars = 0;
    let responseTruncated = false;

    for (const record of records) {
        const contentLimit = mode === "list"
            ? LIST_CONTEXT_EXCERPT_CHARS
            : MAX_CONTEXT_RESULT_CONTENT_CHARS;
        const contentTruncated = record.content.length > contentLimit;
        const candidate: ProjectedContextRecord = {
            ...record,
            content: contentTruncated
                ? record.content.slice(0, contentLimit)
                : record.content,
            ...(contentTruncated
                ? {
                    content_length: record.content.length,
                    content_truncated: true,
                }
                : {}),
        };
        const candidateChars = JSON.stringify(candidate).length;

        if (payloadChars + candidateChars > MAX_CONTEXT_RESULT_PAYLOAD_CHARS) {
            responseTruncated = true;
            break;
        }

        projected.push(candidate);
        payloadChars += candidateChars;
    }

    return {
        results: projected,
        response_truncated: responseTruncated || projected.length < records.length,
        returned_count: projected.length,
    };
}

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
const subjectIdentitySchema = z.object({
    external_id: z.string().regex(/^subject:[a-z0-9][a-z0-9:_-]*$/),
    name: z.string().min(1).max(500),
    kind: z.string().min(1).max(100).optional(),
    aliases: z.array(z.string().min(1).max(500)).max(100).optional(),
});

function authenticationError(error: unknown, safeDetails?: { actor_external_id?: string }) {
    const candidate = error instanceof Error ? error.message : "AUTHENTICATION_FAILED";
    const exposedCodes = new Set([
        "AUTHENTICATION_FAILED",
        "CHANNEL_NOT_FOUND_OR_NOT_AUTHORIZED",
        "CHANNEL_OWNER_CANNOT_BE_REMOVED",
        "ACCESS_GROUP_NOT_FOUND_OR_NOT_AUTHORIZED",
        "ACCESS_GROUP_OWNER_CANNOT_BE_REMOVED",
        "ACTOR_NOT_FOUND",
        "ACTOR_SESSION_REQUEST_NOT_FOUND",
        "ACTOR_SESSION_PENDING_LIMIT_REACHED",
        "SESSION_REVOKED",
        "SESSION_RENEWAL_NOT_ALLOWED",
        "AUTHENTICATION_REQUIRED",
        "SSO_BINDING_INVALID",
        "ATTACHMENT_UPLOAD_NOT_FOUND_OR_NOT_AUTHORIZED",
        "ATTACHMENT_UPLOAD_INCOMPLETE",
        "ATTACHMENT_INTEGRITY_MISMATCH",
        "ATTACHMENT_OFFSET_INVALID",
        "ATTACHMENT_CHUNK_INVALID",
        "ATTACHMENT_SCOPE_INVALID",
        "ATTACHMENT_QUOTA_EXCEEDED",
        "ATTACHMENT_QUOTA_CONFIG_INVALID",
        "CONTEXT_NOT_FOUND_OR_NOT_AUTHORIZED",
        "CONTEXT_CONNECTION_SCOPE_MISMATCH",
        "CONTEXT_CONNECTION_RELATIONSHIP_INVALID",
        "CONTEXT_CONNECTION_RATIONALE_INVALID",
        "CONTEXT_CONNECTION_SELF_REFERENCE",
        "CONTEXT_LIFECYCLE_UPDATE_REQUIRED",
        "CONTEXT_IMPORTANCE_INVALID",
        "CONTEXT_SUPERSESSION_SELF_REFERENCE",
        "AUTO_ARCHIVE_SELECTION_INVALID",
        "AUTO_ARCHIVE_PREVIEW_INVALID",
        "AUTO_ARCHIVE_CANDIDATE_CHANGED",
        "CONTEXT_ASSEMBLY_QUERY_REQUIRED",
        "PAYLOAD_REFERENCE_INVALID",
        "PAYLOAD_DERIVATION_SOURCE_REQUIRED",
        "PAYLOAD_DERIVATION_SOURCE_INVALID",
        "PAYLOAD_NOT_FOUND_OR_NOT_AUTHORIZED",
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
                        ...(code === "ACTOR_NOT_FOUND" && safeDetails?.actor_external_id
                            ? { actor_external_id: safeDetails.actor_external_id }
                            : {}),
                        message: code === "AUTHENTICATION_FAILED"
                            ? "The signed request could not be authenticated."
                            : code === "AUTHENTICATION_REQUIRED"
                                ? process.env.TRUST_OPENAI_TUNNEL_IDENTITY?.trim().toLowerCase() === "true"
                                    ? "This OpenAI conversation does not have an active local actor-session approval. Call request_actor_session once, ask the operator to approve that exact request in Agent Companion, and wait for approval to activate automatically. Do not use a PIN, call claim_actor_session, or retry protected tools before approval."
                                    : "Provide explicit cryptographic authentication or request and claim an operator-approved native actor session."
                            : code === "SESSION_REVOKED"
                                ? "This actor session was revoked because a newer session became the actor's current timeline."
                            : code === "SSO_BINDING_INVALID"
                                ? "The Roost SSO handoff is invalid, expired, already consumed, or its approved source session is no longer active."
                            : code === "CHANNEL_NOT_FOUND_OR_NOT_AUTHORIZED"
                                ? "The channel was not found or the authenticated actor is not authorized."
                                : code === "ACCESS_GROUP_NOT_FOUND_OR_NOT_AUTHORIZED"
                                    ? "The access group was not found or the authenticated actor is not authorized."
                                : code === "REQUEST_REJECTED"
                                    ? "The request was rejected."
                                    : code === "ACTOR_SESSION_REQUEST_NOT_FOUND"
                                        ? "The actor-session request was not found, was not approved, expired, was already claimed, or the claim code was invalid."
                                        : code === "ACTOR_NOT_FOUND"
                                            ? "No durable actor matches the supplied actor_external_id. Use the exact canonical actor identity assigned by the operator; a display name or human name is not an actor identity."
                                        : code === "ACTOR_SESSION_PENDING_LIMIT_REACHED"
                                            ? "This actor already has the maximum number of unexpired pending or approved actor-session requests. Complete, deny, or allow those requests to expire before trying again."
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

function requireContextAuthentication() {
    return process.env.REQUIRE_CONTEXT_AUTHENTICATION?.trim().toLowerCase() !== "false";
}

async function authenticateContextTool(
    tool: string,
    payload: Record<string, unknown>,
    extra?: { _meta?: Record<string, unknown> },
) {
    return requireContextAuthentication()
        ? authenticateTool(tool, payload, undefined, extra)
        : null;
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

export type ContextServerSurface = "full" | "conversation";

const CONVERSATION_TOOL_NAMES = new Set([
    "request_actor_session",
    "bind_sso_session",
    "get_actor_session_request_status",
    "save_context",
    "search_context",
    "assemble_context",
    "get_context",
    "save_channel_context",
    "search_channel_context",
    "get_channel_context",
    "save_personal_context",
    "search_personal_context",
    "get_personal_context",
    "send_direct_context",
    "list_direct_inbox",
    "acknowledge_direct_context",
]);

function applyToolSurface(server: McpServer, surface: ContextServerSurface) {
    if (surface === "full") return;

    const registry = (server as unknown as {
        _registeredTools: Record<string, RegisteredTool>;
    })._registeredTools;

    for (const [name, tool] of Object.entries(registry)) {
        if (!CONVERSATION_TOOL_NAMES.has(name)) tool.disable();
    }
}

export function createServer(options: { surface?: ContextServerSurface } = {}) {
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
            description: process.env.TRUST_OPENAI_TUNNEL_IDENTITY?.trim().toLowerCase() === "true"
                ? "Request local approval for this exact OpenAI conversation. Approval activates a renewable trusted-thread lease automatically; do not call claim_actor_session, renew_actor_session, or provide an auth object afterward."
                : "Request an operator-approved renewable actor-session lease for a native client that cannot hold an Ed25519 signing key. Keep the returned claim code private, then use it after local approval with claim_actor_session.",
            annotations: {
                title: "Request Actor Session Approval",
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: false,
            },
            inputSchema: {
                actor_external_id: z.string().min(1).max(200).describe("Exact canonical durable actor identity the client asks the local operator to approve. Display names and human names are not actor identities."),
                client_label: z.string().min(1).max(200).optional().describe("Human-readable client or conversation label shown to the operator."),
            },
        },
        async ({ actor_external_id, client_label }, extra) => {
            try {
                const identity = process.env.TRUST_OPENAI_TUNNEL_IDENTITY?.trim().toLowerCase() === "true"
                    ? openAITunnelIdentity(extra)
                    : undefined;
                if (client_label === "Roost SSO Context binding") {
                    if (!identity) throw new Error("AUTHENTICATION_REQUIRED");
                    const authenticated = await bindLatestRoostSsoServiceSession(
                        identity, actor_external_id,
                    );
                    actorSession.activate(authenticated.actor_id);
                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({
                                request: {
                                    status: "claimed",
                                    authentication: "roost_sso_service_binding",
                                    actor_external_id: authenticated.actor_external_id,
                                    actor_name: authenticated.actor_name,
                                    next_action: "The current Context Server conversation is authenticated. Retry the intended protected tool without an auth object.",
                                },
                            }),
                        }],
                    };
                }
                const handoff = client_label?.match(/^roost-sso:(asb_[0-9a-f-]{36})$/)?.[1];
                if (handoff) {
                    if (!identity) throw new Error("AUTHENTICATION_REQUIRED");
                    const authenticated = await bindRoostSsoServiceSession(identity, handoff);
                    if (authenticated.actor_external_id !== actor_external_id) {
                        throw new Error("SSO_BINDING_INVALID");
                    }
                    actorSession.activate(authenticated.actor_id);
                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({
                                request: {
                                    status: "claimed",
                                    authentication: "roost_sso_service_binding",
                                    actor_external_id: authenticated.actor_external_id,
                                    actor_name: authenticated.actor_name,
                                    next_action: "The current Context Server conversation is authenticated. Retry the intended protected tool without an auth object.",
                                },
                            }),
                        }],
                    };
                }
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
                return authenticationError(error, { actor_external_id });
            }
        },
    );

    server.registerTool(
        "bind_sso_session",
        {
            description: "Consume a one-use, Context Server-specific handoff issued by Roost SSO after operator approval. The trusted tunnel supplies this server's actor-session binding; the model cannot select an actor or reuse the handoff.",
            annotations: {
                title: "Bind Approved Roost SSO Session",
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: false,
            },
            inputSchema: {
                binding_handle: z.string().regex(/^asb_[0-9a-f-]{36}$/)
                    .describe("One-use Context Server handoff returned by Roost SSO."),
            },
        },
        async ({ binding_handle }, extra) => {
            try {
                const authenticated = await bindRoostSsoServiceSession(
                    openAITunnelIdentity(extra), binding_handle,
                );
                actorSession.activate(authenticated.actor_id);
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({
                            bound: true,
                            actor_external_id: authenticated.actor_external_id,
                            actor_name: authenticated.actor_name,
                            next_action: "The current Context Server conversation is authenticated. Call the intended protected tool without an auth object.",
                        }),
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
            description: "Native-client flow only: check whether an actor-session request is pending, approved, denied, expired, or claimed using its one-time claim code. Trusted OpenAI tunnel conversations activate during local approval and must not call this tool.",
            annotations: {
                title: "Check Actor Session Request",
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
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
            description: "Native-client flow only: claim a locally approved actor-session request exactly once and receive an expiring capability for explicit auth. Trusted OpenAI tunnel conversations activate during local approval and must not call this tool or receive the capability.",
            annotations: {
                title: "Claim Approved Actor Session",
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: false,
            },
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
        "renew_actor_session",
        {
            description: "Native-client flow only: renew the current unrevoked actor-session lease for 30 days and atomically rotate its bearer token. The previous token stops working immediately. Trusted OpenAI conversations renew their bound lease automatically during authenticated use and must not call this tool.",
            annotations: {
                title: "Renew Actor Session Lease",
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: false,
            },
            inputSchema: {
                auth: actorSessionAuthSchema.describe("Current native actor-session capability. A successful renewal returns its replacement token exactly once."),
            },
        },
        async ({ auth }) => {
            try {
                const session = await renewActorSession(auth);
                return {
                    content: [{ type: "text", text: JSON.stringify({ session }) }],
                };
            } catch (error) {
                return authenticationError(error);
            }
        },
    );

    server.registerTool(
        "save_context",
        {
            description: "Save shared Whiteboard context. Actor is the author, source is provenance, and subject is the optional topic.",
            inputSchema: {
                text: z.string().min(1).describe("The context text to save."),
                tags: z.array(z.string()).optional().describe("Optional tags for grouping or filtering the context."),
                source: z.string().optional().describe("Optional source describing where the context came from."),
                visibility: z.enum(WRITABLE_CONTEXT_VISIBILITY_VALUES).optional().describe("Visibility classification. Only whiteboard is writable through this general tool; authenticated channel, personal, and access-group records use dedicated tools, while direct and system records remain staged."),
                actor: z.object({
                    external_id: z.string().min(1).describe("Stable actor ID, such as actor:openai:codex."),
                    name: z.string().min(1).describe("Actor display name."),
                    kind: z.string().min(1).optional().describe("Optional actor category, such as ai or human."),
                    metadata: z.record(z.string(), z.unknown()).optional().describe("Optional non-identity actor metadata."),
                }).optional().describe("Explicit author identity; overrides the session actor."),
                subject: subjectIdentitySchema.optional().describe("Optional topic; never grants access."),
            },
        },
        async ({ text, tags, source, visibility, actor, subject }, extra) => {
            let authenticated;
            try {
                authenticated = await authenticateContextTool("save_context", { text, tags, source, visibility, subject }, extra);
            } catch (error) {
                return authenticationError(error);
            }
            const effectiveActor = authenticated ? undefined : actor;
            const effectiveActorId = authenticated?.actor_id ?? actorSession.actorId;
            if (!authenticated && !actor && actorSession.actorId === null && requireActorIdentificationEnabled()) {
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
                effectiveActor,
                effectiveActorId,
                visibility,
                subject,
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
                            ...(saved.subject_resolution
                                ? { subject_resolution: saved.subject_resolution }
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
            description: "Read semantically matching notes from the local shared Whiteboard. Defaults to high sensitivity and five results to avoid injecting unrelated history. Use low or medium only when the user explicitly asks for a broader search.",
            annotations: {
                title: "Search Shared Whiteboard",
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                query: z.string().min(1).describe("The search query."),
                limit: z.number().int().positive().optional().describe("Maximum number of context items to return."),
                sensitivity: z.enum(SEARCH_SENSITIVITY_VALUES).optional().describe("Semantic filtering strictness. High is the safe default and may return no results; medium and low progressively broaden retrieval."),
                actor_external_id: z.string().min(1).optional().describe("Optional stable external actor identifier used to filter results."),
            },
        },
        async ({ query, limit, sensitivity, actor_external_id }, extra) => {
            try {
                await authenticateContextTool("search_context", { query, limit, sensitivity, actor_external_id }, extra);
            } catch (error) {
                return authenticationError(error);
            }
            const selectedSensitivity = sensitivity ?? "high";
            const results = await searchContext(query, limit, selectedSensitivity, actor_external_id);
            const projected = projectContextResults(results, "search");

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            query,
                            limit: limit ?? DEFAULT_CONTEXT_RESULT_LIMIT,
                            sensitivity: selectedSensitivity,
                            ...(actor_external_id ? { actor_external_id } : {}),
                            ...projected,
                        }),
                    },
                ],
            };
        }
    );

    server.registerTool(
        "assemble_context",
        {
            description: "Build a bounded authenticated context pack from matching envelopes plus one-hop graph neighbors, hydrating only a few selected payloads.",
            annotations: { title: "Assemble Context", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
            inputSchema: {
                query: z.string().min(1).max(2000),
                limit: z.number().int().min(1).max(20).optional(),
                hydrate_limit: z.number().int().min(0).max(5).optional(),
                max_content_chars: z.number().int().min(1000).max(48000).optional(),
            },
        },
        async ({ query, limit, hydrate_limit, max_content_chars }, extra) => {
            const payload = { query, limit, hydrate_limit, max_content_chars };
            try {
                const authenticated = await authenticateTool("assemble_context", payload, undefined, extra);
                const assembly = await assembleContext(authenticated.actor_id, query, {
                    limit, hydrateLimit: hydrate_limit, maxContentChars: max_content_chars,
                });
                return { content: [{ type: "text", text: JSON.stringify({ assembly }) }] };
            } catch (error) {
                return authenticationError(error);
            }
        },
    );

    server.registerTool(
        "get_user_profile",
        {
            description: "Read the local shared Whiteboard notes explicitly tagged profile, plus the local OS username. This does not modify data or contact external services.",
            annotations: {
                title: "Read Shared User Profile",
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
        },
        async (extra) => {
            try {
                await authenticateContextTool("get_user_profile", {}, extra);
            } catch (error) {
                return authenticationError(error);
            }
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
            description: "Read compact excerpts of the newest notes from the local shared Whiteboard. Use get_context for one complete record.",
            annotations: {
                title: "List Recent Shared Whiteboard Notes",
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                limit: z.number().int().positive().optional().describe("Maximum number of recent context items to return."),
                actor_external_id: z.string().min(1).optional().describe("Optional stable external actor identifier used to filter results."),
            },
        },
        async ({ limit, actor_external_id }, extra) => {
            try {
                await authenticateContextTool("list_recent_context", { limit, actor_external_id }, extra);
            } catch (error) {
                return authenticationError(error);
            }
            const results = await listRecentContext(limit, actor_external_id);
            const projected = projectContextResults(results, "list");

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            limit: limit ?? DEFAULT_CONTEXT_RESULT_LIMIT,
                            ...(actor_external_id ? { actor_external_id } : {}),
                            ...projected,
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
            description: "Search one channel's history after authenticating current read membership. Defaults to high sensitivity and five results to avoid injecting unrelated history.",
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
                const selectedSensitivity = sensitivity ?? "high";
                const results = await searchChannelContext(
                    authenticated.actor_id,
                    channel,
                    query,
                    limit,
                    selectedSensitivity,
                );
                const projected = projectContextResults(results, "search");
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({
                            channel,
                            query,
                            limit: limit ?? DEFAULT_CONTEXT_RESULT_LIMIT,
                            sensitivity: selectedSensitivity,
                            ...projected,
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
            description: "List compact excerpts of recent channel history after authenticating current read membership. Use get_channel_context for one complete record.",
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
                const projected = projectContextResults(results, "list");
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({ channel, limit: limit ?? DEFAULT_CONTEXT_RESULT_LIMIT, ...projected }),
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
        "create_access_group",
        {
            description: "Create an authenticated Unix-like access group. The authenticated actor becomes its owner.",
            inputSchema: {
                slug: z.string().min(3).max(64).describe("Stable lowercase access-group slug."),
                name: z.string().min(1).describe("Human-readable access-group name."),
                description: z.string().optional().describe("Optional access-group description."),
                auth: requestAuthSchema.optional().describe("Authentication using either an enrolled-key signature or an operator-approved actor session."),
            },
        },
        async ({ slug, name, description, auth }, extra) => {
            const payload = { slug, name, description };

            try {
                const authenticated = await authenticateTool("create_access_group", payload, auth, extra);
                const group = await createAccessGroup(
                    authenticated.actor_id,
                    slug,
                    name,
                    description,
                );
                return {
                    content: [{ type: "text", text: JSON.stringify({ group }) }],
                };
            } catch (error) {
                return authenticationError(error);
            }
        },
    );

    server.registerTool(
        "add_access_group_member",
        {
            description: "Add or restore a durable actor's access-group membership. Requires an authenticated owner or admin.",
            inputSchema: {
                group: z.string().min(3).max(64).describe("Access-group slug."),
                actor_external_id: z.string().min(1).describe("Durable actor external ID to add."),
                role: z.enum(ACCESS_GROUP_ROLE_VALUES).optional().describe("Membership role. Defaults to member."),
                can_read: z.boolean().optional().describe("Whether the member may read group-owned records. Defaults to true."),
                can_write: z.boolean().optional().describe("Whether the member may write group-owned records. Defaults to true."),
                auth: requestAuthSchema.optional().describe("Authentication using either an enrolled-key signature or an operator-approved actor session."),
            },
        },
        async ({ group, actor_external_id, role, can_read, can_write, auth }, extra) => {
            const payload = { group, actor_external_id, role, can_read, can_write };

            try {
                const authenticated = await authenticateTool("add_access_group_member", payload, auth, extra);
                const membership = await addAccessGroupMember(
                    authenticated.actor_id,
                    group,
                    actor_external_id,
                    role,
                    can_read,
                    can_write,
                );
                return {
                    content: [{ type: "text", text: JSON.stringify({ membership }) }],
                };
            } catch (error) {
                return authenticationError(error);
            }
        },
    );

    server.registerTool(
        "remove_access_group_member",
        {
            description: "Remove an actor from an access group. Requires an authenticated owner or admin; owners cannot be removed.",
            inputSchema: {
                group: z.string().min(3).max(64).describe("Access-group slug."),
                actor_external_id: z.string().min(1).describe("Durable actor external ID to remove."),
                auth: requestAuthSchema.optional().describe("Authentication using either an enrolled-key signature or an operator-approved actor session."),
            },
        },
        async ({ group, actor_external_id, auth }, extra) => {
            const payload = { group, actor_external_id };

            try {
                const authenticated = await authenticateTool("remove_access_group_member", payload, auth, extra);
                const membership = await removeAccessGroupMember(
                    authenticated.actor_id,
                    group,
                    actor_external_id,
                );
                return {
                    content: [{ type: "text", text: JSON.stringify({ membership }) }],
                };
            } catch (error) {
                return authenticationError(error);
            }
        },
    );

    server.registerTool(
        "send_direct_context",
        {
            description: "Send one authenticated direct context envelope to an existing actor. Delivery is deterministic and private; this does not use semantic search.",
            annotations: { title: "Send Direct Message", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
            inputSchema: {
                recipient_external_id: z.string().min(3).max(255).describe("Exact registered recipient actor identity."),
                text: z.string().min(1).describe("Message text."),
                tags: z.array(z.string()).optional(),
                source: z.string().optional(),
                auth: requestAuthSchema.optional().describe("Authenticated sender."),
            },
        },
        async ({ recipient_external_id, text, tags, source, auth }, extra) => {
            const payload = { recipient_external_id, text, tags, source };
            try {
                const authenticated = await authenticateTool("send_direct_context", payload, auth, extra);
                const sent = await saveDirectContext(authenticated.actor_id, recipient_external_id, text, tags, source);
                return { content: [{ type: "text", text: JSON.stringify({ sent }) }] };
            } catch (error) { return authenticationError(error); }
        },
    );

    server.registerTool(
        "list_direct_inbox",
        {
            description: "List the authenticated actor's newest direct envelopes in deterministic sequence order. Supports unread-only and since-sequence delivery without semantic search.",
            annotations: { title: "List My Direct Inbox", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
            inputSchema: {
                limit: z.number().int().positive().max(100).optional(),
                unread_only: z.boolean().optional(),
                since_sequence: z.number().int().nonnegative().optional(),
                auth: requestAuthSchema.optional().describe("Authenticated mailbox owner."),
            },
        },
        async ({ limit, unread_only, since_sequence, auth }, extra) => {
            const payload = { limit, unread_only, since_sequence };
            try {
                const authenticated = await authenticateTool("list_direct_inbox", payload, auth, extra);
                const envelopes = await listDirectInbox(authenticated.actor_id, { limit, unreadOnly: unread_only, sinceSequence: since_sequence });
                return { content: [{ type: "text", text: JSON.stringify({ envelopes, returned_count: envelopes.length }) }] };
            } catch (error) { return authenticationError(error); }
        },
    );

    server.registerTool(
        "get_direct_context",
        {
            description: "Get one exact direct envelope owned by the authenticated recipient. Missing and unauthorized records both return null.",
            annotations: { title: "Get Direct Message", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
            inputSchema: { id: z.number().int().positive(), auth: requestAuthSchema.optional() },
        },
        async ({ id, auth }, extra) => {
            try {
                const authenticated = await authenticateTool("get_direct_context", { id }, auth, extra);
                const envelope = await getDirectContext(authenticated.actor_id, id);
                return { content: [{ type: "text", text: JSON.stringify({ id, envelope }) }] };
            } catch (error) { return authenticationError(error); }
        },
    );

    server.registerTool(
        "acknowledge_direct_context",
        {
            description: "Idempotently acknowledge one direct envelope as its authenticated recipient.",
            annotations: { title: "Acknowledge Direct Message", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
            inputSchema: { id: z.number().int().positive(), auth: requestAuthSchema.optional() },
        },
        async ({ id, auth }, extra) => {
            try {
                const authenticated = await authenticateTool("acknowledge_direct_context", { id }, auth, extra);
                const result = await acknowledgeDirectContext(authenticated.actor_id, id);
                return { content: [{ type: "text", text: JSON.stringify({ id, result }) }] };
            } catch (error) { return authenticationError(error); }
        },
    );

    server.registerTool(
        "list_access_groups",
        {
            description: "List access groups available to the authenticated actor.",
            annotations: {
                title: "List My Access Groups",
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
                const authenticated = await authenticateTool("list_access_groups", {}, auth, extra);
                const groups = await listActorAccessGroups(authenticated.actor_id);
                return {
                    content: [{ type: "text", text: JSON.stringify({ groups }) }],
                };
            } catch (error) {
                return authenticationError(error);
            }
        },
    );

    server.registerTool(
        "save_group_context",
        {
            description: "Save a record owned by an access group while preserving the authenticated actor as its author.",
            inputSchema: {
                group: z.string().min(3).max(64).describe("Owning access-group slug."),
                text: z.string().min(1).describe("Context text to save."),
                tags: z.array(z.string()).optional().describe("Optional tags."),
                source: z.string().optional().describe("Optional provenance source."),
                subject: subjectIdentitySchema.optional(),
                auth: requestAuthSchema.optional().describe("Authentication using either an enrolled-key signature or an operator-approved actor session."),
            },
        },
        async ({ group, text, tags, source, subject, auth }, extra) => {
            const payload = { group, text, tags, source, subject };

            try {
                const authenticated = await authenticateTool("save_group_context", payload, auth, extra);
                const saved = await saveGroupContext(
                    authenticated.actor_id,
                    group,
                    text,
                    tags,
                    source,
                    subject,
                );
                return {
                    content: [{ type: "text", text: JSON.stringify({ saved }) }],
                };
            } catch (error) {
                return authenticationError(error);
            }
        },
    );

    server.registerTool(
        "search_group_context",
        {
            description: "Search one access group's records after authenticating current read membership. Defaults to high sensitivity and five results.",
            annotations: {
                title: "Search Group Context",
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                group: z.string().min(3).max(64).describe("Access-group slug."),
                query: z.string().min(1).describe("Search query."),
                limit: z.number().int().positive().optional().describe("Maximum result count."),
                sensitivity: z.enum(SEARCH_SENSITIVITY_VALUES).optional().describe("Semantic filtering strictness."),
                auth: requestAuthSchema.optional().describe("Authentication using either an enrolled-key signature or an operator-approved actor session."),
            },
        },
        async ({ group, query, limit, sensitivity, auth }, extra) => {
            const payload = { group, query, limit, sensitivity };

            try {
                const authenticated = await authenticateTool("search_group_context", payload, auth, extra);
                const selectedSensitivity = sensitivity ?? "high";
                const results = await searchGroupContext(
                    authenticated.actor_id,
                    group,
                    query,
                    limit,
                    selectedSensitivity,
                );
                const projected = projectContextResults(results, "search");
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({
                            group,
                            query,
                            limit: limit ?? DEFAULT_CONTEXT_RESULT_LIMIT,
                            sensitivity: selectedSensitivity,
                            ...projected,
                        }),
                    }],
                };
            } catch (error) {
                return authenticationError(error);
            }
        },
    );

    server.registerTool(
        "list_group_context",
        {
            description: "List compact excerpts of recent access-group records after authenticating current read membership. Use get_group_context for one complete record.",
            annotations: {
                title: "List Group Context",
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                group: z.string().min(3).max(64).describe("Access-group slug."),
                limit: z.number().int().positive().optional().describe("Maximum result count."),
                auth: requestAuthSchema.optional().describe("Authentication using either an enrolled-key signature or an operator-approved actor session."),
            },
        },
        async ({ group, limit, auth }, extra) => {
            const payload = { group, limit };

            try {
                const authenticated = await authenticateTool("list_group_context", payload, auth, extra);
                const results = await listGroupContext(authenticated.actor_id, group, limit);
                const projected = projectContextResults(results, "list");
                return {
                    content: [{ type: "text", text: JSON.stringify({ group, limit: limit ?? DEFAULT_CONTEXT_RESULT_LIMIT, ...projected }) }],
                };
            } catch (error) {
                return authenticationError(error);
            }
        },
    );

    server.registerTool(
        "get_group_context",
        {
            description: "Get one exact group-owned record after authenticating current read membership. Missing and unauthorized records both return null.",
            annotations: {
                title: "Get Group Context",
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
                const authenticated = await authenticateTool("get_group_context", payload, auth, extra);
                const context = await getGroupContext(authenticated.actor_id, id);
                return {
                    content: [{ type: "text", text: JSON.stringify({ id, context }) }],
                };
            } catch (error) {
                return authenticationError(error);
            }
        },
    );

    server.registerTool(
        "update_group_context",
        {
            description: "Update a group-owned record as any current member with write permission.",
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
                const authenticated = await authenticateTool("update_group_context", payload, auth, extra);
                const updated = await updateGroupContext(
                    authenticated.actor_id,
                    id,
                    text,
                    tags,
                    source,
                );
                return {
                    content: [{ type: "text", text: JSON.stringify({ id, updated }) }],
                };
            } catch (error) {
                return authenticationError(error);
            }
        },
    );

    server.registerTool(
        "delete_group_context",
        {
            description: "Delete a group-owned record as any current member with write permission.",
            inputSchema: {
                id: z.number().int().positive().describe("Exact context ID."),
                auth: requestAuthSchema.optional().describe("Authentication using either an enrolled-key signature or an operator-approved actor session."),
            },
        },
        async ({ id, auth }, extra) => {
            const payload = { id };

            try {
                const authenticated = await authenticateTool("delete_group_context", payload, auth, extra);
                const deleted = await deleteGroupContext(authenticated.actor_id, id);
                return {
                    content: [{ type: "text", text: JSON.stringify({ id, deleted }) }],
                };
            } catch (error) {
                return authenticationError(error);
            }
        },
    );

    server.registerTool(
        "save_personal_context",
        {
            description: "Save a private notebook record owned by the authenticated actor. Personal records are never exposed through whiteboard or channel tools.",
            inputSchema: {
                text: z.string().min(1).describe("Context text to save."),
                tags: z.array(z.string()).optional().describe("Optional tags."),
                source: z.string().optional().describe("Optional provenance source."),
                subject: subjectIdentitySchema.optional().describe("Optional topic; actor remains owner."),
                auth: requestAuthSchema.optional().describe("Authentication using either an enrolled-key signature or an operator-approved actor session."),
            },
        },
        async ({ text, tags, source, subject, auth }, extra) => {
            const payload = { text, tags, source, subject };

            try {
                const authenticated = await authenticateTool("save_personal_context", payload, auth, extra);
                const saved = await savePersonalContext(
                    authenticated.actor_id,
                    text,
                    tags,
                    source,
                    subject,
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
        "search_personal_context",
        {
            description: "Search only the authenticated actor's private notebook. Actor ownership is enforced before semantic ranking; retrieval defaults to high sensitivity and five results.",
            annotations: {
                title: "Search Private Notebook",
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                query: z.string().min(1).describe("Search query."),
                limit: z.number().int().positive().optional().describe("Maximum result count."),
                sensitivity: z.enum(SEARCH_SENSITIVITY_VALUES).optional().describe("Semantic filtering strictness."),
                auth: requestAuthSchema.optional().describe("Authentication using either an enrolled-key signature or an operator-approved actor session."),
            },
        },
        async ({ query, limit, sensitivity, auth }, extra) => {
            const payload = { query, limit, sensitivity };
            const receiptId = randomUUID();
            emitPrivateReadReceipt(receiptId, "search_personal_context", "received", {
                limit: limit ?? DEFAULT_CONTEXT_RESULT_LIMIT,
                sensitivity: sensitivity ?? "high",
            });

            try {
                const authenticated = await authenticateTool("search_personal_context", payload, auth, extra);
                const selectedSensitivity = sensitivity ?? "high";
                emitPrivateReadReceipt(receiptId, "search_personal_context", "authenticated", {
                    actor_id: authenticated.actor_id,
                });
                const results = await searchPersonalContext(
                    authenticated.actor_id,
                    query,
                    limit,
                    selectedSensitivity,
                );
                const projected = projectContextResults(results, "search");
                emitPrivateReadReceipt(receiptId, "search_personal_context", "completed", {
                    actor_id: authenticated.actor_id,
                    result_count: projected.results.length,
                    response_truncated: projected.response_truncated,
                });
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({
                            query,
                            limit: limit ?? DEFAULT_CONTEXT_RESULT_LIMIT,
                            sensitivity: selectedSensitivity,
                            ...projected,
                        }),
                    }],
                };
            } catch (error) {
                emitPrivateReadReceipt(receiptId, "search_personal_context", "rejected", {
                    error: error instanceof Error ? error.name : "unknown_error",
                });
                return authenticationError(error);
            }
        },
    );

    server.registerTool(
        "list_personal_context",
        {
            description: "List compact excerpts of recent private notebook records owned by the authenticated actor. Use get_personal_context for one complete record.",
            annotations: {
                title: "List Private Notebook",
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                limit: z.number().int().positive().optional().describe("Maximum result count."),
                auth: requestAuthSchema.optional().describe("Authentication using either an enrolled-key signature or an operator-approved actor session."),
            },
        },
        async ({ limit, auth }, extra) => {
            const payload = { limit };
            const receiptId = randomUUID();
            emitPrivateReadReceipt(receiptId, "list_personal_context", "received", {
                limit: limit ?? DEFAULT_CONTEXT_RESULT_LIMIT,
            });

            try {
                const authenticated = await authenticateTool("list_personal_context", payload, auth, extra);
                emitPrivateReadReceipt(receiptId, "list_personal_context", "authenticated", {
                    actor_id: authenticated.actor_id,
                });
                const results = await listPersonalContext(authenticated.actor_id, limit);
                const projected = projectContextResults(results, "list");
                emitPrivateReadReceipt(receiptId, "list_personal_context", "completed", {
                    actor_id: authenticated.actor_id,
                    result_count: projected.results.length,
                    response_truncated: projected.response_truncated,
                });
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({ limit: limit ?? DEFAULT_CONTEXT_RESULT_LIMIT, ...projected }),
                    }],
                };
            } catch (error) {
                emitPrivateReadReceipt(receiptId, "list_personal_context", "rejected", {
                    error: error instanceof Error ? error.name : "unknown_error",
                });
                return authenticationError(error);
            }
        },
    );

    server.registerTool(
        "get_personal_context",
        {
            description: "Get one exact private notebook record owned by the authenticated actor. Missing and unauthorized records both return null.",
            annotations: {
                title: "Get Private Notebook Record",
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
            const receiptId = randomUUID();
            emitPrivateReadReceipt(receiptId, "get_personal_context", "received");

            try {
                const authenticated = await authenticateTool("get_personal_context", payload, auth, extra);
                emitPrivateReadReceipt(receiptId, "get_personal_context", "authenticated", {
                    actor_id: authenticated.actor_id,
                });
                const context = await getPersonalContext(authenticated.actor_id, id);
                emitPrivateReadReceipt(receiptId, "get_personal_context", "completed", {
                    actor_id: authenticated.actor_id,
                    found: context !== null,
                });
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({ id, context }),
                    }],
                };
            } catch (error) {
                emitPrivateReadReceipt(receiptId, "get_personal_context", "rejected", {
                    error: error instanceof Error ? error.name : "unknown_error",
                });
                return authenticationError(error);
            }
        },
    );

    server.registerTool(
        "update_personal_context",
        {
            description: "Update a private notebook record owned by the authenticated actor.",
            inputSchema: {
                id: z.number().int().positive().describe("Exact context ID."),
                text: z.string().min(1).optional().describe("Optional replacement text."),
                tags: z.array(z.string()).optional().describe("Optional replacement tags."),
                source: z.string().optional().describe("Optional replacement source."),
                subject: subjectIdentitySchema.optional().describe("Optional canonical subject used to classify or backfill this private record. Actor ownership is unchanged."),
                auth: requestAuthSchema.optional().describe("Authentication using either an enrolled-key signature or an operator-approved actor session."),
            },
        },
        async ({ id, text, tags, source, subject, auth }, extra) => {
            const payload = { id, text, tags, source, subject };

            try {
                const authenticated = await authenticateTool("update_personal_context", payload, auth, extra);
                const updated = await updatePersonalContext(
                    authenticated.actor_id,
                    id,
                    text,
                    tags,
                    source,
                    subject,
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
        "delete_personal_context",
        {
            description: "Delete a private notebook record owned by the authenticated actor.",
            inputSchema: {
                id: z.number().int().positive().describe("Exact context ID."),
                auth: requestAuthSchema.optional().describe("Authentication using either an enrolled-key signature or an operator-approved actor session."),
            },
        },
        async ({ id, auth }, extra) => {
            const payload = { id };

            try {
                const authenticated = await authenticateTool("delete_personal_context", payload, auth, extra);
                const deleted = await deletePersonalContext(authenticated.actor_id, id);
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
            description: "Read local database counts and storage sizes. This does not return note contents, modify data, or contact external services.",
            annotations: {
                title: "Read Local Context Database Metadata",
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
        },
        async (extra) => {
            try {
                await authenticateContextTool("database_metadata", {}, extra);
            } catch (error) {
                return authenticationError(error);
            }
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
            description: "Read one local shared Whiteboard note by its exact ID. Non-Whiteboard records are not accessible. This does not modify data or contact external services.",
            annotations: {
                title: "Read Shared Whiteboard Note",
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                id: z.number().int().positive().describe("The id of the context item to retrieve."),
            },
        },
        async ({ id }, extra) => {
            try {
                await authenticateContextTool("get_context", { id }, extra);
            } catch (error) {
                return authenticationError(error);
            }
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
        "connect_contexts",
        {
            description: "Create an authenticated directed knowledge edge between two contexts in the same visibility scope. The relationship and rationale describe meaning and grant no access.",
            annotations: {
                title: "Connect Contexts",
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                source_context_id: z.number().int().positive().describe("Context where the directed relationship starts."),
                target_context_id: z.number().int().positive().describe("Context where the directed relationship points."),
                relationship: z.string().regex(/^[a-z][a-z0-9:_-]{0,63}$/).describe("Stable lowercase relationship type, such as led_to, supports, contradicts, or supersedes."),
                rationale: z.string().min(1).max(2000).optional().describe("Optional bounded explanation of why the contexts are connected."),
                auth: requestAuthSchema.optional().describe("Authenticated edge creator."),
            },
        },
        async ({ source_context_id, target_context_id, relationship, rationale, auth }, extra) => {
            const payload = { source_context_id, target_context_id, relationship, rationale };
            try {
                const authenticated = await authenticateTool("connect_contexts", payload, auth, extra);
                const context = await connectContexts(
                    authenticated.actor_id,
                    source_context_id,
                    target_context_id,
                    relationship,
                    rationale,
                );
                return { content: [{ type: "text", text: JSON.stringify({ context }) }] };
            } catch (error) {
                return authenticationError(error);
            }
        },
    );

    server.registerTool(
        "disconnect_contexts",
        {
            description: "Remove one authenticated context edge by its exact connection ID without deleting either context.",
            annotations: {
                title: "Disconnect Contexts",
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: false,
                openWorldHint: false,
            },
            inputSchema: {
                connection_id: z.number().int().positive().describe("Exact connection ID returned in a context envelope."),
                auth: requestAuthSchema.optional().describe("Authenticated actor with write access to the connection scope."),
            },
        },
        async ({ connection_id, auth }, extra) => {
            const payload = { connection_id };
            try {
                const authenticated = await authenticateTool("disconnect_contexts", payload, auth, extra);
                const context = await disconnectContexts(authenticated.actor_id, connection_id);
                return { content: [{ type: "text", text: JSON.stringify({ connection_id, disconnected: true, context }) }] };
            } catch (error) {
                return authenticationError(error);
            }
        },
    );

    server.registerTool(
        "update_context_lifecycle",
        {
            description: "Update authenticated relevance and lifecycle metadata without changing context content or authority.",
            annotations: {
                title: "Update Context Lifecycle",
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                context_id: z.number().int().positive(),
                state: z.enum(CONTEXT_LIFECYCLE_STATE_VALUES).optional(),
                importance: z.number().int().min(0).max(100).optional(),
                completed: z.boolean().optional().describe("Set or clear the completion timestamp."),
                superseded_by_context_id: z.number().int().positive().nullable().optional().describe("Same-scope successor context, or null to clear."),
                auth: requestAuthSchema.optional().describe("Authenticated actor with write access to the context scope."),
            },
        },
        async ({ context_id, state, importance, completed, superseded_by_context_id, auth }, extra) => {
            const payload = { context_id, state, importance, completed, superseded_by_context_id };
            try {
                const authenticated = await authenticateTool("update_context_lifecycle", payload, auth, extra);
                const context = await updateContextLifecycle(authenticated.actor_id, context_id, {
                    state,
                    importance,
                    completed,
                    supersededByContextId: superseded_by_context_id,
                });
                return { content: [{ type: "text", text: JSON.stringify({ context }) }] };
            } catch (error) {
                return authenticationError(error);
            }
        },
    );

    server.registerTool(
        "preview_auto_archive",
        {
            description: "Evaluate cold Whiteboard records under the conservative protected-tag and graph-safety policy. This never archives by itself.",
            annotations: { title: "Preview Auto Archive", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
            inputSchema: {
                limit: z.number().int().min(1).max(100).optional(),
                minimum_age_days: z.number().int().min(1).max(3650).optional(),
                auth: requestAuthSchema.optional().describe("Authenticated reviewer."),
            },
        },
        async ({ limit, minimum_age_days, auth }, extra) => {
            const payload = { limit, minimum_age_days };
            try {
                const authenticated = await authenticateTool("preview_auto_archive", payload, auth, extra);
                const preview = await previewAutoArchive(authenticated.actor_id, limit, minimum_age_days);
                return { content: [{ type: "text", text: JSON.stringify({ preview }) }] };
            } catch (error) {
                return authenticationError(error);
            }
        },
    );

    server.registerTool(
        "confirm_auto_archive",
        {
            description: "Archive an explicitly selected subset from one unexpired reviewed preview. Archival is reversible and never deletes payloads or graph edges.",
            annotations: { title: "Confirm Auto Archive", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
            inputSchema: {
                confirmation_token: z.string().uuid(),
                context_ids: z.array(z.number().int().positive()).min(1).max(100),
                auth: requestAuthSchema.optional().describe("Same authenticated reviewer who created the preview."),
            },
        },
        async ({ confirmation_token, context_ids, auth }, extra) => {
            const payload = { confirmation_token, context_ids };
            try {
                const authenticated = await authenticateTool("confirm_auto_archive", payload, auth, extra);
                const result = await confirmAutoArchive(authenticated.actor_id, confirmation_token, context_ids);
                return { content: [{ type: "text", text: JSON.stringify(result) }] };
            } catch (error) {
                return authenticationError(error);
            }
        },
    );

    server.registerTool(
        "acknowledge_context",
        {
            description: "Acknowledge an ordinary Whiteboard context as an identified actor. Repeated acknowledgements by the same actor are idempotent. This tool cannot acknowledge channel, group, personal, direct, or system records.",
            inputSchema: {
                context_id: z.number().int().positive().describe("The Whiteboard context id to acknowledge."),
                actor: z.object({
                    external_id: z.string().min(1).describe("Stable operational actor ID, such as actor:openai:codex."),
                    name: z.string().min(1).describe("Actor display name."),
                    kind: z.string().min(1).optional().describe("Optional actor category, such as ai or human."),
                    metadata: z.record(z.string(), z.unknown()).optional().describe("Optional actor metadata retained on the actor record but never returned in acknowledged_by."),
                }).optional().describe("Explicit acknowledging actor. Takes precedence over the active actor session."),
            },
            annotations: {
                title: "Acknowledge Context",
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
        },
        async ({ context_id, actor }, extra) => {
            let authenticated;
            try {
                authenticated = await authenticateContextTool("acknowledge_context", { context_id }, extra);
            } catch (error) {
                return authenticationError(error);
            }
            if (!authenticated && !actor && actorSession.actorId === null) {
                return {
                    isError: true,
                    content: [{
                        type: "text" as const,
                        text: JSON.stringify({
                            error: {
                                code: "ACTOR_IDENTIFICATION_REQUIRED",
                                message: "Retry acknowledge_context with an actor object. Clients that preserve MCP session continuity may instead call identify_actor first.",
                                required_action: {
                                    tool: "acknowledge_context",
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
                    }],
                };
            }
            const result = await acknowledgeContextWithActor(
                context_id,
                authenticated ? undefined : actor,
                authenticated?.actor_id ?? actorSession.actorId,
            );
            if (result.actor) actorSession.activate(result.actor.id);
            return {
                content: [{
                    type: "text",
                    text: JSON.stringify({
                        context_id,
                        acknowledged: result.acknowledged,
                        context: result.context,
                        ...(result.actor_resolution
                            ? { actor_resolution: result.actor_resolution }
                            : {}),
                    }),
                }],
            };
        },
    );

    server.registerTool(
        "delete_context",
        {
            description: "Delete a saved personal context item by id.",
            inputSchema: {
                id: z.number().int().positive().describe("The id of the context item to delete."),
            },
        },
        async ({ id }, extra) => {
            try {
                await authenticateContextTool("delete_context", { id }, extra);
            } catch (error) {
                return authenticationError(error);
            }
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
                subject: subjectIdentitySchema.optional().describe("Optional canonical subject used to classify or backfill this record. Actor attribution is unchanged."),
            },
        },
        async ({ id, text, tags, source, visibility, subject }, extra) => {
            try {
                await authenticateContextTool("update_context", { id, text, tags, source, visibility, subject }, extra);
            } catch (error) {
                return authenticationError(error);
            }
            const updated = await updateContext(id, text, tags, source, visibility, subject);

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
        async ({ before }, extra) => {
            try {
                await authenticateContextTool("context_purge_preview", { before }, extra);
            } catch (error) {
                return authenticationError(error);
            }
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
        async ({ before, confirmation_token, expected_count }, extra) => {
            try {
                await authenticateContextTool("context_purge_confirm", { before, confirmation_token, expected_count }, extra);
            } catch (error) {
                return authenticationError(error);
            }
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
        "begin_payload_upload",
        {
            description: "Reserve an authenticated staged upload and return an expiring upload ID. No context metadata is created yet.",
            inputSchema: {
                scope: z.enum(ATTACHMENT_SCOPE_VALUES),
                group: z.string().min(3).max(64).optional(),
                filename: z.string().min(1).max(500),
                media_type: z.string().min(3).max(200),
                expected_size_bytes: z.number().int().nonnegative(),
                expected_sha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
                auth: requestAuthSchema.optional(),
            },
        },
        async ({ scope, group, filename, media_type, expected_size_bytes, expected_sha256, auth }, extra) => {
            const payload = { scope, group, filename, media_type, expected_size_bytes, expected_sha256 };
            try {
                const actor = await authenticateTool("begin_payload_upload", payload, auth, extra);
                const upload = await beginAttachmentUpload(actor.actor_id, scope, filename, media_type, expected_size_bytes, expected_sha256, group);
                return { content: [{ type: "text", text: JSON.stringify({ upload }) }] };
            } catch (error) { return authenticationError(error); }
        },
    );

    server.registerTool(
        "append_payload_chunk",
        {
            description: "Append one bounded base64 chunk to a staged payload upload at an exact offset.",
            inputSchema: {
                upload_id: z.string().uuid(),
                offset: z.number().int().nonnegative(),
                data_base64: z.string().min(1),
                auth: requestAuthSchema.optional(),
            },
        },
        async ({ upload_id, offset, data_base64, auth }, extra) => {
            const payload = { upload_id, offset, data_base64 };
            try {
                const actor = await authenticateTool("append_payload_chunk", payload, auth, extra);
                const upload = await appendAttachmentChunk(actor.actor_id, upload_id, offset, data_base64);
                return { content: [{ type: "text", text: JSON.stringify({ upload }) }] };
            } catch (error) { return authenticationError(error); }
        },
    );

    server.registerTool(
        "finalize_payload_upload",
        {
            description: "Verify a complete staged upload and return its immutable payload reference before any envelope metadata is applied.",
            inputSchema: {
                upload_id: z.string().uuid(),
                auth: requestAuthSchema.optional(),
            },
        },
        async ({ upload_id, auth }, extra) => {
            const payload = { upload_id };
            try {
                const actor = await authenticateTool("finalize_payload_upload", payload, auth, extra);
                const artifact = await finalizeAttachmentUpload(actor.actor_id, upload_id);
                return { content: [{ type: "text", text: JSON.stringify({ payload_ref: artifact.payload_ref }) }] };
            } catch (error) { return authenticationError(error); }
        },
    );

    server.registerTool(
        "attach_payload_to_context",
        {
            description: "Attach one finalized immutable payload reference to an existing same-scope context with a semantic role and optional derivation lineage.",
            inputSchema: {
                context_id: z.number().int().positive(),
                payload_id: z.string().regex(/^payload:artifact:[0-9a-fA-F-]{36}:v1$/),
                role: z.enum(ATTACHMENT_RELATIONSHIP_VALUES),
                derived_from_payload_id: z.string().regex(/^payload:artifact:[0-9a-fA-F-]{36}:v1$/).optional(),
                auth: requestAuthSchema.optional(),
            },
        },
        async ({ context_id, payload_id, role, derived_from_payload_id, auth }, extra) => {
            const payload = { context_id, payload_id, role, derived_from_payload_id };
            try {
                const actor = await authenticateTool("attach_payload_to_context", payload, auth, extra);
                const link = await linkPayloadToContext(actor.actor_id, payload_id, context_id, role, derived_from_payload_id);
                return { content: [{ type: "text", text: JSON.stringify({ link }) }] };
            } catch (error) { return authenticationError(error); }
        },
    );

    server.registerTool(
        "begin_attachment_upload",
        {
            description: "Begin an immutable, integrity-checked attachment upload owned by the authenticated actor or an access group.",
            inputSchema: {
                scope: z.enum(ATTACHMENT_SCOPE_VALUES),
                group: z.string().min(3).max(64).optional().describe("Required only for group ownership."),
                filename: z.string().min(1).max(500),
                media_type: z.string().min(3).max(200),
                expected_size_bytes: z.number().int().nonnegative(),
                expected_sha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
                auth: requestAuthSchema.optional(),
            },
        },
        async ({ scope, group, filename, media_type, expected_size_bytes, expected_sha256, auth }, extra) => {
            const payload = { scope, group, filename, media_type, expected_size_bytes, expected_sha256 };
            try {
                const authenticated = await authenticateTool("begin_attachment_upload", payload, auth, extra);
                const upload = await beginAttachmentUpload(authenticated.actor_id, scope, filename, media_type, expected_size_bytes, expected_sha256, group);
                return { content: [{ type: "text", text: JSON.stringify({ upload }) }] };
            } catch (error) { return authenticationError(error); }
        },
    );

    server.registerTool(
        "get_attachment_quota",
        {
            description: "Get strict finalized, reserved, and available attachment bytes for an authorized personal or group scope.",
            annotations: { title: "Get Attachment Quota", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
            inputSchema: {
                scope: z.enum(ATTACHMENT_SCOPE_VALUES),
                group: z.string().min(3).max(64).optional(),
                auth: requestAuthSchema.optional(),
            },
        },
        async ({ scope, group, auth }, extra) => {
            const payload = { scope, group };
            try {
                const authenticated = await authenticateTool("get_attachment_quota", payload, auth, extra);
                const quota = await getAttachmentQuota(authenticated.actor_id, scope, group);
                return { content: [{ type: "text", text: JSON.stringify({ quota }) }] };
            } catch (error) { return authenticationError(error); }
        },
    );

    server.registerTool(
        "append_attachment_chunk",
        {
            description: "Append one base64 chunk at the exact current upload offset. Chunks are limited to 512 KiB decoded.",
            inputSchema: {
                upload_id: z.string().uuid(),
                offset: z.number().int().nonnegative(),
                data_base64: z.string(),
                auth: requestAuthSchema.optional(),
            },
        },
        async ({ upload_id, offset, data_base64, auth }, extra) => {
            const payload = { upload_id, offset, data_base64 };
            try {
                const authenticated = await authenticateTool("append_attachment_chunk", payload, auth, extra);
                const upload = await appendAttachmentChunk(authenticated.actor_id, upload_id, offset, data_base64);
                return { content: [{ type: "text", text: JSON.stringify({ upload }) }] };
            } catch (error) { return authenticationError(error); }
        },
    );

    server.registerTool(
        "cancel_attachment_upload",
        {
            description: "Cancel an unfinished authorized upload and remove its temporary bytes.",
            inputSchema: { upload_id: z.string().uuid(), auth: requestAuthSchema.optional() },
        },
        async ({ upload_id, auth }, extra) => {
            const payload = { upload_id };
            try {
                const authenticated = await authenticateTool("cancel_attachment_upload", payload, auth, extra);
                const upload = await cancelAttachmentUpload(authenticated.actor_id, upload_id);
                return { content: [{ type: "text", text: JSON.stringify({ upload }) }] };
            } catch (error) { return authenticationError(error); }
        },
    );

    server.registerTool(
        "finalize_attachment_upload",
        {
            description: "Verify the completed upload's declared byte length and SHA-256, then publish it atomically.",
            inputSchema: {
                upload_id: z.string().uuid(),
                auth: requestAuthSchema.optional(),
            },
        },
        async ({ upload_id, auth }, extra) => {
            const payload = { upload_id };
            try {
                const authenticated = await authenticateTool("finalize_attachment_upload", payload, auth, extra);
                const attachment = await finalizeAttachmentUpload(authenticated.actor_id, upload_id);
                return { content: [{ type: "text", text: JSON.stringify({ attachment }) }] };
            } catch (error) { return authenticationError(error); }
        },
    );

    server.registerTool(
        "get_attachment",
        {
            description: "Get attachment metadata after current ownership or group-read authorization. Missing and unauthorized IDs both return null.",
            annotations: { title: "Get Attachment", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
            inputSchema: { id: z.string().uuid(), auth: requestAuthSchema.optional() },
        },
        async ({ id, auth }, extra) => {
            const payload = { id };
            try {
                const authenticated = await authenticateTool("get_attachment", payload, auth, extra);
                const attachment = await getAttachment(authenticated.actor_id, id);
                return { content: [{ type: "text", text: JSON.stringify({ id, attachment }) }] };
            } catch (error) { return authenticationError(error); }
        },
    );

    server.registerTool(
        "list_attachments",
        {
            description: "List personal or group-owned attachment metadata after current authorization.",
            annotations: { title: "List Attachments", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
            inputSchema: {
                scope: z.enum(ATTACHMENT_SCOPE_VALUES),
                group: z.string().min(3).max(64).optional(),
                limit: z.number().int().positive().max(100).optional(),
                auth: requestAuthSchema.optional(),
            },
        },
        async ({ scope, group, limit, auth }, extra) => {
            const payload = { scope, group, limit };
            try {
                const authenticated = await authenticateTool("list_attachments", payload, auth, extra);
                const attachments = await listAttachments(authenticated.actor_id, scope, group, limit);
                return { content: [{ type: "text", text: JSON.stringify({ attachments }) }] };
            } catch (error) { return authenticationError(error); }
        },
    );

    server.registerTool(
        "read_attachment_chunk",
        {
            description: "Read up to 512 KiB of an authorized attachment as base64.",
            annotations: { title: "Read Attachment Chunk", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
            inputSchema: {
                id: z.string().uuid(),
                offset: z.number().int().nonnegative().optional(),
                length: z.number().int().positive().max(512 * 1024).optional(),
                auth: requestAuthSchema.optional(),
            },
        },
        async ({ id, offset, length, auth }, extra) => {
            const payload = { id, offset, length };
            try {
                const authenticated = await authenticateTool("read_attachment_chunk", payload, auth, extra);
                const chunk = await readAttachmentChunk(authenticated.actor_id, id, offset, length);
                return { content: [{ type: "text", text: JSON.stringify({ id, chunk }) }] };
            } catch (error) { return authenticationError(error); }
        },
    );

    server.registerTool(
        "link_attachment_to_context",
        {
            description: "Link an attachment to a personal or group context only when both have the exact same ownership scope.",
            inputSchema: {
                attachment_id: z.string().uuid(),
                context_id: z.number().int().positive(),
                relationship: z.enum(ATTACHMENT_RELATIONSHIP_VALUES).optional(),
                sort_order: z.number().int().nonnegative().optional(),
                page_start: z.number().int().positive().optional(),
                page_end: z.number().int().positive().optional(),
                auth: requestAuthSchema.optional(),
            },
        },
        async ({ attachment_id, context_id, relationship, sort_order, page_start, page_end, auth }, extra) => {
            const payload = { attachment_id, context_id, relationship, sort_order, page_start, page_end };
            try {
                const authenticated = await authenticateTool("link_attachment_to_context", payload, auth, extra);
                const link = await linkAttachmentToContext(authenticated.actor_id, attachment_id, context_id, relationship, sort_order, page_start, page_end);
                return { content: [{ type: "text", text: JSON.stringify({ link }) }] };
            } catch (error) { return authenticationError(error); }
        },
    );

    server.registerTool(
        "list_context_attachments",
        {
            description: "List authorized attachment metadata and relationship information for an exact context.",
            annotations: { title: "List Context Attachments", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
            inputSchema: { context_id: z.number().int().positive(), auth: requestAuthSchema.optional() },
        },
        async ({ context_id, auth }, extra) => {
            const payload = { context_id };
            try {
                const authenticated = await authenticateTool("list_context_attachments", payload, auth, extra);
                const attachments = await listContextAttachments(authenticated.actor_id, context_id);
                return { content: [{ type: "text", text: JSON.stringify({ context_id, attachments }) }] };
            } catch (error) { return authenticationError(error); }
        },
    );

    server.registerTool(
        "delete_attachment",
        {
            description: "Delete attachment metadata and links with current write authorization; remove unreferenced content bytes.",
            inputSchema: { id: z.string().uuid(), auth: requestAuthSchema.optional() },
        },
        async ({ id, auth }, extra) => {
            const payload = { id };
            try {
                const authenticated = await authenticateTool("delete_attachment", payload, auth, extra);
                const deleted = await deleteAttachment(authenticated.actor_id, id);
                return { content: [{ type: "text", text: JSON.stringify({ id, deleted }) }] };
            } catch (error) { return authenticationError(error); }
        },
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

    applyToolSurface(server, options.surface ?? "full");
    return server;
}
