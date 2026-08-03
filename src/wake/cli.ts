#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
    appendWakeAudit,
    appendWakeDecisionAndOutbox,
    appendWakeDeliveryAudit,
    readWakeHistory,
    readWakeOutbox,
    withWakeAuditLock,
} from "./audit.js";
import {
    createWakeOutboxRecord,
    decisionFromOutbox,
    deliverWakeInvocation,
    wakeDeliveryConfigSchema,
} from "./delivery.js";
import { evaluateWakePolicy, wakeEventSchema, wakePolicySchema } from "./policy.js";

export type CliOptions = {
    policy: string;
    event: string;
    audit: string;
    delivery?: string;
    retryEvent?: string;
    now?: string;
    pretty: boolean;
};

function usage() {
    return `Usage:
  wake-policy:run -- --policy FILE --event FILE --audit FILE [--delivery FILE] [--now ISO] [--pretty]
  wake-policy:run -- --retry-event UUID --audit FILE --delivery FILE [--pretty]

Evaluates and audits a wake request. A policy in deliver mode requires an authenticated
local Unix-socket delivery config. This CLI never launches an agent process.`;
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
        if (
            argument === "--policy"
            || argument === "--event"
            || argument === "--audit"
            || argument === "--delivery"
            || argument === "--retry-event"
            || argument === "--now"
        ) {
            const key = argument === "--retry-event" ? "retryEvent" : argument.slice(2);
            result[key as keyof CliOptions] = value as never;
            index += 1;
            continue;
        }
        throw new Error(`Unknown argument: ${argument}`);
    }
    if (!result.audit) throw new Error(usage());
    if (result.retryEvent) {
        if (!result.delivery || result.policy || result.event || result.now) throw new Error(usage());
    } else if (!result.policy || !result.event) {
        throw new Error(usage());
    }
    return result as CliOptions;
}

async function readJson(path: string) {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
}

export async function main(args = process.argv.slice(2)) {
    const options = parseArgs(args);
    const result = await runWakePolicy(options);
    process.stdout.write(`${JSON.stringify(result, null, options.pretty ? 2 : 0)}\n`);
    process.exitCode = result.decision.decision !== "allow" ? 2 : result.delivery?.accepted === false ? 3 : 0;
}

export async function runWakePolicy(options: CliOptions) {
    if (options.retryEvent) return retryWakeDelivery(options);
    const policy = wakePolicySchema.parse(await readJson(options.policy));
    const event = wakeEventSchema.parse(await readJson(options.event));
    if (policy.mode === "deliver" && !options.delivery) {
        throw new Error("A deliver policy requires --delivery.");
    }
    if (policy.mode !== "deliver" && options.delivery) {
        throw new Error("Delivery options are accepted only when policy.mode is deliver.");
    }
    const now = options.now ? new Date(options.now) : new Date();
    if (!Number.isFinite(now.getTime())) throw new Error("--now must be a valid ISO timestamp.");
    const decision = await withWakeAuditLock(options.audit, async () => {
        const history = await readWakeHistory(options.audit);
        const evaluated = evaluateWakePolicy(policy, event, history, now);
        if (evaluated.decision === "allow" && evaluated.invocation && !evaluated.invocation.dry_run) {
            await appendWakeDecisionAndOutbox(options.audit, evaluated, createWakeOutboxRecord(evaluated));
        } else {
            await appendWakeAudit(options.audit, evaluated);
        }
        return evaluated;
    });
    if (policy.mode !== "deliver" || !decision.invocation) return { decision, delivery: null };

    const config = wakeDeliveryConfigSchema.parse(await readJson(options.delivery!));
    const delivery = await withWakeAuditLock(options.audit, () => deliverWakeInvocation(
        config,
        decision,
        (attempt) => appendWakeDeliveryAudit(options.audit, attempt),
    ));
    return { decision, delivery };
}

async function retryWakeDelivery(options: CliOptions) {
    const config = wakeDeliveryConfigSchema.parse(await readJson(options.delivery!));
    return withWakeAuditLock(options.audit, async () => {
        const outbox = await readWakeOutbox(options.audit, options.retryEvent!);
        if (!outbox) throw new Error(`No pending wake delivery found for ${options.retryEvent}.`);
        const decision = decisionFromOutbox(outbox);
        const delivery = await deliverWakeInvocation(
            config,
            decision,
            (attempt) => appendWakeDeliveryAudit(options.audit, attempt),
        );
        return { decision, delivery };
    });
}

export async function runDryRun(options: CliOptions) {
    const result = await runWakePolicy(options);
    return result.decision;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
    main().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`wake-policy run failed: ${message}\n`);
        process.exitCode = 1;
    });
}
