import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
    getInspectionSnapshot,
    updateInspectionWhiteboardContext,
    type InspectionSnapshot,
    type WhiteboardEditResult,
} from "./store.js";

const repositoryRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const defaultPublicRoot = resolve(repositoryRoot, "inspection-web");
const MAX_BODY_BYTES = 1_050_000;

export type InspectionStore = {
    snapshot(limit?: number): Promise<InspectionSnapshot>;
    update(id: number, content: string, expectedUpdatedAt: string): Promise<WhiteboardEditResult>;
};

const defaultStore: InspectionStore = {
    snapshot: getInspectionSnapshot,
    update: updateInspectionWhiteboardContext,
};

function json(response: ServerResponse, status: number, body: unknown) {
    response.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
    });
    response.end(`${JSON.stringify(body)}\n`);
}

async function readJson(request: IncomingMessage) {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
        const buffer = Buffer.from(chunk);
        size += buffer.length;
        if (size > MAX_BODY_BYTES) throw new Error("request_too_large");
        chunks.push(buffer);
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
        throw new Error("invalid_json");
    }
}

function mutationOriginAllowed(request: IncomingMessage, allowedOrigin: string) {
    return request.headers.origin === allowedOrigin
        && request.headers["sec-fetch-site"] !== "cross-site";
}

function mime(path: string) {
    return {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".svg": "image/svg+xml",
    }[extname(path)] ?? "application/octet-stream";
}

async function serveStatic(response: ServerResponse, publicRoot: string, requestPath: string) {
    const relative = requestPath === "/" ? "index.html" : requestPath.slice(1);
    const target = resolve(publicRoot, relative);
    if (target !== publicRoot && !target.startsWith(`${publicRoot}${sep}`)) {
        json(response, 404, { error: "not_found" });
        return;
    }
    try {
        const body = await readFile(target);
        response.writeHead(200, {
            "content-type": mime(target),
            "cache-control": target.endsWith("index.html") ? "no-cache" : "public, max-age=300",
            "content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
            "permissions-policy": "camera=(), microphone=(), geolocation=()",
            "x-content-type-options": "nosniff",
            "referrer-policy": "no-referrer",
        });
        response.end(body);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            json(response, 404, { error: "not_found" });
            return;
        }
        throw error;
    }
}

export function createInspectionServer({
    store = defaultStore,
    publicRoot = defaultPublicRoot,
    allowedOrigin = "http://127.0.0.1:4180",
}: {
    store?: InspectionStore;
    publicRoot?: string;
    allowedOrigin?: string;
} = {}) {
    return createServer(async (request, response) => {
        try {
            const url = new URL(request.url ?? "/", allowedOrigin);
            if (request.method === "GET" && url.pathname === "/api/inspection") {
                json(response, 200, await store.snapshot());
                return;
            }

            const edit = url.pathname.match(/^\/api\/whiteboard\/([1-9][0-9]*)$/);
            if (request.method === "PATCH" && edit) {
                if (!mutationOriginAllowed(request, allowedOrigin)) {
                    json(response, 403, { error: "origin_not_allowed" });
                    return;
                }
                const body = await readJson(request) as Record<string, unknown>;
                if (
                    typeof body.content !== "string"
                    || body.content.length > 1_000_000
                    || typeof body.expected_updated_at !== "string"
                    || Number.isNaN(Date.parse(body.expected_updated_at))
                ) {
                    json(response, 400, { error: "invalid_whiteboard_edit" });
                    return;
                }
                const result = await store.update(
                    Number(edit[1]),
                    body.content,
                    body.expected_updated_at,
                );
                const status = result.status === "updated" ? 200
                    : result.status === "not_found" ? 404
                    : result.status === "conflict" ? 409
                    : 403;
                json(response, status, result);
                return;
            }

            if (request.method === "GET" || request.method === "HEAD") {
                await serveStatic(response, publicRoot, url.pathname);
                return;
            }
            json(response, 404, { error: "not_found" });
        } catch (error) {
            const message = error instanceof Error ? error.message : "internal_error";
            json(response, message === "request_too_large" ? 413 : 500, { error: message });
        }
    });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const host = process.env.INSPECTION_HOST ?? "127.0.0.1";
    if (host !== "127.0.0.1") throw new Error("INSPECTION_HOST must be 127.0.0.1");
    const port = Number(process.env.INSPECTION_PORT ?? "4180");
    const origin = `http://${host}:${port}`;
    createInspectionServer({ allowedOrigin: origin }).listen(port, host, () => {
        process.stdout.write(`Inspection tool listening on ${origin}\n`);
    });
}
