import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
    SEARCH_SENSITIVITY_VALUES,
    deleteContext,
    contextPurgeConfirm,
    contextPurgePreview,
    getDatabaseMetadata,
    getUserProfile,
    listRecentContext,
    saveContext,
    searchContext,
    updateContext,
    vacuumDatabase,
} from "./tools.js";

export function createServer() {
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
            const context = await saveContext(text, tags, source);

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({ saved: context }),
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
            },
        },
        async ({ query, limit, sensitivity }) => {
            const selectedSensitivity = sensitivity ?? "low";
            const results = await searchContext(query, limit, selectedSensitivity);

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            query,
                            limit: limit ?? 20,
                            sensitivity: selectedSensitivity,
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
            description: "Return the active OS username alongside a medium-sensitivity context search for \"me\".",
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
            },
        },
        async ({ limit }) => {
            const results = await listRecentContext(limit);

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            limit: limit ?? 20,
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
