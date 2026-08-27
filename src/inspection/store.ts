import { maybeSaveContextEmbedding } from "../embeddings/index.js";
import { db, initializeDatabase } from "../storage/db.js";
import {
    getContext,
    identifyActor,
    listRecentContext,
    saveContextWithActor,
    type ActorRecord,
    type ContextAcknowledgement,
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
    archive: ArchivedWhiteboardContext[];
    private_channels: PrivateChannelSummary[];
    private_messages: PrivateMessageEnvelope[];
    privacy: {
        private_message_contents_exposed: false;
    };
};

export type ArchivedWhiteboardContext = ContextRecord & {
    archive: {
        reason: string;
        archived_at: string;
        archived_by: ActorRecord;
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

type ArchivedContextRow = {
    id: number | string;
    kind: string;
    visibility: "archived";
    content: string;
    source: string | null;
    tags: string[] | string | null;
    created_at: string | Date;
    updated_at: string | Date;
    actor_id: number | string | null;
    actor_external_id: string | null;
    actor_name: string | null;
    actor_kind: string | null;
    actor_created_at: string | Date | null;
    actor_last_seen_at: string | Date | null;
    subject: unknown;
    payload_ref: unknown;
    acknowledged_by: unknown;
    reason: string;
    archived_at: string | Date;
    archived_by_id: number | string;
    archived_by_external_id: string | null;
    archived_by_name: string;
    archived_by_kind: string | null;
    archived_by_created_at: string | Date;
    archived_by_last_seen_at: string | Date;
};

function timestamp(value: string | Date) {
    return value instanceof Date ? value.toISOString() : value;
}

function tags(value: string[] | string | null) {
    if (Array.isArray(value)) return value;
    if (!value) return [];
    try {
        const parsed = JSON.parse(value) as unknown;
        if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === "string");
    } catch {
        // Legacy scalar tag formats fall back to comma splitting.
    }
    return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function acknowledgements(value: unknown): ContextAcknowledgement[] {
    const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => {
        const acknowledgement = item as Record<string, unknown>;
        return {
            id: Number(acknowledgement.id),
            external_id: typeof acknowledgement.external_id === "string"
                ? acknowledgement.external_id
                : null,
            name: typeof acknowledgement.name === "string"
                ? acknowledgement.name
                : "Unknown actor",
            kind: typeof acknowledgement.kind === "string" ? acknowledgement.kind : null,
            acknowledged_at: timestamp(acknowledgement.acknowledged_at as string | Date),
        };
    });
}

function mapArchivedContext(row: ArchivedContextRow): ArchivedWhiteboardContext {
    const subject = row.subject as Record<string, unknown> | null;
    const payload = row.payload_ref as Record<string, unknown>;
    return {
        id: Number(row.id),
        kind: row.kind,
        visibility: row.visibility,
        channel_id: null,
        group_id: null,
        content: row.content,
        source: row.source,
        tags: tags(row.tags),
        actor: row.actor_id === null
            ? null
            : {
                id: Number(row.actor_id),
                external_id: row.actor_external_id,
                name: row.actor_name ?? "Unknown actor",
                kind: row.actor_kind,
                created_at: timestamp(row.actor_created_at!),
                last_seen_at: timestamp(row.actor_last_seen_at!),
            },
        subject: subject
            ? {
                id: Number(subject.id),
                external_id: String(subject.external_id),
                name: String(subject.name),
                kind: typeof subject.kind === "string" ? subject.kind : null,
                aliases: tags(subject.aliases as string[] | string | null),
                created_at: timestamp(subject.created_at as string | Date),
                updated_at: timestamp(subject.updated_at as string | Date),
            }
            : null,
        payload_ref: {
            id: String(payload.id),
            version: Number(payload.version),
            kind: "text",
            media_type: String(payload.media_type),
            size_bytes: Number(payload.size_bytes),
        },
        acknowledged_by: acknowledgements(row.acknowledged_by),
        created_at: timestamp(row.created_at),
        updated_at: timestamp(row.updated_at),
        archive: {
            reason: row.reason,
            archived_at: timestamp(row.archived_at),
            archived_by: {
                id: Number(row.archived_by_id),
                external_id: row.archived_by_external_id,
                name: row.archived_by_name,
                kind: row.archived_by_kind,
                created_at: timestamp(row.archived_by_created_at),
                last_seen_at: timestamp(row.archived_by_last_seen_at),
            },
        },
    };
}

async function listInspectionArchive(limit: number, contextId?: number) {
    const result = await db.query<ArchivedContextRow>(
        `
            SELECT
                contexts.id,
                contexts.kind,
                contexts.visibility,
                contexts.content,
                contexts.source,
                contexts.tags,
                contexts.created_at,
                contexts.updated_at,
                (
                    SELECT jsonb_build_object(
                        'id', subjects.id,
                        'external_id', subjects.external_id,
                        'name', subjects.name,
                        'kind', subjects.kind,
                        'aliases', subjects.aliases,
                        'created_at', subjects.created_at,
                        'updated_at', subjects.updated_at
                    )
                    FROM subjects
                    WHERE subjects.id = contexts.subject_id
                ) AS subject,
                (
                    SELECT jsonb_build_object(
                        'id', context_payloads.id,
                        'version', context_payloads.version,
                        'kind', context_payloads.kind,
                        'media_type', context_payloads.media_type,
                        'size_bytes', context_payloads.size_bytes
                    )
                    FROM context_payloads
                    WHERE context_payloads.context_id = contexts.id
                      AND context_payloads.version = contexts.payload_version
                ) AS payload_ref,
                authors.id AS actor_id,
                authors.external_id AS actor_external_id,
                authors.name AS actor_name,
                authors.kind AS actor_kind,
                authors.created_at AS actor_created_at,
                authors.last_seen_at AS actor_last_seen_at,
                COALESCE((
                    SELECT jsonb_agg(
                        jsonb_build_object(
                            'id', acknowledging_actors.id,
                            'external_id', acknowledging_actors.external_id,
                            'name', acknowledging_actors.name,
                            'kind', acknowledging_actors.kind,
                            'acknowledged_at', context_acknowledgements.acknowledged_at
                        )
                        ORDER BY context_acknowledgements.acknowledged_at, acknowledging_actors.id
                    )
                    FROM context_acknowledgements
                    INNER JOIN actors AS acknowledging_actors
                        ON acknowledging_actors.id = context_acknowledgements.actor_id
                    WHERE context_acknowledgements.context_id = contexts.id
                ), '[]'::jsonb) AS acknowledged_by,
                context_archives.reason,
                context_archives.archived_at,
                archived_by.id AS archived_by_id,
                archived_by.external_id AS archived_by_external_id,
                archived_by.name AS archived_by_name,
                archived_by.kind AS archived_by_kind,
                archived_by.created_at AS archived_by_created_at,
                archived_by.last_seen_at AS archived_by_last_seen_at
            FROM contexts
            INNER JOIN context_archives
                ON context_archives.context_id = contexts.id
               AND context_archives.restored_at IS NULL
            LEFT JOIN actors AS authors ON authors.id = contexts.actor_id
            INNER JOIN actors AS archived_by
                ON archived_by.id = context_archives.archived_by_actor_id
            WHERE contexts.visibility = 'archived'
              AND ($2::bigint IS NULL OR contexts.id = $2)
            ORDER BY context_archives.archived_at DESC, context_archives.id DESC
            LIMIT $1
        `,
        [limit, contextId ?? null],
    );
    return result.rows.map(mapArchivedContext);
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
    const [whiteboard, channels, messages, archive] = await Promise.all([
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
        listInspectionArchive(boundedLimit),
    ]);

    return {
        generated_at: new Date().toISOString(),
        whiteboard: whiteboard.map(inspectionContext),
        archive,
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

const INSPECTION_ACTOR = {
    external_id: "actor:human:blake",
    name: "Blake",
    kind: "human",
} as const;

export async function createInspectionWhiteboardContext(
    content: string,
): Promise<InspectionWhiteboardContext> {
    const result = await saveContextWithActor(
        content,
        [],
        "inspection-tool",
        INSPECTION_ACTOR,
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

export type WhiteboardArchiveResult =
    | { status: "archived"; context: ArchivedWhiteboardContext }
    | { status: "not_found" }
    | { status: "conflict"; context: InspectionWhiteboardContext }
    | { status: "blocked"; reason: string; context: InspectionWhiteboardContext };

export async function archiveInspectionWhiteboardContext(
    id: number,
    expectedUpdatedAt: string,
    reason: string,
): Promise<WhiteboardArchiveResult> {
    await initializeDatabase();
    const existing = await getContext(id);
    if (!existing) return { status: "not_found" };
    const visible = inspectionContext(existing);
    if (!visible.editable) {
        return {
            status: "blocked",
            reason: "This note is an agent inbox item. Archiving it could change invocation delivery.",
            context: visible,
        };
    }
    if (existing.updated_at !== expectedUpdatedAt) {
        return { status: "conflict", context: visible };
    }

    const archivedBy = await identifyActor(INSPECTION_ACTOR);
    const client = await db.connect();
    const archivedAt = new Date().toISOString();
    try {
        await client.query("BEGIN");
        const updated = await client.query(
            `
                UPDATE contexts
                SET visibility = 'archived', updated_at = $3
                WHERE id = $1
                  AND visibility = 'whiteboard'
                  AND updated_at = $2::timestamptz
                RETURNING id
            `,
            [id, expectedUpdatedAt, archivedAt],
        );
        if (updated.rowCount !== 1) {
            await client.query("ROLLBACK");
            const latest = await getContext(id);
            return latest
                ? { status: "conflict", context: inspectionContext(latest) }
                : { status: "not_found" };
        }
        await client.query(
            `
                INSERT INTO context_archives (
                    context_id, reason, archived_by_actor_id, archived_at
                )
                VALUES ($1, $2, $3, $4)
            `,
            [id, reason.trim(), archivedBy.actor.id, archivedAt],
        );
        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
    const archived = (await listInspectionArchive(1, id))[0];
    if (!archived) return { status: "not_found" };
    return { status: "archived", context: archived };
}

export type WhiteboardRestoreResult =
    | { status: "restored"; context: InspectionWhiteboardContext }
    | { status: "not_found" }
    | { status: "conflict"; context: ArchivedWhiteboardContext };

export async function restoreInspectionWhiteboardContext(
    id: number,
    expectedUpdatedAt: string,
): Promise<WhiteboardRestoreResult> {
    await initializeDatabase();
    const archived = (await listInspectionArchive(1, id))[0];
    if (!archived) return { status: "not_found" };
    if (archived.updated_at !== expectedUpdatedAt) {
        return { status: "conflict", context: archived };
    }
    const restoredBy = await identifyActor(INSPECTION_ACTOR);
    const client = await db.connect();
    const restoredAt = new Date().toISOString();
    try {
        await client.query("BEGIN");
        const updated = await client.query(
            `
                UPDATE contexts
                SET visibility = 'whiteboard', updated_at = $3
                WHERE id = $1
                  AND visibility = 'archived'
                  AND updated_at = $2::timestamptz
                RETURNING id
            `,
            [id, expectedUpdatedAt, restoredAt],
        );
        if (updated.rowCount !== 1) {
            await client.query("ROLLBACK");
            const latest = (await listInspectionArchive(1, id))[0];
            return latest
                ? { status: "conflict", context: latest }
                : { status: "not_found" };
        }
        const history = await client.query(
            `
                UPDATE context_archives
                SET restored_by_actor_id = $2, restored_at = $3
                WHERE context_id = $1
                  AND restored_at IS NULL
            `,
            [id, restoredBy.actor.id, restoredAt],
        );
        if (history.rowCount !== 1) throw new Error("Active archive history was not found.");
        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
    const restored = await getContext(id);
    if (!restored) return { status: "not_found" };
    return { status: "restored", context: inspectionContext(restored) };
}
