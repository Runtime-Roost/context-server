import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ContextRecord } from "../mcp/tools.js";

export const CONTEXT_OUTPUT_FIELD_VALUES = [
    "id", "kind", "visibility", "content", "source", "tags", "actor",
    "subject", "payload_ref", "connections", "lifecycle", "acknowledged_by",
    "created_at", "updated_at",
] as const;
export type ContextOutputField = (typeof CONTEXT_OUTPUT_FIELD_VALUES)[number];

const DEFAULT_FENIC_FIELDS: ContextOutputField[] = [
    "id", "kind", "visibility", "content", "source", "tags", "actor",
    "created_at", "updated_at",
];
const MAX_BRIDGE_OUTPUT_BYTES = 1_000_000;
const BRIDGE_TIMEOUT_MS = 15_000;

function bridgePath() {
    return process.env.FENIC_BRIDGE_PATH?.trim()
        || fileURLToPath(new URL("../../scripts/fenic-project.py", import.meta.url));
}

function pythonPath() {
    const configured = process.env.FENIC_PYTHON?.trim();
    if (configured) return configured;
    const local = fileURLToPath(new URL("../../.venv-fenic/bin/python", import.meta.url));
    return existsSync(local) ? local : undefined;
}

export async function projectWithFenic(
    rows: ContextRecord[],
    fields: ContextOutputField[] = DEFAULT_FENIC_FIELDS,
): Promise<Record<string, unknown>[]> {
    if (rows.length === 0) return [];
    const python = pythonPath();
    if (!python) throw new Error("FENIC_NOT_CONFIGURED");

    return new Promise((resolve, reject) => {
        const child = spawn(python, [bridgePath()], {
            stdio: ["pipe", "pipe", "pipe"],
            env: {
                ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
                ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
                ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
                ...(process.env.XDG_CACHE_HOME ? { XDG_CACHE_HOME: process.env.XDG_CACHE_HOME } : {}),
                PYTHONUNBUFFERED: "1",
                NO_PROXY: "127.0.0.1,localhost",
            },
        });
        let stdout = "";
        let stderr = "";
        let settled = false;
        const finish = (error?: Error, value?: Record<string, unknown>[]) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error) reject(error);
            else resolve(value ?? []);
        };
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            finish(new Error("FENIC_TIMEOUT"));
        }, BRIDGE_TIMEOUT_MS);
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
            stdout += chunk;
            if (Buffer.byteLength(stdout) > MAX_BRIDGE_OUTPUT_BYTES) {
                child.kill("SIGKILL");
                finish(new Error("FENIC_OUTPUT_TOO_LARGE"));
            }
        });
        child.stderr.on("data", (chunk: string) => {
            if (stderr.length < 2_000) stderr += chunk;
        });
        child.on("error", () => finish(new Error("FENIC_UNAVAILABLE")));
        child.on("close", (code) => {
            if (code !== 0) return finish(new Error(
                stderr.includes("ModuleNotFoundError") ? "FENIC_NOT_CONFIGURED" : "FENIC_EXECUTION_FAILED",
            ));
            try {
                const parsed = JSON.parse(stdout) as unknown;
                if (!Array.isArray(parsed)) throw new Error("invalid result");
                finish(undefined, parsed as Record<string, unknown>[]);
            } catch {
                finish(new Error("FENIC_OUTPUT_INVALID"));
            }
        });
        child.stdin.end(JSON.stringify({ rows, select: fields }));
    });
}
