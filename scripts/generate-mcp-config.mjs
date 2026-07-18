#!/usr/bin/env node

import { appendFile, readFile, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const configPath = join(repoRoot, "mcp.json");
const gitignorePath = join(repoRoot, ".gitignore");

const config = {
  active: true,
  args: [join(repoRoot, "dist", "index.js")],
  command: "node",
  env: {
    PGHOST: process.env.PGHOST ?? "/var/run/postgresql",
    PGDATABASE: process.env.PGDATABASE ?? "personal_context",
    PGUSER: process.env.PGUSER ?? userInfo().username,
    EMBEDDINGS_ENABLED: process.env.EMBEDDINGS_ENABLED ?? "false",
  },
  type: "stdio",
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
