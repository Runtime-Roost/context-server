import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

type AuthenticatedActor = { actor_external_id: string };
type ToolExtra = { _meta?: Record<string, unknown> };
type Authorize = (tool: string, payload: Record<string, unknown>, extra?: ToolExtra) => Promise<AuthenticatedActor | null>;
type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean; structuredContent?: Record<string, unknown>; [key: string]: unknown };
type ErrorRenderer = (error: unknown) => ToolResult;
type Fetcher = typeof fetch;

const uuid = z.string().uuid();
const priority = z.enum(["low", "normal", "high", "urgent"]);
const title = z.string().trim().min(1).max(200);
const description = z.string().max(8_000);
const criteria = z.array(z.string().trim().min(1).max(1_000)).min(1).max(50);

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toolResult(value: unknown, isError = false) {
    const text = JSON.stringify(value);
    return { isError, structuredContent: value as Record<string, unknown>, content: [{ type: "text" as const, text }] };
}

export class WorkshopDraftError extends Error {
    constructor(readonly code: string) { super(code); }
}

function normalizeApiError(value: unknown, status: number) {
    if (record(value) && typeof value.error === "string" && /^[A-Z][A-Z0-9_]{1,80}$/.test(value.error)) return value.error;
    return `WORKSHOP_HTTP_${status}`;
}

async function readWorkshopServiceToken(path: string) {
    let handle;
    try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch { throw new WorkshopDraftError("WORKSHOP_NOT_CONFIGURED"); }
    try {
        const info = await handle.stat();
        if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.size < 16 || info.size > 16_384) {
            throw new WorkshopDraftError("WORKSHOP_CREDENTIAL_FILE_INVALID");
        }
        const contents = await handle.readFile("utf8");
        const matches = [...contents.matchAll(/^ROOST_WORKSHOP_SERVICE_TOKEN=(.*)$/gm)];
        if (matches.length !== 1) throw new WorkshopDraftError("WORKSHOP_CREDENTIAL_FILE_INVALID");
        let token = matches[0][1].trim();
        if (token.length >= 2 && ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'")))) {
            token = token.slice(1, -1);
        }
        if (!/^[A-Za-z0-9._~+/=-]{16,4096}$/.test(token)) throw new WorkshopDraftError("WORKSHOP_CREDENTIAL_FILE_INVALID");
        return token;
    } finally { await handle.close(); }
}

function validateBaseUrl(value: string) {
    const url = new URL(value);
    if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname)
        || !url.port || url.pathname !== "/" || url.username || url.password || url.search || url.hash) {
        throw new WorkshopDraftError("WORKSHOP_UPSTREAM_MUST_BE_LOOPBACK_HTTP");
    }
    return url.origin;
}

export class WorkshopDraftsClient {
    readonly #baseUrl: string;
    readonly #serviceEnvFile: string;
    readonly #workspaceId: string;
    readonly #fetch: Fetcher;

    constructor(options: { baseUrl?: string; serviceEnvFile: string; workspaceId: string; fetcher?: Fetcher }) {
        this.#baseUrl = validateBaseUrl(options.baseUrl ?? "http://127.0.0.1:4340/");
        this.#serviceEnvFile = options.serviceEnvFile;
        this.#workspaceId = uuid.parse(options.workspaceId);
        this.#fetch = options.fetcher ?? fetch;
    }

    static fromEnvironment(env: NodeJS.ProcessEnv = process.env) {
        const serviceEnvFile = env.ROOST_WORKSHOP_SERVICE_ENV_FILE?.trim();
        const workspaceId = env.ROOST_WORKSHOP_DRAFTS_WORKSPACE_ID?.trim();
        if (!serviceEnvFile && !workspaceId) return undefined;
        if (!serviceEnvFile || !workspaceId) throw new WorkshopDraftError("WORKSHOP_DRAFT_CONFIGURATION_INCOMPLETE");
        return new WorkshopDraftsClient({
            baseUrl: env.ROOST_WORKSHOP_API_URL?.trim() || "http://127.0.0.1:4340/",
            serviceEnvFile,
            workspaceId,
        });
    }

    async #request(actor: string, method: string, path: string, body?: unknown) {
        if (!/^actor:[A-Za-z0-9._-]+:[A-Za-z0-9._:-]+$/.test(actor) || actor.length > 256) {
            throw new WorkshopDraftError("AUTHENTICATED_ACTOR_INVALID");
        }
        const token = await readWorkshopServiceToken(this.#serviceEnvFile);
        let response: Response;
        try {
            response = await this.#fetch(new URL(path, this.#baseUrl), {
                method,
                redirect: "error",
                signal: AbortSignal.timeout(5_000),
                headers: {
                    accept: "application/json",
                    authorization: `Bearer ${token}`,
                    "x-roost-actor": actor,
                    ...(body === undefined ? {} : { "content-type": "application/json" }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
        } catch {
            throw new WorkshopDraftError("WORKSHOP_UNAVAILABLE");
        }
        let text: string;
        try { text = await response.text(); }
        catch { throw new WorkshopDraftError("WORKSHOP_RESPONSE_INVALID"); }
        if (text.length > 1_000_000) throw new WorkshopDraftError("WORKSHOP_RESPONSE_TOO_LARGE");
        let value: unknown;
        try { value = JSON.parse(text); }
        catch { throw new WorkshopDraftError("WORKSHOP_RESPONSE_INVALID"); }
        if (!response.ok) throw new WorkshopDraftError(normalizeApiError(value, response.status));
        if (!record(value)) throw new WorkshopDraftError("WORKSHOP_RESPONSE_INVALID");
        return value;
    }

    async listDrafts(actor: string, limit: number) {
        const value = await this.#request(actor, "GET", `/v1/workspaces/${this.#workspaceId}/tasks?limit=${limit}&status=draft`);
        if (!Array.isArray(value.tasks)) throw new WorkshopDraftError("WORKSHOP_RESPONSE_INVALID");
        return value.tasks.filter((task) => record(task) && task.status === "draft");
    }

    async getDraft(actor: string, taskId: string) {
        const value = await this.#request(actor, "GET", `/v1/workspaces/${this.#workspaceId}/tasks/${uuid.parse(taskId)}`);
        if (!record(value.task) || value.task.status !== "draft") throw new WorkshopDraftError("DRAFT_NOT_FOUND");
        return value.task;
    }

    async createDraft(actor: string, input: { title: string; description?: string; priority?: z.infer<typeof priority>; acceptance_criteria: string[] }) {
        const payload = {
            correlation_id: randomUUID(),
            idempotency_key: randomUUID(),
            initial_status: "draft",
            task: {
                title: title.parse(input.title),
                description: description.parse(input.description ?? ""),
                owner_actor_id: null,
                priority: priority.parse(input.priority ?? "normal"),
                dependency_task_ids: [],
                acceptance_criteria: criteria.parse(input.acceptance_criteria),
                required_approvals: 1,
                source_context_ids: [],
            },
        };
        const value = await this.#request(actor, "POST", `/v1/workspaces/${this.#workspaceId}/tasks`, payload);
        if (!record(value.task) || value.task.status !== "draft" || value.task.owner_actor_id !== null
            || value.task.created_by_actor_id !== actor) throw new WorkshopDraftError("WORKSHOP_RESPONSE_INVALID");
        return value.task;
    }

    async updateDraft(actor: string, taskId: string, expectedRevision: number, changes: Record<string, unknown>) {
        const validChanges = z.object({
            title: title.optional(),
            description: description.optional(),
            priority: priority.optional(),
            acceptance_criteria: criteria.optional(),
        }).strict().refine((value) => Object.keys(value).length > 0).parse(changes);
        const task = await this.getDraft(actor, taskId);
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || task.revision !== expectedRevision) {
            throw new WorkshopDraftError("REVISION_CONFLICT");
        }
        const value = await this.#request(actor, "PATCH", `/v1/workspaces/${this.#workspaceId}/tasks/${uuid.parse(taskId)}`, {
            correlation_id: randomUUID(),
            idempotency_key: randomUUID(),
            workspace_id: this.#workspaceId,
            expected_revision: expectedRevision,
            changes: validChanges,
        });
        if (!record(value.task) || value.task.status !== "draft") {
            throw new WorkshopDraftError("WORKSHOP_RESPONSE_INVALID");
        }
        return value.task;
    }
}

export function registerWorkshopDraftTools(server: McpServer, options: {
    client: WorkshopDraftsClient;
    authorize: Authorize;
    renderAuthError: ErrorRenderer;
}) {
    const invoke = async (tool: string, payload: Record<string, unknown>, extra: ToolExtra | undefined,
        action: (actor: string) => Promise<unknown>) => {
        let authenticated: AuthenticatedActor | null;
        try { authenticated = await options.authorize(tool, payload, extra); }
        catch (error) { return options.renderAuthError(error); }
        if (!authenticated?.actor_external_id) return options.renderAuthError(new Error("AUTHENTICATION_REQUIRED"));
        try { return toolResult({ result: await action(authenticated.actor_external_id) }); }
        catch (error) {
            const code = error instanceof WorkshopDraftError ? error.code : "WORKSHOP_REQUEST_REJECTED";
            return toolResult({ error: { code } }, true);
        }
    };

    server.registerTool("workshop_list_drafts", {
        description: "List draft tasks in the configured shared Roost Workshop workspace. Returns only drafts; no status, assignment, approval, or execution changes are possible.",
        annotations: { title: "List Workshop Drafts", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: { limit: z.number().int().min(1).max(50).optional().describe("Maximum draft count to return (default 25).") },
    }, async ({ limit }, extra) => invoke("workshop_list_drafts", { limit }, extra,
        (actor) => options.client.listDrafts(actor, limit ?? 25)));

    server.registerTool("workshop_get_draft", {
        description: "Read one draft task in the configured Roost workspace. Non-draft tasks are not returned.",
        annotations: { title: "Read Workshop Draft", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: { task_id: uuid.describe("Exact Workshop task UUID.") },
    }, async ({ task_id }, extra) => invoke("workshop_get_draft", { task_id }, extra,
        (actor) => options.client.getDraft(actor, task_id)));

    server.registerTool("workshop_create_draft", {
        description: "Create an unassigned draft in the configured Roost workspace. The authenticated actor is recorded as creator; no owner or assignee is set. Creation never publishes, approves, assigns, or executes the task.",
        annotations: { title: "Create Unassigned Workshop Draft", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        inputSchema: {
            title,
            description: description.optional(),
            priority: priority.optional(),
            acceptance_criteria: criteria.describe("One or more checks that should be satisfied before the draft is published."),
        },
    }, async (input, extra) => invoke("workshop_create_draft", input, extra,
        (actor) => options.client.createDraft(actor, input)));

    server.registerTool("workshop_update_draft", {
        description: "Edit the text, priority, or acceptance checks of a draft in the configured Roost workspace. Status, ownership, assignment, approval, and execution controls are not exposed. Uses revision checks.",
        annotations: { title: "Update Workshop Draft", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        inputSchema: {
            task_id: uuid,
            expected_revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
            changes: z.object({
                title: title.optional(),
                description: description.optional(),
                priority: priority.optional(),
                acceptance_criteria: criteria.optional(),
            }).strict(),
        },
    }, async ({ task_id, expected_revision, changes }, extra) => invoke("workshop_update_draft",
        { task_id, expected_revision, changes }, extra,
        (actor) => options.client.updateDraft(actor, task_id, expected_revision, changes)));
}
