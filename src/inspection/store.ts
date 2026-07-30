import { maybeSaveContextEmbedding } from "../embeddings/index.js";
import { db, initializeDatabase } from "../storage/db.js";
import {
    getContext,
    listRecentContext,
    saveContextWithActor,
    type ContextRecord,
} from "../mcp/tools.js";

export type InspectionWhiteboardContext = ContextRecord & {
    editable: boolean;
    edit_blocked_reason: string | null;
};

export type PrivateMessageEnvelope = {
    id: number;
    visibility: "channel" | "direct";
    channel: {
        id: number;
        slug: string;
        name: string;
    } | null;
    sender: {
        id: number;
        external_id: string | null;
        name: string;
        kind: string | null;
    } | null;
    acknowledgement_count: number;
    created_at: string;
    updated_at: string;
};

export type PrivateChannelSummary = {
    id: number;
    slug: string;
    name: string;
    participants: Array<{
        id: number;
        external_id: string | null;
        name: string;
        kind: string | null;
    }>;
    message_count: number;
    latest_message_at: string | null;
};

export type InspectionSnapshot = {
    generated_at: string;
    whiteboard: InspectionWhiteboardContext[];
    private_channels: PrivateChannelSummary[];
    private_messages: PrivateMessageEnvelope[];
    privacy: {
        private_message_contents_exposed: false;
    };
};

type MessageEnvelopeRow = {
    id: number | string;
    visibility: "channel" | "direct";
    channel_id: number | string | null;
    channel_slug: string | null;
    channel_name: string | null;
    actor_id: number | string | null;
    actor_external_id: string | null;
    actor_name: string | null;
    actor_kind: string | null;
    acknowledgement_count: number | string;
    created_at: string | Date;
    updated_at: string | Date;
};

type ChannelSummaryRow = {
    id: number | string;
    slug: string;
    name: string;
    participants: unknown;
    message_count: number | string;
    latest_message_at: string | Date | null;
};

function timestamp(value: string | Date) {
    return value instanceof Date ? value.toISOString() : value;
}

function routedToAgent(context: ContextRecord) {
    return context.tags.some((tag) => /^message-to-/i.test(tag));
}

function inspectionContext(context: ContextRecord): InspectionWhiteboardContext {
    const routed = routedToAgent(context);
    return {
        ...context,
        editable: !routed,
        edit_blocked_reason: routed
            ? "This note is an agent inbox item. Editing it could change an invocation payload."
            : null,
    };
}

function parseParticipants(value: unknown): PrivateChannelSummary["participants"] {
    const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => {
        const actor = item as Record<string, unknown>;
        return {
            id: Number(actor.id),
            external_id: typeof actor.external_id === "string" ? actor.external_id : null,
            name: typeof actor.name === "string" ? actor.name : "Unknown actor",
            kind: typeof actor.kind === "string" ? actor.kind : null,
        };
    });
}

export async function getInspectionSnapshot(limit = 200): Promise<InspectionSnapshot> {
    await initializeDatabase();
    const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 500);
    const [whiteboard, channels, messages] = await Promise.all([
        listRecentContext(boundedLimit),
        db.query<ChannelSummaryRow>(
            `
                SELECT
                    channels.id,
                    channels.slug,
                    channels.name,
                    COALESCE((
                        SELECT jsonb_agg(
                            jsonb_build_object(
                                'id', actors.id,
                                'external_id', actors.external_id,
                                'name', actors.name,
                                'kind', actors.kind
                            )
                            ORDER BY actors.name, actors.id
                        )
                        FROM channel_memberships
                        INNER JOIN actors ON actors.id = channel_memberships.actor_id
                        WHERE channel_memberships.channel_id = channels.id
                          AND channel_memberships.removed_at IS NULL
                    ), '[]'::jsonb) AS participants,
                    (
                        SELECT COUNT(*)::int
                        FROM contexts
                        WHERE contexts.channel_id = channels.id
                          AND contexts.visibility = 'channel'
                    ) AS message_count,
                    (
                        SELECT MAX(contexts.created_at)
                        FROM contexts
                        WHERE contexts.channel_id = channels.id
                          AND contexts.visibility = 'channel'
                    ) AS latest_message_at
                FROM channels
                WHERE EXISTS (
                    SELECT 1
                    FROM contexts
                    WHERE contexts.channel_id = channels.id
                      AND contexts.visibility = 'channel'
                )
                ORDER BY latest_message_at DESC NULLS LAST, channels.id DESC
            `,
        ),
        db.query<MessageEnvelopeRow>(
            `
                SELECT
                    contexts.id,
                    contexts.visibility,
                    channels.id AS channel_id,
                    channels.slug AS channel_slug,
                    channels.name AS channel_name,
                    actors.id AS actor_id,
                    actors.external_id AS actor_external_id,
                    actors.name AS actor_name,
                    actors.kind AS actor_kind,
                    (
                        SELECT COUNT(*)::int
                        FROM context_acknowledgements
                        WHERE context_acknowledgements.context_id = contexts.id
                    ) AS acknowledgement_count,
                    contexts.created_at,
                    contexts.updated_at
                FROM contexts
                LEFT JOIN actors ON actors.id = contexts.actor_id
                LEFT JOIN channels ON channels.id = contexts.channel_id
                WHERE contexts.visibility IN ('channel', 'direct')
                ORDER BY contexts.created_at DESC, contexts.id DESC
                LIMIT $1
            `,
            [boundedLimit],
        ),
    ]);

    return {
        generated_at: new Date().toISOString(),
        whiteboard: whiteboard.map(inspectionContext),
        private_channels: channels.rows.map((row) => ({
            id: Number(row.id),
            slug: row.slug,
            name: row.name,
            participants: parseParticipants(row.participants),
            message_count: Number(row.message_count),
            latest_message_at: row.latest_message_at === null
                ? null
                : timestamp(row.latest_message_at),
        })),
        private_messages: messages.rows.map((row) => ({
            id: Number(row.id),
            visibility: row.visibility,
            channel: row.channel_id === null
                ? null
                : {
                    id: Number(row.channel_id),
                    slug: row.channel_slug ?? "private-channel",
                    name: row.channel_name ?? "Private channel",
                },
            sender: row.actor_id === null
                ? null
                : {
                    id: Number(row.actor_id),
                    external_id: row.actor_external_id,
                    name: row.actor_name ?? "Unknown actor",
                    kind: row.actor_kind,
                },
            acknowledgement_count: Number(row.acknowledgement_count),
            created_at: timestamp(row.created_at),
            updated_at: timestamp(row.updated_at),
        })),
        privacy: { private_message_contents_exposed: false },
    };
}

export type WhiteboardEditResult =
    | { status: "updated"; context: InspectionWhiteboardContext }
    | { status: "not_found" }
    | { status: "conflict"; context: InspectionWhiteboardContext }
    | { status: "blocked"; reason: string; context: InspectionWhiteboardContext };

export async function createInspectionWhiteboardContext(
    content: string,
): Promise<InspectionWhiteboardContext> {
    const result = await saveContextWithActor(
        content,
        [],
        "inspection-tool",
        {
            external_id: "actor:human:blake",
            name: "Blake",
            kind: "human",
        },
        null,
        "whiteboard",
    );
    return inspectionContext(result.context);
}

export async function updateInspectionWhiteboardContext(
    id: number,
    content: string,
    expectedUpdatedAt: string,
): Promise<WhiteboardEditResult> {
    await initializeDatabase();
    const existing = await getContext(id);
    if (!existing) return { status: "not_found" };
    const visible = inspectionContext(existing);
    if (!visible.editable) {
        return {
            status: "blocked",
            reason: visible.edit_blocked_reason ?? "This context is not editable.",
            context: visible,
        };
    }
    if (existing.updated_at !== expectedUpdatedAt) {
        return { status: "conflict", context: visible };
    }

    const now = new Date().toISOString();
    const result = await db.query(
        `
            UPDATE contexts
            SET content = $2, updated_at = $3
            WHERE id = $1
              AND visibility = 'whiteboard'
              AND updated_at = $4::timestamptz
            RETURNING id
        `,
        [id, content, now, expectedUpdatedAt],
    );
    if (result.rowCount !== 1) {
        const latest = await getContext(id);
        return latest
            ? { status: "conflict", context: inspectionContext(latest) }
            : { status: "not_found" };
    }

    const updated = await getContext(id);
    if (!updated) return { status: "not_found" };
    await maybeSaveContextEmbedding(updated);
    return { status: "updated", context: inspectionContext(updated) };
}

export type WhiteboardDeleteResult =
    | { status: "deleted"; id: number }
    | { status: "not_found" }
    | { status: "conflict"; context: InspectionWhiteboardContext }
    | { status: "blocked"; reason: string; context: InspectionWhiteboardContext };

export async function deleteInspectionWhiteboardContext(
    id: number,
    expectedUpdatedAt: string,
): Promise<WhiteboardDeleteResult> {
    await initializeDatabase();
    const existing = await getContext(id);
    if (!existing) return { status: "not_found" };
    const visible = inspectionContext(existing);
    if (!visible.editable) {
        return {
            status: "blocked",
            reason: "This note is an agent inbox item. Deleting it could change invocation delivery.",
            context: visible,
        };
    }
    if (existing.updated_at !== expectedUpdatedAt) {
        return { status: "conflict", context: visible };
    }
    const result = await db.query(
        `
            DELETE FROM contexts
            WHERE id = $1
              AND visibility = 'whiteboard'
              AND updated_at = $2::timestamptz
            RETURNING id
        `,
        [id, expectedUpdatedAt],
    );
    if (result.rowCount === 1) return { status: "deleted", id };
    const latest = await getContext(id);
    return latest
        ? { status: "conflict", context: inspectionContext(latest) }
        : { status: "not_found" };
}
