#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { appendWakeAudit, readWakeHistory, withWakeAuditLock } from "./audit.js";
import { evaluateWakePolicy, wakeEventSchema, wakePolicySchema } from "./policy.js";

export type CliOptions = {
    policy: string;
    event: string;
    audit: string;
    now?: string;
    pretty: boolean;
};

function usage() {
    return `Usage: wake-policy:dry-run -- --policy FILE --event FILE --audit FILE [--now ISO] [--pretty]

Evaluates a wake request and writes an audit record. This CLI never launches a process.`;
}

function parseArgs(args: string[]): CliOptions {
    const result: Partial<CliOptions> = { pretty: false };
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === "--pretty") {
            result.pretty = true;
            continue;
        }
        if (argument === "--help" || argument === "-h") {
            process.stdout.write(`${usage()}\n`);
            process.exit(0);
        }
        const value = args[index + 1];
        if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}`);
        if (argument === "--policy" || argument === "--event" || argument === "--audit" || argument === "--now") {
            result[argument.slice(2) as "policy" | "event" | "audit" | "now"] = value;
            index += 1;
            continue;
        }
        throw new Error(`Unknown argument: ${argument}`);
    }
    if (!result.policy || !result.event || !result.audit) throw new Error(usage());
    return result as CliOptions;
}

async function readJson(path: string) {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
}

export async function main(args = process.argv.slice(2)) {
    const options = parseArgs(args);
    const decision = await runDryRun(options);
    process.stdout.write(`${JSON.stringify(decision, null, options.pretty ? 2 : 0)}\n`);
    process.exitCode = decision.decision === "allow" ? 0 : 2;
}

export async function runDryRun(options: CliOptions) {
    const policy = wakePolicySchema.parse(await readJson(options.policy));
    const event = wakeEventSchema.parse(await readJson(options.event));
    const now = options.now ? new Date(options.now) : new Date();
    if (!Number.isFinite(now.getTime())) throw new Error("--now must be a valid ISO timestamp.");
    const decision = await withWakeAuditLock(options.audit, async () => {
        const history = await readWakeHistory(options.audit);
        const evaluated = evaluateWakePolicy(policy, event, history, now);
        await appendWakeAudit(options.audit, evaluated);
        return evaluated;
    });
    return decision;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
    main().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`wake-policy dry-run failed: ${message}\n`);
        process.exitCode = 1;
    });
}
