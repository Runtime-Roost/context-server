import { z } from "zod";

const actorExternalIdSchema = z.string().min(1).max(200).regex(/^actor:[a-z0-9:_-]+$/i);

export const wakePolicySchema = z.object({
    version: z.literal(1),
    mode: z.enum(["disabled", "dry-run", "deliver"]),
    target_actor_external_id: actorExternalIdSchema,
    allowed_requester_actors: z.array(actorExternalIdSchema).min(1).max(50),
    allowed_trigger_types: z.array(z.string().min(1).max(100)).min(1).max(50),
    allowed_sources: z.array(z.string().min(1).max(200)).min(1).max(50),
    allowed_channels: z.array(z.string().min(1).max(200)).max(100).optional(),
    cooldown_seconds: z.number().int().nonnegative().max(86_400),
    max_event_age_seconds: z.number().int().positive().max(604_800),
    rate_limit: z.object({
        max_wakes: z.number().int().positive().max(1_000),
        window_seconds: z.number().int().positive().max(604_800),
    }),
    invocation_timeout_seconds: z.number().int().positive().max(3_600),
    payload: z.object({
        max_summary_chars: z.number().int().positive().max(100_000),
        max_context_ids: z.number().int().nonnegative().max(1_000),
        allowed_metadata_keys: z.array(z.string().min(1).max(100)).max(100),
    }),
}).strict();

export type WakePolicy = z.infer<typeof wakePolicySchema>;

export const wakeEventSchema = z.object({
    event_id: z.string().uuid(),
    trigger_type: z.string().min(1).max(100),
    source: z.string().min(1).max(200),
    requested_by_actor: actorExternalIdSchema,
    occurred_at: z.iso.datetime({ offset: true }),
    channel: z.string().min(1).max(200).optional(),
    summary: z.string().max(1_000_000).optional(),
    context_ids: z.array(z.number().int().positive()).max(10_000).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

export type WakeEvent = z.infer<typeof wakeEventSchema>;

export type WakeHistoryEntry = {
    evaluated_at: string;
    decision: "allow" | "deny";
    event_id: string;
    target_actor_external_id: string;
};

export const wakeInvocationSchema = z.object({
    target_actor_external_id: actorExternalIdSchema,
    requested_by_actor: actorExternalIdSchema,
    trigger: z.object({
        event_id: z.string().uuid(),
        type: z.string().min(1).max(100),
        source: z.string().min(1).max(200),
        occurred_at: z.iso.datetime({ offset: true }),
        channel: z.string().min(1).max(200).nullable(),
    }).strict(),
    summary: z.string().max(100_000).nullable(),
    context_ids: z.array(z.number().int().positive()).max(1_000),
    metadata: z.record(z.string(), z.union([
        z.string(), z.number(), z.boolean(), z.null(),
    ])),
    timeout_seconds: z.number().int().positive().max(3_600),
    policy_version: z.number().int().positive(),
    dry_run: z.boolean(),
}).strict();

export type WakeInvocation = z.infer<typeof wakeInvocationSchema>;

export type WakeDecision = {
    decision: "allow" | "deny";
    reasons: string[];
    evaluated_at: string;
    policy_version: number;
    mode: WakePolicy["mode"];
    event_id: string;
    target_actor_external_id: string;
    invocation: WakeInvocation | null;
};

function boundedMetadata(
    metadata: Record<string, unknown> | undefined,
    allowedKeys: string[],
) {
    const result: Record<string, string | number | boolean | null> = {};
    if (!metadata) return result;

    for (const key of allowedKeys) {
        const value = metadata[key];
        if (
            value === null
            || typeof value === "string"
            || typeof value === "number"
            || typeof value === "boolean"
        ) {
            result[key] = value;
        }
    }

    return result;
}

export function evaluateWakePolicy(
    policy: WakePolicy,
    event: WakeEvent,
    history: WakeHistoryEntry[],
    now = new Date(),
): WakeDecision {
    const reasons: string[] = [];
    const evaluatedAt = now.toISOString();

    if (policy.mode === "disabled") reasons.push("POLICY_DISABLED");
    if (!policy.allowed_requester_actors.includes(event.requested_by_actor)) {
        reasons.push("REQUESTER_NOT_ALLOWED");
    }
    if (!policy.allowed_trigger_types.includes(event.trigger_type)) {
        reasons.push("TRIGGER_NOT_ALLOWED");
    }
    if (!policy.allowed_sources.includes(event.source)) {
        reasons.push("SOURCE_NOT_ALLOWED");
    }
    if (
        policy.allowed_channels
        && (!event.channel || !policy.allowed_channels.includes(event.channel))
    ) {
        reasons.push("CHANNEL_NOT_ALLOWED");
    }
    if (new Date(event.occurred_at).getTime() > now.getTime() + 60_000) {
        reasons.push("EVENT_TIME_IN_FUTURE");
    }
    if (now.getTime() - new Date(event.occurred_at).getTime() > policy.max_event_age_seconds * 1_000) {
        reasons.push("EVENT_TOO_OLD");
    }
    if (history.some((entry) => entry.event_id === event.event_id)) {
        reasons.push("DUPLICATE_EVENT");
    }

    const priorAllows = history
        .filter((entry) =>
            entry.decision === "allow"
            && entry.target_actor_external_id === policy.target_actor_external_id
        )
        .map((entry) => new Date(entry.evaluated_at).getTime())
        .filter(Number.isFinite)
        .sort((left, right) => right - left);
    const latestAllow = priorAllows[0];
    if (
        latestAllow !== undefined
        && now.getTime() - latestAllow < policy.cooldown_seconds * 1_000
    ) {
        reasons.push("COOLDOWN_ACTIVE");
    }
    const windowStart = now.getTime() - policy.rate_limit.window_seconds * 1_000;
    if (priorAllows.filter((timestamp) => timestamp >= windowStart).length >= policy.rate_limit.max_wakes) {
        reasons.push("RATE_LIMIT_EXCEEDED");
    }

    const allowed = reasons.length === 0;
    return {
        decision: allowed ? "allow" : "deny",
        reasons,
        evaluated_at: evaluatedAt,
        policy_version: policy.version,
        mode: policy.mode,
        event_id: event.event_id,
        target_actor_external_id: policy.target_actor_external_id,
        invocation: allowed
            ? {
                target_actor_external_id: policy.target_actor_external_id,
                requested_by_actor: event.requested_by_actor,
                trigger: {
                    event_id: event.event_id,
                    type: event.trigger_type,
                    source: event.source,
                    occurred_at: event.occurred_at,
                    channel: event.channel ?? null,
                },
                summary: event.summary?.slice(0, policy.payload.max_summary_chars) ?? null,
                context_ids: [...new Set(event.context_ids ?? [])].slice(0, policy.payload.max_context_ids),
                metadata: boundedMetadata(event.metadata, policy.payload.allowed_metadata_keys),
                timeout_seconds: policy.invocation_timeout_seconds,
                policy_version: policy.version,
                dry_run: policy.mode !== "deliver",
            }
            : null,
    };
}
