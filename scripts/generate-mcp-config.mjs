#!/usr/bin/env node

import { appendFile, readFile, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const configPath = join(repoRoot, "mcp.json");
const gitignorePath = join(repoRoot, ".gitignore");

const config = {
  mcpServers: {
    personal_context: {
      active: true,
      args: [join(repoRoot, "dist", "index.js")],
      command: "node",
      env: {
        PGHOST: process.env.PGHOST ?? "/var/run/postgresql",
        PGDATABASE: process.env.PGDATABASE ?? "personal_context",
        PGUSER: process.env.PGUSER ?? userInfo().username,
        AUTO_MANAGE_DB: process.env.AUTO_MANAGE_DB ?? "false",
        REQUIRE_ACTOR_IDENTIFICATION: process.env.REQUIRE_ACTOR_IDENTIFICATION ?? "false",
        TRUST_OPENAI_TUNNEL_IDENTITY: process.env.TRUST_OPENAI_TUNNEL_IDENTITY ?? "false",
        EMBEDDINGS_ENABLED: process.env.EMBEDDINGS_ENABLED ?? "false",
        EMBEDDINGS_MODEL: process.env.EMBEDDINGS_MODEL ?? "nomic-embed-text",
        EMBEDDINGS_PROVIDER: process.env.EMBEDDINGS_PROVIDER ?? "ollama",
      },
      type: "stdio",
    },
  },
};

await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

const gitignore = await readFile(gitignorePath, "utf8");
const ignoredPaths = new Set(
  gitignore.split(/\r?\n/u).map((line) => line.trim()),
);

if (!ignoredPaths.has("mcp.json") && !ignoredPaths.has("/mcp.json")) {
  const separator = gitignore.endsWith("\n") ? "" : "\n";
  await appendFile(gitignorePath, `${separator}\n# Local MCP client config\nmcp.json\n`, "utf8");
}

console.log(`Wrote ${configPath}`);
console.log(`Ensured mcp.json is ignored by ${gitignorePath}`);
