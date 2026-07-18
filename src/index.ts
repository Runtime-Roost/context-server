#!/usr/bin/env node
// index.ts MCP server that handles stdio

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createServer } from "./mcp/server.js";

const execFileAsync = promisify(execFile);

function autoManageDatabaseEnabled() {
    return process.env.AUTO_MANAGE_DB?.trim().toLowerCase() === "true";
}

async function runDatabaseHelper(command: "status" | "create") {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const helperPath = resolve(repoRoot, "scripts", "db.sh");

    try {
        const { stdout, stderr } = await execFileAsync(helperPath, [command], {
            env: process.env,
        });

        if (stdout) process.stderr.write(stdout);
        if (stderr) process.stderr.write(stderr);
    } catch (error: unknown) {
        const result = error as {
            code?: unknown;
            stdout?: string;
            stderr?: string;
        };

        if (command === "status" && result.code === 1) {
            if (result.stdout) process.stderr.write(result.stdout);
            if (result.stderr) process.stderr.write(result.stderr);
            return false;
        }

        if (result.stdout) process.stderr.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
        throw new Error(`Database helper "${command}" failed with exit code ${String(result.code)}.`);
    }

    return true;
}

async function ensureManagedDatabase() {
    if (!autoManageDatabaseEnabled()) return;

    if (!(await runDatabaseHelper("status"))) {
        await runDatabaseHelper("create");
    }
}

async function main() {
    await ensureManagedDatabase();

    const server = createServer();
    const transport = new StdioServerTransport();

    await server.connect(transport);
}

main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
});
