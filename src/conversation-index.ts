#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./mcp/server.js";

async function main() {
    const server = createServer({ surface: "conversation" });
    await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
});
