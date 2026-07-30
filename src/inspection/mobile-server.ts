import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createServer } from "node:https";
import { request as httpRequest } from "node:http";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";

async function privateFile(path: string, mode600 = false) {
    const handle = await open(resolve(path), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const info = await handle.stat();
        if (!info.isFile() || (mode600 && (info.mode & 0o777) !== 0o600)) {
            throw new Error(`${path} must be a regular${mode600 ? " mode-0600" : ""} file`);
        }
        return await handle.readFile();
    } finally {
        await handle.close();
    }
}

function privateIpv4(host: string) {
    if (isIP(host) !== 4) return false;
    const [a, b] = host.split(".").map(Number);
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function authorized(header: string | undefined, token: Buffer) {
    const supplied = Buffer.from(header?.startsWith("Bearer ") ? header.slice(7) : "");
    return supplied.length === token.length && timingSafeEqual(supplied, token);
}

export function createInspectionMobileServer({
    key,
    cert,
    token,
    upstreamPort = 4180,
}: {
    key: Buffer;
    cert: Buffer;
    token: Buffer;
    upstreamPort?: number;
}) {
    return createServer({ key, cert, minVersion: "TLSv1.3" }, (request, response) => {
        const path = request.url ?? "";
        const allowed = (request.method === "GET" && path === "/api/inspection")
            || (request.method === "POST" && path === "/api/whiteboard")
            || (["PATCH", "DELETE"].includes(request.method ?? "")
                && /^\/api\/whiteboard\/[1-9][0-9]*$/.test(path));
        if (!allowed || !authorized(request.headers.authorization, token)) {
            response.writeHead(allowed ? 401 : 404, {
                "content-type": "application/json",
                "cache-control": "no-store",
            });
            response.end(`{"error":"${allowed ? "unauthorized" : "not_found"}"}\n`);
            return;
        }
        const upstream = httpRequest({
            host: "127.0.0.1",
            port: upstreamPort,
            method: request.method,
            path,
            headers: {
                accept: "application/json",
                origin: `http://127.0.0.1:${upstreamPort}`,
                "sec-fetch-site": "same-origin",
                ...(request.headers["content-type"]
                    ? { "content-type": request.headers["content-type"] }
                    : {}),
                ...(request.headers["content-length"]
                    ? { "content-length": request.headers["content-length"] }
                    : {}),
            },
            timeout: 12_000,
        }, (upstreamResponse) => {
            response.writeHead(upstreamResponse.statusCode ?? 502, {
                "content-type": "application/json; charset=utf-8",
                "cache-control": "no-store",
                "x-content-type-options": "nosniff",
            });
            upstreamResponse.pipe(response);
        });
        upstream.once("timeout", () => upstream.destroy(new Error("upstream_timeout")));
        upstream.once("error", () => {
            if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
            response.end('{"error":"gateway_unavailable"}\n');
        });
        request.pipe(upstream);
    });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const host = process.env.INSPECTION_MOBILE_HOST ?? "";
    if (!privateIpv4(host)) {
        throw new Error("INSPECTION_MOBILE_HOST must be one specific RFC1918 IPv4 address");
    }
    const port = Number(process.env.INSPECTION_MOBILE_PORT ?? "4181");
    const key = await privateFile(process.env.INSPECTION_MOBILE_TLS_KEY ?? "", true);
    const cert = await privateFile(process.env.INSPECTION_MOBILE_TLS_CERT ?? "");
    const token = Buffer.from(
        (await privateFile(process.env.INSPECTION_MOBILE_TOKEN_PATH ?? "", true))
            .toString("utf8").trim(),
    );
    if (token.length < 32) throw new Error("Inspection mobile token must contain at least 32 bytes");
    createInspectionMobileServer({ key, cert, token }).listen(port, host, () => {
        process.stdout.write(`Inspection mobile gateway listening on https://${host}:${port}\n`);
    });
}
