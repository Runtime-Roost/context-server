import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
    SEARCH_SENSITIVITY_VALUES,
    deleteContext,
    contextPurgeConfirm,
    contextPurgePreview,
    getDatabaseMetadata,
    getUserProfile,
    identifyActor,
    listRecentContext,
    saveContext,
    searchContext,
    updateContext,
    vacuumDatabase,
} from "./tools.js";

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
        "save_context",
        {
            description: "Save a piece of personal context for later retrieval.",
            inputSchema: {
                text: z.string().min(1).describe("The context text to save."),
                tags: z.array(z.string()).optional().describe("Optional tags for grouping or filtering the context."),
                source: z.string().optional().describe("Optional source describing where the context came from."),
            },
        },
        async ({ text, tags, source }) => {
            if (actorSession.actorId === null && requireActorIdentificationEnabled()) {
                return {
                    isError: true,
                    content: [
                        {
                            type: "text" as const,
                            text: JSON.stringify({
                                error: {
                                    code: "ACTOR_IDENTIFICATION_REQUIRED",
                                    message: "Call identify_actor before save_context, or disable REQUIRE_ACTOR_IDENTIFICATION.",
                                },
                            }),
                        },
                    ],
                };
            }

            const context = await saveContext(text, tags, source, actorSession.actorId);
            const warning = actorSession.actorId === null
                ? {
                      code: "ACTOR_NOT_IDENTIFIED",
                      message: "Saved without actor attribution. Call identify_actor before future saves.",
                  }
                : undefined;

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({ saved: context, ...(warning ? { warning } : {}) }),
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
            },
        },
        async ({ id, text, tags, source }) => {
            const updated = await updateContext(id, text, tags, source);

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
