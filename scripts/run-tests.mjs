import { mkdtemp, readdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const testDirectory = fileURLToPath(new URL("../test/", import.meta.url));
const testFiles = (await readdir(testDirectory))
    .filter((entry) => entry.endsWith(".test.js"))
    .sort()
    .map((entry) => join(testDirectory, entry));
const configuredDatabaseUrl = process.env.CONTEXT_TEST_DATABASE_URL ?? process.env.DATABASE_URL;

if (!configuredDatabaseUrl) {
    throw new Error("CONTEXT_TEST_DATABASE_URL_REQUIRED: provide a disposable local database URL.");
}

const databaseUrl = new URL(configuredDatabaseUrl);
const databaseName = decodeURIComponent(databaseUrl.pathname.slice(1));
const isLoopbackHost = ["127.0.0.1", "::1", "localhost"].includes(databaseUrl.hostname);
if (
    !["postgres:", "postgresql:"].includes(databaseUrl.protocol)
    || !isLoopbackHost
    || !/(?:^|[_-])test(?:$|[_-])/i.test(databaseName)
    || (databaseUrl.port || "5432") === "5432"
) {
    throw new Error("UNSAFE_CONTEXT_TEST_DATABASE: require loopback PostgreSQL, a test-named database, and a non-default port.");
}

const isolatedConfigHome = await mkdtemp(join(tmpdir(), "personal-context-test-xdg-"));
try {
    const env = {
        ...process.env,
        DATABASE_URL: configuredDatabaseUrl,
        PGHOST: databaseUrl.hostname,
        PGPORT: databaseUrl.port || "5432",
        PGUSER: decodeURIComponent(databaseUrl.username),
        PGPASSWORD: decodeURIComponent(databaseUrl.password),
        PGDATABASE: databaseName,
        EMBEDDINGS_ENABLED: "false",
        XDG_CONFIG_HOME: isolatedConfigHome,
    };
    delete env.ROOST_SSO_OPERATOR_KEY_PATH;
    delete env.ROOST_SSO_AUTHORITY_URL;
    delete env.TRUST_OPENAI_TUNNEL_IDENTITY;

    const child = spawn(process.execPath, ["--test", "--test-concurrency=1", ...testFiles], {
        env,
        stdio: "inherit",
    });
    const exitCode = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => {
            if (signal) {
                reject(new Error(`TEST_RUNNER_SIGNAL_${signal}`));
            } else {
                resolve(code ?? 1);
            }
        });
    });
    process.exitCode = exitCode;
} finally {
    await rm(isolatedConfigHome, { recursive: true, force: true });
}
