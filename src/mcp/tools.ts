import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import type { PoolClient } from "pg";

import { maybeGenerateEmbedding, maybeSaveContextEmbedding } from "../embeddings/index.js";
import { db, initializeDatabase } from "../storage/db.js";

export type ContextRecord = {
    id: number;
    kind: string;
    visibility: ContextVisibility;
    channel_id: number | null;
    group_id: number | null;
    content: string;
    source: string | null;
    tags: string[];
    actor: ActorRecord | null;
    subject: SubjectRecord | null;
    payload_ref: ContextPayloadReference | null;
    acknowledged_by: ContextAcknowledgement[];
    created_at: string;
    updated_at: string;
};

export type ContextPayloadReference = {
    id: string;
    version: number;
    kind: "text";
    media_type: string;
    size_bytes: number;
};

export type SubjectRecord = {
    id: number;
    external_id: string;
    name: string;
    kind: string | null;
    aliases: string[];
    created_at: string;
    updated_at: string;
};

export type SubjectIdentity = {
    external_id: string;
    name: string;
    kind?: string;
    aliases?: string[];
};

export type ContextAcknowledgement = {
    id: number;
    external_id: string | null;
    name: string;
    kind: string | null;
    acknowledged_at: string;
};

export type ActorRecord = {
    id: number;
    external_id: string | null;
    name: string;
    kind: string | null;
    created_at: string;
    last_seen_at: string;
};

export type ActorIdentity = {
    external_id?: string;
    name: string;
    kind?: string;
    metadata?: Record<string, unknown>;
};

export type SaveContextResult = {
    context: ContextRecord;
    actor_resolution?: {
        created: boolean;
    };
    subject_resolution?: {
        created: boolean;
    };
};

export type AcknowledgeContextResult = {
    context: ContextRecord | null;
    actor: ActorRecord | null;
    acknowledged: boolean;
    actor_resolution?: {
        created: boolean;
    };
};

export type DirectInboxEnvelope = {
    sequence: number;
    context: ContextRecord;
    acknowledged_at: string | null;
};

export const SEARCH_SENSITIVITY_VALUES = ["low", "medium", "high"] as const;
export type SearchSensitivity = (typeof SEARCH_SENSITIVITY_VALUES)[number];
export const CONTEXT_VISIBILITY_VALUES = [
    "whiteboard",
    "channel",
    "direct",
    "personal",
    "system",
    "group",
    "archived",
] as const;
export type ContextVisibility = (typeof CONTEXT_VISIBILITY_VALUES)[number];
export const WRITABLE_CONTEXT_VISIBILITY_VALUES = ["whiteboard"] as const;
export type WritableContextVisibility = (typeof WRITABLE_CONTEXT_VISIBILITY_VALUES)[number];
export const USER_PROFILE_TAG = "profile";

type ContextRow = {
    id: number | string;
    kind: string;
    visibility: ContextVisibility;
    channel_id: number | string | null;
    group_id: number | string | null;
    content: string;
    source: string | null;
    tags: string | string[] | null;
    actor_id: number | string | null;
    actor_external_id: string | null;
    actor_name: string | null;
    actor_kind: string | null;
    actor_created_at: string | Date | null;
    actor_last_seen_at: string | Date | null;
    subject: unknown;
    payload_ref: unknown;
    acknowledged_by: unknown;
    created_at: string | Date;
    updated_at: string | Date;
};

type SubjectRow = {
    id: number | string;
    external_id: string;
    name: string;
    kind: string | null;
    aliases: string[] | string | null;
    created_at: string | Date;
    updated_at: string | Date;
};

type ActorRow = {
    id: number | string;
    external_id: string | null;
    name: string;
    kind: string | null;
    metadata: Record<string, unknown> | null;
    created_at: string | Date;
    last_seen_at: string | Date;
};

type VectorSearchRow = ContextRow & {
    model: string | null;
    vector: unknown;
};

type DatabaseMetadataRow = {
    context_count: string;
    actor_count: string;
    orphan_actor_count: string;
    purgeable_actor_count: string;
    total_size_bytes: string;
    total_size_pretty: string;
    contexts_size_bytes: string;
    contexts_size_pretty: string;
    embeddings_size_bytes: string;
    embeddings_size_pretty: string;
    actors_size_bytes: string;
    actors_size_pretty: string;
};

type DatabaseMetadata = {
    context_count: number;
    actor_count: number;
    orphan_actor_count: number;
    purgeable_actor_count: number;
    total_size: {
        bytes: number;
        pretty: string;
    };
    tables: {
        contexts: {
            bytes: number;
            pretty: string;
        };
        embeddings: {
            bytes: number;
            pretty: string;
        };
        actors: {
            bytes: number;
            pretty: string;
        };
    };
};

type PurgePreviewRow = {
    matched: string;
    oldest: string | Date | null;
    newest: string | Date | null;
};

type PendingPurge = {
    before: string;
    matched: number;
    expiresAt: Date;
};

const DEFAULT_CONTEXT_LIMIT = 5;
const MAX_CONTEXT_LIMIT = 100;
const DEFAULT_SEARCH_SENSITIVITY: SearchSensitivity = "high";
const DEFAULT_CONTEXT_VISIBILITY: WritableContextVisibility = "whiteboard";
const WHITEBOARD_READ_PREDICATE = "contexts.visibility = 'whiteboard'";
const PURGE_CONFIRMATION_TTL_MS = 10 * 60 * 1000;
let tagsColumnType: string | undefined;
const pendingContextPurges = new Map<string, PendingPurge>();
const pendingActorPurges = new Map<string, PendingPurge>();

function normalizeLimit(limit?: number) {
    if (limit === undefined) {
        return DEFAULT_CONTEXT_LIMIT;
    }

    return Math.min(Math.max(Math.trunc(limit), 1), MAX_CONTEXT_LIMIT);
}

export function similarityThresholdForSensitivity(sensitivity: SearchSensitivity) {
    switch (sensitivity) {
        case "high":
            return 0.75;
        case "medium":
            return 0.5;
        case "low":
            return -1;
    }
}

export function matchesSearchSensitivity(
    similarity: number,
    sensitivity: SearchSensitivity,
) {
    return similarity >= similarityThresholdForSensitivity(sensitivity);
}

export async function resolveSearchResultsWithFallback(
    vectorResults: ContextRecord[] | null,
    textFallback: () => Promise<ContextRecord[]>,
) {
    return vectorResults === null ? textFallback() : vectorResults;
}

export function mergeHybridSearchResults(
    textResults: ContextRecord[],
    vectorResults: ContextRecord[],
    limit: number,
) {
    const merged: ContextRecord[] = [];
    const seen = new Set<number>();

    // A literal match in content, source, or tags is strong evidence and also
    // keeps records without embeddings discoverable. Semantic matches then
    // broaden recall without duplicating records returned by both paths.
    for (const context of [...textResults, ...vectorResults]) {
        if (seen.has(context.id)) continue;
        seen.add(context.id);
        merged.push(context);
        if (merged.length >= limit) break;
    }

    return merged;
}

function parseTags(tags: string | string[] | null) {
    if (!tags) {
        return [];
    }

    if (Array.isArray(tags)) {
        return tags.filter((tag): tag is string => typeof tag === "string");
    }

    try {
        const parsedTags: unknown = JSON.parse(tags);

        if (Array.isArray(parsedTags)) {
            return parsedTags.filter((tag): tag is string => typeof tag === "string");
        }
    } catch {
        // Older rows may have plain text tags. Fall back to comma splitting below.
    }

    return tags
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean);
}

function normalizeTimestamp(value: string | Date) {
    return value instanceof Date ? value.toISOString() : value;
}

function normalizeNullableTimestamp(value: string | Date | null) {
    return value === null ? null : normalizeTimestamp(value);
}

function normalizePurgeCutoff(before: string) {
    const cutoff = new Date(before);

    if (Number.isNaN(cutoff.getTime())) {
        throw new Error("before must be a valid date or timestamp.");
    }

    return cutoff.toISOString();
}

function parseAcknowledgements(value: unknown): ContextAcknowledgement[] {
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
            acknowledged_at: normalizeTimestamp(
                acknowledgement.acknowledged_at as string | Date,
            ),
        };
    });
}

function mapContextRow(row: ContextRow): ContextRecord {
    return {
        id: Number(row.id),
        kind: row.kind,
        visibility: row.visibility,
        channel_id: row.channel_id === null ? null : Number(row.channel_id),
        group_id: row.group_id === null ? null : Number(row.group_id),
        content: row.content,
        source: row.source,
        tags: parseTags(row.tags),
        actor: row.actor_id === null
            ? null
            : {
                  id: Number(row.actor_id),
                  external_id: row.actor_external_id,
                  name: row.actor_name ?? "Unknown actor",
                  kind: row.actor_kind,
                  created_at: normalizeTimestamp(row.actor_created_at!),
                  last_seen_at: normalizeTimestamp(row.actor_last_seen_at!),
              },
        subject: row.subject ? mapSubjectRow(row.subject as SubjectRow) : null,
        payload_ref: mapPayloadReference(row.payload_ref),
        acknowledged_by: parseAcknowledgements(row.acknowledged_by),
        created_at: normalizeTimestamp(row.created_at),
        updated_at: normalizeTimestamp(row.updated_at),
    };
}

function mapPayloadReference(value: unknown): ContextPayloadReference | null {
    const payload = value as Record<string, unknown> | null;
    if (!payload) return null;
    return {
        id: String(payload.id),
        version: Number(payload.version),
        kind: "text",
        media_type: String(payload.media_type),
        size_bytes: Number(payload.size_bytes),
    };
}

async function loadCurrentPayloadReference(row: ContextRow, client: PoolClient | typeof db = db) {
    if (row.payload_ref) return row;
    const result = await client.query<{ payload_ref: unknown }>(
        `SELECT jsonb_build_object(
            'id', id, 'version', version, 'kind', kind,
            'media_type', media_type, 'size_bytes', size_bytes
         ) AS payload_ref
         FROM context_payloads
         WHERE context_id = $1
         ORDER BY version DESC
         LIMIT 1`,
        [row.id],
    );
    row.payload_ref = result.rows[0]?.payload_ref ?? null;
    return row;
}

function mapSubjectRow(row: SubjectRow): SubjectRecord {
    return {
        id: Number(row.id),
        external_id: row.external_id,
        name: row.name,
        kind: row.kind,
        aliases: parseTags(row.aliases),
        created_at: normalizeTimestamp(row.created_at),
        updated_at: normalizeTimestamp(row.updated_at),
    };
}

function mapActorRow(row: ActorRow): ActorRecord {
    return {
        id: Number(row.id),
        external_id: row.external_id,
        name: row.name,
        kind: row.kind,
        created_at: normalizeTimestamp(row.created_at),
        last_seen_at: normalizeTimestamp(row.last_seen_at),
    };
}

const CONTEXT_PROJECTION = `
    contexts.id,
    contexts.kind,
    contexts.visibility,
    contexts.channel_id,
    contexts.group_id,
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
    actors.id AS actor_id,
    actors.external_id AS actor_external_id,
    actors.name AS actor_name,
    actors.kind AS actor_kind,
    actors.created_at AS actor_created_at,
    actors.last_seen_at AS actor_last_seen_at,
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
    ), '[]'::jsonb) AS acknowledged_by
`;

function subjectProjection(contextAlias: "inserted" | "updated" | "deleted") {
    return `
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
            WHERE subjects.id = ${contextAlias}.subject_id
        ) AS subject
    `;
}

function payloadProjection(contextAlias: "inserted" | "updated" | "deleted") {
    return `
        (
            SELECT jsonb_build_object(
                'id', context_payloads.id,
                'version', context_payloads.version,
                'kind', context_payloads.kind,
                'media_type', context_payloads.media_type,
                'size_bytes', context_payloads.size_bytes
            )
            FROM context_payloads
            WHERE context_payloads.context_id = ${contextAlias}.id
              AND context_payloads.version = ${contextAlias}.payload_version
        ) AS payload_ref
    `;
}

function parseEmbeddingVector(value: unknown) {
    if (!value) {
        return null;
    }

    if (
        Array.isArray(value) &&
        value.length > 0 &&
        value.every((item) => typeof item === "number")
    ) {
        return value;
    }

    if (typeof value !== "string") {
        return null;
    }

    try {
        const parsedValue: unknown = JSON.parse(value);

        if (
            Array.isArray(parsedValue) &&
            parsedValue.length > 0 &&
            parsedValue.every((item) => typeof item === "number")
        ) {
            return parsedValue;
        }
    } catch {
        return null;
    }

    return null;
}

function cosineSimilarity(left: number[], right: number[]) {
    if (left.length !== right.length || left.length === 0) {
        return null;
    }

    let dotProduct = 0;
    let leftMagnitude = 0;
    let rightMagnitude = 0;

    for (let index = 0; index < left.length; index += 1) {
        const leftValue = left[index];
        const rightValue = right[index];

        dotProduct += leftValue * rightValue;
        leftMagnitude += leftValue * leftValue;
        rightMagnitude += rightValue * rightValue;
    }

    if (leftMagnitude === 0 || rightMagnitude === 0) {
        return null;
    }

    return dotProduct / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

function cleanupExpiredPurgeConfirmations(
    pendingPurges: Map<string, PendingPurge>,
    now = new Date(),
) {
    for (const [token, pendingPurge] of pendingPurges) {
        if (pendingPurge.expiresAt <= now) {
            pendingPurges.delete(token);
        }
    }
}

async function getTagsColumnType() {
    if (tagsColumnType) {
        return tagsColumnType;
    }

    const result = await db.query<{ udt_name: string }>(
        `
            SELECT udt_name
            FROM information_schema.columns
            WHERE table_name = 'contexts'
              AND column_name = 'tags'
            LIMIT 1
        `
    );

    tagsColumnType = result.rows[0]?.udt_name ?? "text";

    return tagsColumnType;
}

async function resolveActor(identity: ActorIdentity, client: PoolClient) {
    const now = new Date().toISOString();
    const externalId = identity.external_id?.trim() || null;
    const name = identity.name.trim();
    const kind = identity.kind?.trim() || null;
    const metadata = identity.metadata ?? null;

    if (!name) {
        throw new Error("name must contain at least one non-whitespace character.");
    }

    if (externalId === null) {
        const result = await client.query<ActorRow>(
            `
                INSERT INTO actors (external_id, name, kind, metadata, created_at, last_seen_at)
                VALUES (NULL, $1, $2, $3, $4, $4)
                RETURNING id, external_id, name, kind, metadata, created_at, last_seen_at
            `,
            [name, kind, metadata, now]
        );

        return { actor: mapActorRow(result.rows[0]), created: true };
    }

    const inserted = await client.query<ActorRow>(
        `
            INSERT INTO actors (external_id, name, kind, metadata, created_at, last_seen_at)
            VALUES ($1, $2, $3, $4, $5, $5)
            ON CONFLICT (external_id) WHERE external_id IS NOT NULL DO NOTHING
            RETURNING id, external_id, name, kind, metadata, created_at, last_seen_at
        `,
        [externalId, name, kind, metadata, now]
    );

    if (inserted.rows[0]) {
        return { actor: mapActorRow(inserted.rows[0]), created: true };
    }

    const resolved = await client.query<ActorRow>(
        `
            UPDATE actors
            SET last_seen_at = $2
            WHERE external_id = $1
            RETURNING id, external_id, name, kind, metadata, created_at, last_seen_at
        `,
        [externalId, now]
    );

    return { actor: mapActorRow(resolved.rows[0]), created: false };
}

async function resolveSubject(identity: SubjectIdentity, client: PoolClient) {
    const externalId = identity.external_id.trim();
    const name = identity.name.trim();
    const kind = identity.kind?.trim() || null;
    const aliases = [...new Set((identity.aliases ?? []).map((alias) => alias.trim()).filter(Boolean))];

    if (!/^subject:[a-z0-9][a-z0-9:_-]*$/.test(externalId)) {
        throw new Error("subject.external_id must use the subject: namespace and lowercase letters, digits, colons, underscores, or hyphens.");
    }
    if (!name) {
        throw new Error("subject.name must contain at least one non-whitespace character.");
    }

    const inserted = await client.query<SubjectRow>(
        `
            INSERT INTO subjects (external_id, name, kind, aliases)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (external_id) DO NOTHING
            RETURNING id, external_id, name, kind, aliases, created_at, updated_at
        `,
        [externalId, name, kind, aliases],
    );
    if (inserted.rows[0]) {
        return { subject: mapSubjectRow(inserted.rows[0]), created: true };
    }

    const resolved = await client.query<SubjectRow>(
        `
            SELECT id, external_id, name, kind, aliases, created_at, updated_at
            FROM subjects
            WHERE external_id = $1
        `,
        [externalId],
    );
    return { subject: mapSubjectRow(resolved.rows[0]), created: false };
}

export async function identifyActor(identity: ActorIdentity) {
    await initializeDatabase();
    const client = await db.connect();

    try {
        return await resolveActor(identity, client);
    } finally {
        client.release();
    }
}

export async function saveDirectContext(
    senderActorId: number,
    recipientExternalId: string,
    text: string,
    tags?: string[],
    source?: string,
    subject?: SubjectIdentity,
) {
    await initializeDatabase();
    const client = await db.connect();
    try {
        await client.query("BEGIN");
        const identifiedSubject = subject ? await resolveSubject(subject, client) : null;
        const recipient = await client.query<{ id: number | string }>(
            "SELECT id FROM actors WHERE external_id = $1",
            [recipientExternalId],
        );
        if (!recipient.rows[0]) throw new Error("Recipient actor is not registered.");
        const context = await insertContext(
            client, text, tags, source, senderActorId, "direct",
            null, null, identifiedSubject?.subject.id ?? null,
        );
        const envelope = await client.query<{ sequence: number | string }>(
            `INSERT INTO direct_context_envelopes (context_id, recipient_actor_id)
             VALUES ($1, $2) RETURNING sequence`,
            [context.id, recipient.rows[0].id],
        );
        await client.query("COMMIT");
        return { sequence: Number(envelope.rows[0].sequence), context, acknowledged_at: null };
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

type DirectInboxRow = ContextRow & { sequence: number | string; recipient_acknowledged_at: string | Date | null };

export async function listDirectInbox(actorId: number, options: { limit?: number; unreadOnly?: boolean; sinceSequence?: number } = {}) {
    await initializeDatabase();
    const result = await db.query<DirectInboxRow>(
        `SELECT ${CONTEXT_PROJECTION}, direct_context_envelopes.sequence,
                recipient_ack.acknowledged_at AS recipient_acknowledged_at
         FROM direct_context_envelopes
         INNER JOIN contexts ON contexts.id = direct_context_envelopes.context_id
         LEFT JOIN actors ON actors.id = contexts.actor_id
         LEFT JOIN context_acknowledgements AS recipient_ack
           ON recipient_ack.context_id = contexts.id AND recipient_ack.actor_id = $1
         WHERE direct_context_envelopes.recipient_actor_id = $1
           AND contexts.visibility = 'direct'
           AND ($2::boolean = FALSE OR recipient_ack.context_id IS NULL)
           AND ($3::bigint IS NULL OR direct_context_envelopes.sequence > $3)
         ORDER BY direct_context_envelopes.sequence DESC
         LIMIT $4`,
        [actorId, options.unreadOnly === true, options.sinceSequence ?? null, normalizeLimit(options.limit)],
    );
    return result.rows.map((row): DirectInboxEnvelope => ({
        sequence: Number(row.sequence),
        context: mapContextRow(row),
        acknowledged_at: normalizeNullableTimestamp(row.recipient_acknowledged_at),
    }));
}

export async function getDirectContext(actorId: number, id: number) {
    await initializeDatabase();
    const result = await db.query<DirectInboxRow>(
        `SELECT ${CONTEXT_PROJECTION}, direct_context_envelopes.sequence,
                recipient_ack.acknowledged_at AS recipient_acknowledged_at
         FROM direct_context_envelopes
         INNER JOIN contexts ON contexts.id = direct_context_envelopes.context_id
         LEFT JOIN actors ON actors.id = contexts.actor_id
         LEFT JOIN context_acknowledgements AS recipient_ack
           ON recipient_ack.context_id = contexts.id AND recipient_ack.actor_id = $1
         WHERE contexts.id = $2 AND contexts.visibility = 'direct'
           AND direct_context_envelopes.recipient_actor_id = $1`,
        [actorId, id],
    );
    const row = result.rows[0];
    return row ? { sequence: Number(row.sequence), context: mapContextRow(row), acknowledged_at: normalizeNullableTimestamp(row.recipient_acknowledged_at) } : null;
}

export async function acknowledgeDirectContext(actorId: number, id: number) {
    await initializeDatabase();
    const result = await db.query<{ acknowledged_at: string | Date }>(
        `INSERT INTO context_acknowledgements (context_id, actor_id)
         SELECT contexts.id, $1
         FROM contexts INNER JOIN direct_context_envelopes ON direct_context_envelopes.context_id = contexts.id
         WHERE contexts.id = $2 AND contexts.visibility = 'direct'
           AND direct_context_envelopes.recipient_actor_id = $1
         ON CONFLICT (context_id, actor_id) DO UPDATE
           SET acknowledged_at = context_acknowledgements.acknowledged_at
         RETURNING acknowledged_at`,
        [actorId, id],
    );
    return result.rows[0] ? { acknowledged: true, acknowledged_at: normalizeTimestamp(result.rows[0].acknowledged_at) } : null;
}

async function insertContext(
    client: PoolClient,
    text: string,
    tags: string[] | undefined,
    source: string | undefined,
    actorId: number | null,
    visibility: ContextVisibility | undefined,
    channelId: number | null = null,
    groupId: number | null = null,
    subjectId: number | null = null,
) {
    const now = new Date().toISOString();
    const tagList = tags ?? [];
    const tagValue = (await getTagsColumnType()) === "_text" ? tagList : JSON.stringify(tagList);
    const result = await client.query<ContextRow>(
        `
            WITH inserted AS (
                INSERT INTO contexts (
                    kind,
                    visibility,
                    content,
                    source,
                    tags,
                    actor_id,
                    channel_id,
                    group_id,
                    subject_id,
                    created_at,
                    updated_at
                )
                VALUES ('note', $1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
                RETURNING *
            )
            SELECT
                inserted.id,
                inserted.kind,
                inserted.visibility,
                inserted.channel_id,
                inserted.group_id,
                inserted.content,
                inserted.source,
                inserted.tags,
                inserted.created_at,
                inserted.updated_at,
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
                    WHERE subjects.id = inserted.subject_id
                ) AS subject,
                ${payloadProjection("inserted")},
                actors.id AS actor_id,
                actors.external_id AS actor_external_id,
                actors.name AS actor_name,
                actors.kind AS actor_kind,
                actors.created_at AS actor_created_at,
                actors.last_seen_at AS actor_last_seen_at
            FROM inserted
            LEFT JOIN actors ON actors.id = inserted.actor_id
        `,
        [
            visibility ?? DEFAULT_CONTEXT_VISIBILITY,
            text,
            source ?? null,
            tagValue,
            actorId,
            channelId,
            groupId,
            subjectId,
            now,
        ]
    );

    const row = result.rows[0];
    if (!row.payload_ref) {
        const payload = await client.query<{ payload_ref: unknown }>(
            `SELECT jsonb_build_object(
                'id', context_payloads.id,
                'version', context_payloads.version,
                'kind', context_payloads.kind,
                'media_type', context_payloads.media_type,
                'size_bytes', context_payloads.size_bytes
             ) AS payload_ref
             FROM context_payloads
             WHERE context_payloads.context_id = $1
               AND context_payloads.version = 1`,
            [row.id],
        );
        row.payload_ref = payload.rows[0]?.payload_ref;
    }
    return mapContextRow(row);
}

export async function saveContext(
    text: string,
    tags?: string[],
    source?: string,
    actorId?: number | null,
    visibility?: WritableContextVisibility,
    subject?: SubjectIdentity,
) {
    await initializeDatabase();
    const client = await db.connect();
    let context: ContextRecord;

    try {
        const resolvedSubject = subject ? await resolveSubject(subject, client) : null;
        context = await insertContext(
            client,
            text,
            tags,
            source,
            actorId ?? null,
            visibility,
            null,
            null,
            resolvedSubject?.subject.id ?? null,
        );
    } finally {
        client.release();
    }

    await maybeSaveContextEmbedding(context);

    return context;
}

export async function saveContextWithActor(
    text: string,
    tags?: string[],
    source?: string,
    actor?: ActorIdentity,
    activeActorId?: number | null,
    visibility?: WritableContextVisibility,
    subject?: SubjectIdentity,
): Promise<SaveContextResult> {
    if (!actor) {
        await initializeDatabase();
        const client = await db.connect();
        try {
            await client.query("BEGIN");
            const identifiedSubject = subject ? await resolveSubject(subject, client) : null;
            const context = await insertContext(
                client, text, tags, source, activeActorId ?? null, visibility,
                null, null, identifiedSubject?.subject.id ?? null,
            );
            await client.query("COMMIT");
            await maybeSaveContextEmbedding(context);
            return {
                context,
                ...(identifiedSubject ? { subject_resolution: { created: identifiedSubject.created } } : {}),
            };
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }

    await initializeDatabase();
    const client = await db.connect();
    let context: ContextRecord;
    let identified: Awaited<ReturnType<typeof resolveActor>>;
    let identifiedSubject: Awaited<ReturnType<typeof resolveSubject>> | null = null;

    try {
        await client.query("BEGIN");
        identified = await resolveActor(actor, client);
        identifiedSubject = subject ? await resolveSubject(subject, client) : null;
        context = await insertContext(
            client,
            text,
            tags,
            source,
            identified.actor.id,
            visibility,
            null,
            null,
            identifiedSubject?.subject.id ?? null,
        );
        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }

    await maybeSaveContextEmbedding(context);

    return {
        context,
        actor_resolution: {
            created: identified.created,
        },
        ...(identifiedSubject ? { subject_resolution: { created: identifiedSubject.created } } : {}),
    };
}

export async function acknowledgeContextWithActor(
    contextId: number,
    actor?: ActorIdentity,
    activeActorId?: number | null,
): Promise<AcknowledgeContextResult> {
    await initializeDatabase();
    const client = await db.connect();

    try {
        await client.query("BEGIN");
        const visible = await client.query(
            `SELECT id FROM contexts WHERE id = $1 AND visibility = 'whiteboard'`,
            [contextId],
        );
        if (visible.rowCount === 0) {
            await client.query("ROLLBACK");
            return { context: null, actor: null, acknowledged: false };
        }

        const identified = actor
            ? await resolveActor(actor, client)
            : null;
        const actorId = identified?.actor.id ?? activeActorId ?? null;
        if (actorId === null) {
            await client.query("ROLLBACK");
            throw new Error("Actor identification is required to acknowledge a context.");
        }

        const inserted = await client.query(
            `
                INSERT INTO context_acknowledgements (context_id, actor_id)
                VALUES ($1, $2)
                ON CONFLICT (context_id, actor_id) DO NOTHING
                RETURNING acknowledged_at
            `,
            [contextId, actorId],
        );
        const result = await client.query<ContextRow>(
            `
                SELECT ${CONTEXT_PROJECTION}
                FROM contexts
                LEFT JOIN actors ON actors.id = contexts.actor_id
                WHERE contexts.id = $1
                  AND contexts.visibility = 'whiteboard'
            `,
            [contextId],
        );
        const acknowledgingActor = identified?.actor
            ?? mapActorRow((await client.query<ActorRow>(
                `
                    SELECT id, external_id, name, kind, metadata, created_at, last_seen_at
                    FROM actors
                    WHERE id = $1
                `,
                [actorId],
            )).rows[0]);
        await client.query("COMMIT");
        return {
            context: result.rows[0] ? mapContextRow(result.rows[0]) : null,
            actor: acknowledgingActor,
            acknowledged: inserted.rowCount === 1,
            ...(identified ? { actor_resolution: { created: identified.created } } : {}),
        };
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

async function searchContextByText(
    query: string,
    limit: number,
    actorExternalId?: string,
) {
    await initializeDatabase();

    const searchPattern = `%${query}%`;
    const result = await db.query<ContextRow>(
        `
            SELECT ${CONTEXT_PROJECTION}
            FROM contexts
            LEFT JOIN actors ON actors.id = contexts.actor_id
            WHERE (
                contexts.content ILIKE $1
                OR contexts.source ILIKE $1
                OR contexts.tags::text ILIKE $1
                OR EXISTS (
                    SELECT 1 FROM subjects
                    WHERE subjects.id = contexts.subject_id
                      AND (
                          subjects.external_id ILIKE $1
                          OR subjects.name ILIKE $1
                          OR subjects.kind ILIKE $1
                          OR subjects.aliases::text ILIKE $1
                      )
                )
            )
              AND ${WHITEBOARD_READ_PREDICATE}
              AND ($2::text IS NULL OR actors.external_id = $2)
            ORDER BY contexts.created_at DESC, contexts.id DESC
            LIMIT $3
        `,
        [searchPattern, actorExternalId ?? null, limit]
    );

    return result.rows.map(mapContextRow);
}

export async function searchContextByVector(
    query: string,
    limit: number,
    sensitivity: SearchSensitivity,
    actorExternalId?: string,
    generateEmbedding: typeof maybeGenerateEmbedding = maybeGenerateEmbedding,
) {
    const embedding = await generateEmbedding(query);

    if (!embedding.generated) {
        return null;
    }

    const result = await db.query<VectorSearchRow>(
        `
            SELECT
                ${CONTEXT_PROJECTION},
                embeddings.model,
                embeddings.vector
            FROM contexts
            INNER JOIN embeddings
                ON embeddings.context_id = contexts.id
            LEFT JOIN actors ON actors.id = contexts.actor_id
            WHERE embeddings.model = $1
              AND embeddings.vector IS NOT NULL
              AND ${WHITEBOARD_READ_PREDICATE}
              AND ($2::text IS NULL OR actors.external_id = $2)
        `,
        [embedding.model, actorExternalId ?? null]
    );

    const rankedResults = result.rows
        .map((row) => {
            const vector = parseEmbeddingVector(row.vector);
            const similarity = vector ? cosineSimilarity(embedding.vector, vector) : null;

            return similarity === null
                ? null
                : {
                      context: mapContextRow(row),
                      similarity,
                  };
        })
        .filter((item): item is { context: ContextRecord; similarity: number } => item !== null)
        .filter((item) => matchesSearchSensitivity(item.similarity, sensitivity))
        .sort((left, right) => {
            if (right.similarity !== left.similarity) {
                return right.similarity - left.similarity;
            }

            if (right.context.created_at !== left.context.created_at) {
                return right.context.created_at.localeCompare(left.context.created_at);
            }

            return right.context.id - left.context.id;
        })
        .slice(0, limit)
        .map((item) => item.context);

    return rankedResults;
}

export async function searchContext(
    query: string,
    limit?: number,
    sensitivity: SearchSensitivity = DEFAULT_SEARCH_SENSITIVITY,
    actorExternalId?: string,
) {
    await initializeDatabase();

    const resultLimit = normalizeLimit(limit);
    const vectorResults = await searchContextByVector(
        query,
        resultLimit,
        sensitivity,
        actorExternalId,
    );

    return resolveSearchResultsWithFallback(
        vectorResults,
        () => searchContextByText(query, resultLimit, actorExternalId),
    );
}

export async function getUserProfile() {
    const results = await listContextByTag(USER_PROFILE_TAG);

    return {
        username: userInfo().username,
        tag: USER_PROFILE_TAG,
        results,
    };
}

export async function listContextByTag(tag: string, limit?: number) {
    await initializeDatabase();

    const resultLimit = normalizeLimit(limit);
    const tagsType = await getTagsColumnType();
    const result = await db.query<ContextRow>(
        tagsType === "_text"
            ? `
                SELECT ${CONTEXT_PROJECTION}
                FROM contexts
                LEFT JOIN actors ON actors.id = contexts.actor_id
                WHERE $1 = ANY(contexts.tags)
                  AND ${WHITEBOARD_READ_PREDICATE}
                ORDER BY contexts.created_at DESC, contexts.id DESC
                LIMIT $2
            `
            : `
                SELECT ${CONTEXT_PROJECTION}
                FROM contexts
                LEFT JOIN actors ON actors.id = contexts.actor_id
                WHERE ${WHITEBOARD_READ_PREDICATE}
                ORDER BY contexts.created_at DESC, contexts.id DESC
            `,
        tagsType === "_text" ? [tag, resultLimit] : []
    );

    const contexts = result.rows.map(mapContextRow);

    return tagsType === "_text"
        ? contexts
        : contexts.filter((context) => context.tags.includes(tag)).slice(0, resultLimit);
}

export async function listRecentContext(limit?: number, actorExternalId?: string) {
    await initializeDatabase();

    const result = await db.query<ContextRow>(
        `
            SELECT ${CONTEXT_PROJECTION}
            FROM contexts
            LEFT JOIN actors ON actors.id = contexts.actor_id
            WHERE ${WHITEBOARD_READ_PREDICATE}
              AND ($1::text IS NULL OR actors.external_id = $1)
            ORDER BY contexts.created_at DESC, contexts.id DESC
            LIMIT $2
        `,
        [actorExternalId ?? null, normalizeLimit(limit)]
    );

    return result.rows.map(mapContextRow);
}

export async function getContext(id: number) {
    await initializeDatabase();

    const result = await db.query<ContextRow>(
        `
            SELECT ${CONTEXT_PROJECTION}
            FROM contexts
            LEFT JOIN actors ON actors.id = contexts.actor_id
            WHERE contexts.id = $1
              AND ${WHITEBOARD_READ_PREDICATE}
        `,
        [id]
    );

    const context = result.rows[0];

    return context ? mapContextRow(context) : null;
}

export async function deleteContext(id: number) {
    await initializeDatabase();

    const result = await db.query<ContextRow>(
        `
            WITH deleted AS (
                DELETE FROM contexts
                WHERE id = $1
                  AND visibility = 'whiteboard'
                RETURNING *
            )
            SELECT
                deleted.id,
                deleted.kind,
                deleted.visibility,
                deleted.channel_id,
                deleted.group_id,
                deleted.content,
                deleted.source,
                deleted.tags,
                deleted.created_at,
                deleted.updated_at,
                actors.id AS actor_id,
                actors.external_id AS actor_external_id,
                actors.name AS actor_name,
                actors.kind AS actor_kind,
                actors.created_at AS actor_created_at,
                actors.last_seen_at AS actor_last_seen_at,
                ${subjectProjection("deleted")},
                ${payloadProjection("deleted")}
            FROM deleted
            LEFT JOIN actors ON actors.id = deleted.actor_id
        `,
        [id]
    );

    const deletedContext = result.rows[0];

    return deletedContext ? mapContextRow(deletedContext) : null;
}

export async function updateContext(
    id: number,
    text?: string,
    tags?: string[],
    source?: string,
    visibility?: WritableContextVisibility,
    subject?: SubjectIdentity,
) {
    await initializeDatabase();

    const hasText = text !== undefined;
    const hasTags = tags !== undefined;
    const hasSource = source !== undefined;
    const hasVisibility = visibility !== undefined;
    const hasSubject = subject !== undefined;

    if (!hasText && !hasTags && !hasSource && !hasVisibility && !hasSubject) {
        throw new Error("At least one of text, tags, source, visibility, or subject must be provided.");
    }

    const tagValue = hasTags
        ? (await getTagsColumnType()) === "_text"
            ? tags
            : JSON.stringify(tags)
        : null;

    const client = await db.connect();
    let result;
    try {
        await client.query("BEGIN");
        const identifiedSubject = subject ? await resolveSubject(subject, client) : null;
        result = await client.query<ContextRow>(
        `
            WITH updated AS (
                UPDATE contexts
                SET
                    content = CASE WHEN $2 THEN $3 ELSE content END,
                    tags = CASE WHEN $4 THEN $5 ELSE tags END,
                    source = CASE WHEN $6 THEN $7 ELSE source END,
                    visibility = CASE WHEN $8 THEN $9 ELSE visibility END,
                    subject_id = CASE WHEN $10 THEN $11 ELSE subject_id END,
                    updated_at = $12
                WHERE id = $1
                  AND visibility = 'whiteboard'
                RETURNING *
            )
            SELECT ${CONTEXT_PROJECTION}
            FROM contexts
            INNER JOIN updated ON updated.id = contexts.id
            LEFT JOIN actors ON actors.id = contexts.actor_id
        `,
        [
            id,
            hasText,
            text ?? null,
            hasTags,
            tagValue,
            hasSource,
            source ?? null,
            hasVisibility,
            visibility ?? null,
            hasSubject,
            identifiedSubject?.subject.id ?? null,
            new Date().toISOString(),
        ]);
        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }

    const updatedContext = result.rows[0];

    if (!updatedContext) {
        return null;
    }

    const context = mapContextRow(await loadCurrentPayloadReference(updatedContext));

    if (hasText) {
        await maybeSaveContextEmbedding(context);
    }

    return context;
}

export const CHANNEL_ROLE_VALUES = ["owner", "admin", "member"] as const;
export type ChannelRole = (typeof CHANNEL_ROLE_VALUES)[number];
export const ACCESS_GROUP_ROLE_VALUES = CHANNEL_ROLE_VALUES;
export type AccessGroupRole = ChannelRole;

export type AccessGroupRecord = {
    id: number;
    slug: string;
    name: string;
    description: string | null;
    role: AccessGroupRole;
    can_read: boolean;
    can_write: boolean;
    created_at: string;
    updated_at: string;
};

type AccessGroupMembershipRow = {
    id: number | string;
    slug: string;
    name: string;
    description: string | null;
    role: AccessGroupRole;
    can_read: boolean;
    can_write: boolean;
    created_at: string | Date;
    updated_at: string | Date;
};

export type ChannelRecord = {
    id: number;
    slug: string;
    name: string;
    description: string | null;
    role: ChannelRole;
    can_read: boolean;
    can_write: boolean;
    created_at: string;
    updated_at: string;
};

type ChannelMembershipRow = {
    id: number | string;
    slug: string;
    name: string;
    description: string | null;
    role: ChannelRole;
    can_read: boolean;
    can_write: boolean;
    created_at: string | Date;
    updated_at: string | Date;
};

function normalizeChannelSlug(slug: string) {
    const normalized = slug.trim().toLowerCase();

    if (!/^[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]$/.test(normalized)) {
        throw new Error(
            "channel slug must be 3-64 lowercase letters, numbers, underscores, or hyphens.",
        );
    }

    return normalized;
}

function mapChannelRow(row: ChannelMembershipRow): ChannelRecord {
    return {
        id: Number(row.id),
        slug: row.slug,
        name: row.name,
        description: row.description,
        role: row.role,
        can_read: row.can_read,
        can_write: row.can_write,
        created_at: normalizeTimestamp(row.created_at),
        updated_at: normalizeTimestamp(row.updated_at),
    };
}

async function requireChannelMembership(
    actorId: number,
    slug: string,
    capability: "read" | "write" | "admin",
) {
    const result = await db.query<ChannelMembershipRow>(
        `
            SELECT
                channels.id,
                channels.slug,
                channels.name,
                channels.description,
                channel_memberships.role,
                channel_memberships.can_read,
                channel_memberships.can_write,
                channels.created_at,
                channels.updated_at
            FROM channels
            INNER JOIN channel_memberships
                ON channel_memberships.channel_id = channels.id
            WHERE channels.slug = $1
              AND channel_memberships.actor_id = $2
              AND channel_memberships.removed_at IS NULL
              AND (
                    ($3 = 'read' AND channel_memberships.can_read)
                 OR ($3 = 'write' AND channel_memberships.can_write)
                 OR (
                        $3 = 'admin'
                    AND channel_memberships.role IN ('owner', 'admin')
                 )
              )
        `,
        [normalizeChannelSlug(slug), actorId, capability],
    );
    const membership = result.rows[0];

    if (!membership) {
        throw new Error("CHANNEL_NOT_FOUND_OR_NOT_AUTHORIZED");
    }

    return mapChannelRow(membership);
}

export async function createChannel(
    actorId: number,
    slug: string,
    name: string,
    description?: string,
) {
    await initializeDatabase();
    const normalizedSlug = normalizeChannelSlug(slug);
    const normalizedName = name.trim();

    if (!normalizedName) {
        throw new Error("channel name must contain at least one non-whitespace character.");
    }

    const client = await db.connect();

    try {
        await client.query("BEGIN");
        const channelResult = await client.query<{
            id: number | string;
            slug: string;
            name: string;
            description: string | null;
            created_at: string | Date;
            updated_at: string | Date;
        }>(
            `
                INSERT INTO channels (
                    slug,
                    name,
                    description,
                    created_by_actor_id
                )
                VALUES ($1, $2, $3, $4)
                RETURNING id, slug, name, description, created_at, updated_at
            `,
            [normalizedSlug, normalizedName, description?.trim() || null, actorId],
        );
        const channel = channelResult.rows[0];

        await client.query(
            `
                INSERT INTO channel_memberships (
                    channel_id,
                    actor_id,
                    role,
                    can_read,
                    can_write
                )
                VALUES ($1, $2, 'owner', TRUE, TRUE)
            `,
            [channel.id, actorId],
        );
        await client.query("COMMIT");

        return {
            id: Number(channel.id),
            slug: channel.slug,
            name: channel.name,
            description: channel.description,
            role: "owner" as const,
            can_read: true,
            can_write: true,
            created_at: normalizeTimestamp(channel.created_at),
            updated_at: normalizeTimestamp(channel.updated_at),
        };
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

export async function addChannelMember(
    requesterActorId: number,
    slug: string,
    actorExternalId: string,
    role: ChannelRole = "member",
    canRead = true,
    canWrite = true,
) {
    await initializeDatabase();
    const channel = await requireChannelMembership(requesterActorId, slug, "admin");

    if (role === "owner" && channel.role !== "owner") {
        throw new Error("CHANNEL_NOT_FOUND_OR_NOT_AUTHORIZED");
    }

    const currentTarget = await db.query<{ role: ChannelRole }>(
        `
            SELECT channel_memberships.role
            FROM channel_memberships
            INNER JOIN actors ON actors.id = channel_memberships.actor_id
            WHERE channel_memberships.channel_id = $1
              AND actors.external_id = $2
              AND channel_memberships.removed_at IS NULL
        `,
        [channel.id, actorExternalId],
    );
    const currentTargetRole = currentTarget.rows[0]?.role;

    if (currentTargetRole === "owner" && role !== "owner") {
        throw new Error("CHANNEL_OWNER_CANNOT_BE_REMOVED");
    }

    if (
        channel.role !== "owner"
        && (role !== "member" || currentTargetRole === "admin")
    ) {
        throw new Error("CHANNEL_NOT_FOUND_OR_NOT_AUTHORIZED");
    }

    const result = await db.query<{
        actor_id: number | string;
        actor_external_id: string;
        role: ChannelRole;
        can_read: boolean;
        can_write: boolean;
        joined_at: string | Date;
    }>(
        `
            INSERT INTO channel_memberships (
                channel_id,
                actor_id,
                role,
                can_read,
                can_write,
                joined_at,
                removed_at
            )
            SELECT $1, actors.id, $3, $4, $5, NOW(), NULL
            FROM actors
            WHERE actors.external_id = $2
            ON CONFLICT (channel_id, actor_id) DO UPDATE
            SET
                role = EXCLUDED.role,
                can_read = EXCLUDED.can_read,
                can_write = EXCLUDED.can_write,
                joined_at = NOW(),
                removed_at = NULL
            RETURNING
                actor_id,
                $2::text AS actor_external_id,
                role,
                can_read,
                can_write,
                joined_at
        `,
        [channel.id, actorExternalId, role, canRead, canWrite],
    );
    const member = result.rows[0];

    if (!member) {
        throw new Error("ACTOR_NOT_FOUND");
    }

    return {
        channel: channel.slug,
        actor_id: Number(member.actor_id),
        actor_external_id: member.actor_external_id,
        role: member.role,
        can_read: member.can_read,
        can_write: member.can_write,
        joined_at: normalizeTimestamp(member.joined_at),
    };
}

export async function removeChannelMember(
    requesterActorId: number,
    slug: string,
    actorExternalId: string,
) {
    await initializeDatabase();
    const channel = await requireChannelMembership(requesterActorId, slug, "admin");
    const target = await db.query<{ role: ChannelRole }>(
        `
            SELECT channel_memberships.role
            FROM channel_memberships
            INNER JOIN actors ON actors.id = channel_memberships.actor_id
            WHERE channel_memberships.channel_id = $1
              AND actors.external_id = $2
              AND channel_memberships.removed_at IS NULL
        `,
        [channel.id, actorExternalId],
    );

    if (target.rows[0]?.role === "owner") {
        throw new Error("CHANNEL_OWNER_CANNOT_BE_REMOVED");
    }

    if (target.rows[0]?.role === "admin" && channel.role !== "owner") {
        throw new Error("CHANNEL_NOT_FOUND_OR_NOT_AUTHORIZED");
    }

    const removed = await db.query(
        `
            UPDATE channel_memberships
            SET removed_at = NOW(), can_read = FALSE, can_write = FALSE
            WHERE channel_id = $1
              AND actor_id = (
                  SELECT id FROM actors WHERE external_id = $2
              )
              AND removed_at IS NULL
            RETURNING actor_id, removed_at
        `,
        [channel.id, actorExternalId],
    );

    return {
        channel: channel.slug,
        actor_external_id: actorExternalId,
        removed: removed.rowCount === 1,
    };
}

export async function listActorChannels(actorId: number) {
    await initializeDatabase();
    const result = await db.query<ChannelMembershipRow>(
        `
            SELECT
                channels.id,
                channels.slug,
                channels.name,
                channels.description,
                channel_memberships.role,
                channel_memberships.can_read,
                channel_memberships.can_write,
                channels.created_at,
                channels.updated_at
            FROM channels
            INNER JOIN channel_memberships
                ON channel_memberships.channel_id = channels.id
            WHERE channel_memberships.actor_id = $1
              AND channel_memberships.removed_at IS NULL
            ORDER BY channels.slug
        `,
        [actorId],
    );

    return result.rows.map(mapChannelRow);
}

export async function saveChannelContext(
    actorId: number,
    slug: string,
    text: string,
    tags?: string[],
    source?: string,
    subject?: SubjectIdentity,
) {
    await initializeDatabase();
    const channel = await requireChannelMembership(actorId, slug, "write");
    const client = await db.connect();
    let context: ContextRecord;

    try {
        await client.query("BEGIN");
        const identifiedSubject = subject ? await resolveSubject(subject, client) : null;
        context = await insertContext(
            client,
            text,
            tags,
            source,
            actorId,
            "channel",
            channel.id,
            null,
            identifiedSubject?.subject.id ?? null,
        );
        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }

    await maybeSaveContextEmbedding(context);
    return context;
}

async function searchChannelContextByText(
    actorId: number,
    slug: string,
    query: string,
    limit: number,
) {
    const channel = await requireChannelMembership(actorId, slug, "read");
    const result = await db.query<ContextRow>(
        `
            SELECT ${CONTEXT_PROJECTION}
            FROM contexts
            LEFT JOIN actors ON actors.id = contexts.actor_id
            WHERE contexts.visibility = 'channel'
              AND contexts.channel_id = $1
              AND (
                    contexts.content ILIKE $2
                 OR contexts.source ILIKE $2
                 OR contexts.tags::text ILIKE $2
                 OR EXISTS (
                        SELECT 1 FROM subjects
                        WHERE subjects.id = contexts.subject_id
                          AND (subjects.external_id ILIKE $2 OR subjects.name ILIKE $2 OR subjects.kind ILIKE $2 OR subjects.aliases::text ILIKE $2)
                    )
              )
            ORDER BY contexts.created_at DESC, contexts.id DESC
            LIMIT $3
        `,
        [channel.id, `%${query}%`, limit],
    );

    return result.rows.map(mapContextRow);
}

export async function searchChannelContext(
    actorId: number,
    slug: string,
    query: string,
    limit?: number,
    sensitivity: SearchSensitivity = DEFAULT_SEARCH_SENSITIVITY,
    generateEmbedding: typeof maybeGenerateEmbedding = maybeGenerateEmbedding,
) {
    await initializeDatabase();
    const resultLimit = normalizeLimit(limit);
    const channel = await requireChannelMembership(actorId, slug, "read");
    const embedding = await generateEmbedding(query);

    if (!embedding.generated) {
        return searchChannelContextByText(actorId, slug, query, resultLimit);
    }

    const result = await db.query<VectorSearchRow>(
        `
            SELECT
                ${CONTEXT_PROJECTION},
                embeddings.model,
                embeddings.vector
            FROM contexts
            INNER JOIN embeddings ON embeddings.context_id = contexts.id
            LEFT JOIN actors ON actors.id = contexts.actor_id
            WHERE contexts.visibility = 'channel'
              AND contexts.channel_id = $1
              AND embeddings.model = $2
              AND embeddings.vector IS NOT NULL
        `,
        [channel.id, embedding.model],
    );

    return result.rows
        .map((row) => {
            const vector = parseEmbeddingVector(row.vector);
            const similarity = vector ? cosineSimilarity(embedding.vector, vector) : null;
            return similarity === null ? null : { context: mapContextRow(row), similarity };
        })
        .filter((item): item is { context: ContextRecord; similarity: number } => item !== null)
        .filter((item) => matchesSearchSensitivity(item.similarity, sensitivity))
        .sort((left, right) => right.similarity - left.similarity)
        .slice(0, resultLimit)
        .map((item) => item.context);
}

export async function listChannelContext(
    actorId: number,
    slug: string,
    limit?: number,
) {
    await initializeDatabase();
    const channel = await requireChannelMembership(actorId, slug, "read");
    const result = await db.query<ContextRow>(
        `
            SELECT ${CONTEXT_PROJECTION}
            FROM contexts
            LEFT JOIN actors ON actors.id = contexts.actor_id
            WHERE contexts.visibility = 'channel'
              AND contexts.channel_id = $1
            ORDER BY contexts.created_at DESC, contexts.id DESC
            LIMIT $2
        `,
        [channel.id, normalizeLimit(limit)],
    );

    return result.rows.map(mapContextRow);
}

export async function getChannelContext(
    actorId: number,
    id: number,
) {
    await initializeDatabase();
    const result = await db.query<ContextRow>(
        `
            SELECT ${CONTEXT_PROJECTION}
            FROM contexts
            LEFT JOIN actors ON actors.id = contexts.actor_id
            INNER JOIN channel_memberships
                ON channel_memberships.channel_id = contexts.channel_id
            WHERE contexts.id = $1
              AND contexts.visibility = 'channel'
              AND channel_memberships.actor_id = $2
              AND channel_memberships.removed_at IS NULL
              AND channel_memberships.can_read
        `,
        [id, actorId],
    );

    return result.rows[0] ? mapContextRow(result.rows[0]) : null;
}

export async function updateChannelContext(
    actorId: number,
    id: number,
    text?: string,
    tags?: string[],
    source?: string,
) {
    await initializeDatabase();
    const hasText = text !== undefined;
    const hasTags = tags !== undefined;
    const hasSource = source !== undefined;

    if (!hasText && !hasTags && !hasSource) {
        throw new Error("At least one of text, tags, or source must be provided.");
    }

    const tagValue = hasTags
        ? (await getTagsColumnType()) === "_text"
            ? tags
            : JSON.stringify(tags)
        : null;
    const result = await db.query<ContextRow>(
        `
            WITH updated AS (
                UPDATE contexts
                SET
                    content = CASE WHEN $3 THEN $4 ELSE content END,
                    tags = CASE WHEN $5 THEN $6 ELSE tags END,
                    source = CASE WHEN $7 THEN $8 ELSE source END,
                    updated_at = $9
                FROM channel_memberships
                WHERE contexts.id = $1
                  AND contexts.visibility = 'channel'
                  AND channel_memberships.channel_id = contexts.channel_id
                  AND channel_memberships.actor_id = $2
                  AND channel_memberships.removed_at IS NULL
                  AND channel_memberships.can_write
                  AND (
                        contexts.actor_id = $2
                     OR channel_memberships.role IN ('owner', 'admin')
                  )
                RETURNING contexts.*
            )
            SELECT
                updated.id,
                updated.kind,
                updated.visibility,
                updated.channel_id,
                updated.group_id,
                updated.content,
                updated.source,
                updated.tags,
                updated.created_at,
                updated.updated_at,
                actors.id AS actor_id,
                actors.external_id AS actor_external_id,
                actors.name AS actor_name,
                actors.kind AS actor_kind,
                actors.created_at AS actor_created_at,
                actors.last_seen_at AS actor_last_seen_at,
                ${subjectProjection("updated")},
                ${payloadProjection("updated")}
            FROM updated
            LEFT JOIN actors ON actors.id = updated.actor_id
        `,
        [
            id,
            actorId,
            hasText,
            text ?? null,
            hasTags,
            tagValue,
            hasSource,
            source ?? null,
            new Date().toISOString(),
        ],
    );
    const context = result.rows[0]
        ? mapContextRow(await loadCurrentPayloadReference(result.rows[0]))
        : null;

    if (context && hasText) {
        await maybeSaveContextEmbedding(context);
    }

    return context;
}

export async function deleteChannelContext(actorId: number, id: number) {
    await initializeDatabase();
    const result = await db.query<ContextRow>(
        `
            WITH deleted AS (
                DELETE FROM contexts
                USING channel_memberships
                WHERE contexts.id = $1
                  AND contexts.visibility = 'channel'
                  AND channel_memberships.channel_id = contexts.channel_id
                  AND channel_memberships.actor_id = $2
                  AND channel_memberships.removed_at IS NULL
                  AND channel_memberships.can_write
                  AND (
                        contexts.actor_id = $2
                     OR channel_memberships.role IN ('owner', 'admin')
                  )
                RETURNING contexts.*
            )
            SELECT
                deleted.id,
                deleted.kind,
                deleted.visibility,
                deleted.channel_id,
                deleted.group_id,
                deleted.content,
                deleted.source,
                deleted.tags,
                deleted.created_at,
                deleted.updated_at,
                actors.id AS actor_id,
                actors.external_id AS actor_external_id,
                actors.name AS actor_name,
                actors.kind AS actor_kind,
                actors.created_at AS actor_created_at,
                actors.last_seen_at AS actor_last_seen_at,
                ${subjectProjection("deleted")},
                ${payloadProjection("deleted")}
            FROM deleted
            LEFT JOIN actors ON actors.id = deleted.actor_id
        `,
        [id, actorId],
    );

    return result.rows[0] ? mapContextRow(result.rows[0]) : null;
}

function normalizeAccessGroupSlug(slug: string) {
    const normalized = slug.trim().toLowerCase();

    if (!/^[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]$/.test(normalized)) {
        throw new Error(
            "access group slug must be 3-64 lowercase letters, numbers, underscores, or hyphens.",
        );
    }

    return normalized;
}

function mapAccessGroupRow(row: AccessGroupMembershipRow): AccessGroupRecord {
    return {
        id: Number(row.id),
        slug: row.slug,
        name: row.name,
        description: row.description,
        role: row.role,
        can_read: row.can_read,
        can_write: row.can_write,
        created_at: normalizeTimestamp(row.created_at),
        updated_at: normalizeTimestamp(row.updated_at),
    };
}

async function requireAccessGroupMembership(
    actorId: number,
    slug: string,
    capability: "read" | "write" | "admin",
) {
    const result = await db.query<AccessGroupMembershipRow>(
        `
            SELECT
                access_groups.id,
                access_groups.slug,
                access_groups.name,
                access_groups.description,
                access_group_memberships.role,
                access_group_memberships.can_read,
                access_group_memberships.can_write,
                access_groups.created_at,
                access_groups.updated_at
            FROM access_groups
            INNER JOIN access_group_memberships
                ON access_group_memberships.group_id = access_groups.id
            WHERE access_groups.slug = $1
              AND access_group_memberships.actor_id = $2
              AND access_group_memberships.removed_at IS NULL
              AND (
                    ($3 = 'read' AND access_group_memberships.can_read)
                 OR ($3 = 'write' AND access_group_memberships.can_write)
                 OR (
                        $3 = 'admin'
                    AND access_group_memberships.role IN ('owner', 'admin')
                 )
              )
        `,
        [normalizeAccessGroupSlug(slug), actorId, capability],
    );
    const membership = result.rows[0];

    if (!membership) {
        throw new Error("ACCESS_GROUP_NOT_FOUND_OR_NOT_AUTHORIZED");
    }

    return mapAccessGroupRow(membership);
}

export async function createAccessGroup(
    actorId: number,
    slug: string,
    name: string,
    description?: string,
) {
    await initializeDatabase();
    const normalizedSlug = normalizeAccessGroupSlug(slug);
    const normalizedName = name.trim();

    if (!normalizedName) {
        throw new Error("access group name must contain at least one non-whitespace character.");
    }

    const client = await db.connect();

    try {
        await client.query("BEGIN");
        const result = await client.query<{
            id: number | string;
            slug: string;
            name: string;
            description: string | null;
            created_at: string | Date;
            updated_at: string | Date;
        }>(
            `
                INSERT INTO access_groups (slug, name, description, created_by_actor_id)
                VALUES ($1, $2, $3, $4)
                RETURNING id, slug, name, description, created_at, updated_at
            `,
            [normalizedSlug, normalizedName, description?.trim() || null, actorId],
        );
        const group = result.rows[0];

        await client.query(
            `
                INSERT INTO access_group_memberships (
                    group_id,
                    actor_id,
                    role,
                    can_read,
                    can_write
                )
                VALUES ($1, $2, 'owner', TRUE, TRUE)
            `,
            [group.id, actorId],
        );
        await client.query("COMMIT");

        return {
            id: Number(group.id),
            slug: group.slug,
            name: group.name,
            description: group.description,
            role: "owner" as const,
            can_read: true,
            can_write: true,
            created_at: normalizeTimestamp(group.created_at),
            updated_at: normalizeTimestamp(group.updated_at),
        };
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

export async function addAccessGroupMember(
    requesterActorId: number,
    slug: string,
    actorExternalId: string,
    role: AccessGroupRole = "member",
    canRead = true,
    canWrite = true,
) {
    await initializeDatabase();
    const group = await requireAccessGroupMembership(requesterActorId, slug, "admin");

    if (role === "owner" && group.role !== "owner") {
        throw new Error("ACCESS_GROUP_NOT_FOUND_OR_NOT_AUTHORIZED");
    }

    const currentTarget = await db.query<{ role: AccessGroupRole }>(
        `
            SELECT access_group_memberships.role
            FROM access_group_memberships
            INNER JOIN actors ON actors.id = access_group_memberships.actor_id
            WHERE access_group_memberships.group_id = $1
              AND actors.external_id = $2
              AND access_group_memberships.removed_at IS NULL
        `,
        [group.id, actorExternalId],
    );
    const currentTargetRole = currentTarget.rows[0]?.role;

    if (currentTargetRole === "owner" && role !== "owner") {
        throw new Error("ACCESS_GROUP_OWNER_CANNOT_BE_REMOVED");
    }

    if (
        group.role !== "owner"
        && (role !== "member" || currentTargetRole === "admin")
    ) {
        throw new Error("ACCESS_GROUP_NOT_FOUND_OR_NOT_AUTHORIZED");
    }

    const result = await db.query<{
        actor_id: number | string;
        actor_external_id: string;
        role: AccessGroupRole;
        can_read: boolean;
        can_write: boolean;
        joined_at: string | Date;
    }>(
        `
            INSERT INTO access_group_memberships (
                group_id,
                actor_id,
                role,
                can_read,
                can_write,
                joined_at,
                removed_at
            )
            SELECT $1, actors.id, $3, $4, $5, NOW(), NULL
            FROM actors
            WHERE actors.external_id = $2
            ON CONFLICT (group_id, actor_id) DO UPDATE
            SET
                role = EXCLUDED.role,
                can_read = EXCLUDED.can_read,
                can_write = EXCLUDED.can_write,
                joined_at = NOW(),
                removed_at = NULL
            RETURNING
                actor_id,
                $2::text AS actor_external_id,
                role,
                can_read,
                can_write,
                joined_at
        `,
        [group.id, actorExternalId, role, canRead, canWrite],
    );
    const member = result.rows[0];

    if (!member) {
        throw new Error("ACTOR_NOT_FOUND");
    }

    return {
        group: group.slug,
        actor_id: Number(member.actor_id),
        actor_external_id: member.actor_external_id,
        role: member.role,
        can_read: member.can_read,
        can_write: member.can_write,
        joined_at: normalizeTimestamp(member.joined_at),
    };
}

export async function removeAccessGroupMember(
    requesterActorId: number,
    slug: string,
    actorExternalId: string,
) {
    await initializeDatabase();
    const group = await requireAccessGroupMembership(requesterActorId, slug, "admin");
    const target = await db.query<{ role: AccessGroupRole }>(
        `
            SELECT access_group_memberships.role
            FROM access_group_memberships
            INNER JOIN actors ON actors.id = access_group_memberships.actor_id
            WHERE access_group_memberships.group_id = $1
              AND actors.external_id = $2
              AND access_group_memberships.removed_at IS NULL
        `,
        [group.id, actorExternalId],
    );

    if (target.rows[0]?.role === "owner") {
        throw new Error("ACCESS_GROUP_OWNER_CANNOT_BE_REMOVED");
    }

    if (target.rows[0]?.role === "admin" && group.role !== "owner") {
        throw new Error("ACCESS_GROUP_NOT_FOUND_OR_NOT_AUTHORIZED");
    }

    const removed = await db.query(
        `
            UPDATE access_group_memberships
            SET removed_at = NOW(), can_read = FALSE, can_write = FALSE
            WHERE group_id = $1
              AND actor_id = (
                  SELECT id FROM actors WHERE external_id = $2
              )
              AND removed_at IS NULL
            RETURNING actor_id
        `,
        [group.id, actorExternalId],
    );

    return {
        group: group.slug,
        actor_external_id: actorExternalId,
        removed: removed.rowCount === 1,
    };
}

export async function listActorAccessGroups(actorId: number) {
    await initializeDatabase();
    const result = await db.query<AccessGroupMembershipRow>(
        `
            SELECT
                access_groups.id,
                access_groups.slug,
                access_groups.name,
                access_groups.description,
                access_group_memberships.role,
                access_group_memberships.can_read,
                access_group_memberships.can_write,
                access_groups.created_at,
                access_groups.updated_at
            FROM access_groups
            INNER JOIN access_group_memberships
                ON access_group_memberships.group_id = access_groups.id
            WHERE access_group_memberships.actor_id = $1
              AND access_group_memberships.removed_at IS NULL
            ORDER BY access_groups.slug
        `,
        [actorId],
    );

    return result.rows.map(mapAccessGroupRow);
}

export async function saveGroupContext(
    actorId: number,
    slug: string,
    text: string,
    tags?: string[],
    source?: string,
    subject?: SubjectIdentity,
) {
    await initializeDatabase();
    const group = await requireAccessGroupMembership(actorId, slug, "write");
    const client = await db.connect();
    let context: ContextRecord;

    try {
        await client.query("BEGIN");
        const identifiedSubject = subject ? await resolveSubject(subject, client) : null;
        context = await insertContext(
            client,
            text,
            tags,
            source,
            actorId,
            "group",
            null,
            group.id,
            identifiedSubject?.subject.id ?? null,
        );
        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }

    await maybeSaveContextEmbedding(context);
    return context;
}

async function searchGroupContextByText(
    actorId: number,
    slug: string,
    query: string,
    limit: number,
) {
    const group = await requireAccessGroupMembership(actorId, slug, "read");
    const result = await db.query<ContextRow>(
        `
            SELECT ${CONTEXT_PROJECTION}
            FROM contexts
            LEFT JOIN actors ON actors.id = contexts.actor_id
            WHERE contexts.visibility = 'group'
              AND contexts.group_id = $1
              AND (
                    contexts.content ILIKE $2
                 OR contexts.source ILIKE $2
                 OR contexts.tags::text ILIKE $2
                 OR EXISTS (
                        SELECT 1 FROM subjects
                        WHERE subjects.id = contexts.subject_id
                          AND (subjects.external_id ILIKE $2 OR subjects.name ILIKE $2 OR subjects.kind ILIKE $2 OR subjects.aliases::text ILIKE $2)
                    )
              )
            ORDER BY contexts.created_at DESC, contexts.id DESC
            LIMIT $3
        `,
        [group.id, `%${query}%`, limit],
    );

    return result.rows.map(mapContextRow);
}

export async function searchGroupContext(
    actorId: number,
    slug: string,
    query: string,
    limit?: number,
    sensitivity: SearchSensitivity = DEFAULT_SEARCH_SENSITIVITY,
    generateEmbedding: typeof maybeGenerateEmbedding = maybeGenerateEmbedding,
) {
    await initializeDatabase();
    const resultLimit = normalizeLimit(limit);
    const group = await requireAccessGroupMembership(actorId, slug, "read");
    const embedding = await generateEmbedding(query);

    if (!embedding.generated) {
        return searchGroupContextByText(actorId, slug, query, resultLimit);
    }

    const result = await db.query<VectorSearchRow>(
        `
            SELECT
                ${CONTEXT_PROJECTION},
                embeddings.model,
                embeddings.vector
            FROM contexts
            INNER JOIN embeddings ON embeddings.context_id = contexts.id
            LEFT JOIN actors ON actors.id = contexts.actor_id
            WHERE contexts.visibility = 'group'
              AND contexts.group_id = $1
              AND embeddings.model = $2
              AND embeddings.vector IS NOT NULL
        `,
        [group.id, embedding.model],
    );

    return result.rows
        .map((row) => {
            const vector = parseEmbeddingVector(row.vector);
            const similarity = vector ? cosineSimilarity(embedding.vector, vector) : null;
            return similarity === null ? null : { context: mapContextRow(row), similarity };
        })
        .filter((item): item is { context: ContextRecord; similarity: number } => item !== null)
        .filter((item) => matchesSearchSensitivity(item.similarity, sensitivity))
        .sort((left, right) => right.similarity - left.similarity)
        .slice(0, resultLimit)
        .map((item) => item.context);
}

export async function listGroupContext(actorId: number, slug: string, limit?: number) {
    await initializeDatabase();
    const group = await requireAccessGroupMembership(actorId, slug, "read");
    const result = await db.query<ContextRow>(
        `
            SELECT ${CONTEXT_PROJECTION}
            FROM contexts
            LEFT JOIN actors ON actors.id = contexts.actor_id
            WHERE contexts.visibility = 'group'
              AND contexts.group_id = $1
            ORDER BY contexts.created_at DESC, contexts.id DESC
            LIMIT $2
        `,
        [group.id, normalizeLimit(limit)],
    );

    return result.rows.map(mapContextRow);
}

export async function getGroupContext(actorId: number, id: number) {
    await initializeDatabase();
    const result = await db.query<ContextRow>(
        `
            SELECT ${CONTEXT_PROJECTION}
            FROM contexts
            LEFT JOIN actors ON actors.id = contexts.actor_id
            INNER JOIN access_group_memberships
                ON access_group_memberships.group_id = contexts.group_id
            WHERE contexts.id = $1
              AND contexts.visibility = 'group'
              AND access_group_memberships.actor_id = $2
              AND access_group_memberships.removed_at IS NULL
              AND access_group_memberships.can_read
        `,
        [id, actorId],
    );

    return result.rows[0] ? mapContextRow(result.rows[0]) : null;
}

export async function updateGroupContext(
    actorId: number,
    id: number,
    text?: string,
    tags?: string[],
    source?: string,
) {
    await initializeDatabase();
    const hasText = text !== undefined;
    const hasTags = tags !== undefined;
    const hasSource = source !== undefined;

    if (!hasText && !hasTags && !hasSource) {
        throw new Error("At least one of text, tags, or source must be provided.");
    }

    const tagValue = hasTags
        ? (await getTagsColumnType()) === "_text"
            ? tags
            : JSON.stringify(tags)
        : null;
    const result = await db.query<ContextRow>(
        `
            WITH updated AS (
                UPDATE contexts
                SET
                    content = CASE WHEN $3 THEN $4 ELSE content END,
                    tags = CASE WHEN $5 THEN $6 ELSE tags END,
                    source = CASE WHEN $7 THEN $8 ELSE source END,
                    updated_at = $9
                FROM access_group_memberships
                WHERE contexts.id = $1
                  AND contexts.visibility = 'group'
                  AND access_group_memberships.group_id = contexts.group_id
                  AND access_group_memberships.actor_id = $2
                  AND access_group_memberships.removed_at IS NULL
                  AND access_group_memberships.can_write
                RETURNING contexts.*
            )
            SELECT
                updated.id,
                updated.kind,
                updated.visibility,
                updated.channel_id,
                updated.group_id,
                updated.content,
                updated.source,
                updated.tags,
                updated.created_at,
                updated.updated_at,
                actors.id AS actor_id,
                actors.external_id AS actor_external_id,
                actors.name AS actor_name,
                actors.kind AS actor_kind,
                actors.created_at AS actor_created_at,
                actors.last_seen_at AS actor_last_seen_at,
                ${subjectProjection("updated")},
                ${payloadProjection("updated")}
            FROM updated
            LEFT JOIN actors ON actors.id = updated.actor_id
        `,
        [
            id,
            actorId,
            hasText,
            text ?? null,
            hasTags,
            tagValue,
            hasSource,
            source ?? null,
            new Date().toISOString(),
        ],
    );
    const context = result.rows[0]
        ? mapContextRow(await loadCurrentPayloadReference(result.rows[0]))
        : null;

    if (context && hasText) {
        await maybeSaveContextEmbedding(context);
    }

    return context;
}

export async function deleteGroupContext(actorId: number, id: number) {
    await initializeDatabase();
    const result = await db.query<ContextRow>(
        `
            WITH deleted AS (
                DELETE FROM contexts
                USING access_group_memberships
                WHERE contexts.id = $1
                  AND contexts.visibility = 'group'
                  AND access_group_memberships.group_id = contexts.group_id
                  AND access_group_memberships.actor_id = $2
                  AND access_group_memberships.removed_at IS NULL
                  AND access_group_memberships.can_write
                RETURNING contexts.*
            )
            SELECT
                deleted.id,
                deleted.kind,
                deleted.visibility,
                deleted.channel_id,
                deleted.group_id,
                deleted.content,
                deleted.source,
                deleted.tags,
                deleted.created_at,
                deleted.updated_at,
                actors.id AS actor_id,
                actors.external_id AS actor_external_id,
                actors.name AS actor_name,
                actors.kind AS actor_kind,
                actors.created_at AS actor_created_at,
                actors.last_seen_at AS actor_last_seen_at,
                ${subjectProjection("deleted")},
                ${payloadProjection("deleted")}
            FROM deleted
            LEFT JOIN actors ON actors.id = deleted.actor_id
        `,
        [id, actorId],
    );

    return result.rows[0] ? mapContextRow(result.rows[0]) : null;
}

export async function savePersonalContext(
    actorId: number,
    text: string,
    tags?: string[],
    source?: string,
    subject?: SubjectIdentity,
) {
    await initializeDatabase();
    const client = await db.connect();
    let context: ContextRecord;

    try {
        await client.query("BEGIN");
        const identifiedSubject = subject ? await resolveSubject(subject, client) : null;
        context = await insertContext(
            client,
            text,
            tags,
            source,
            actorId,
            "personal",
            null,
            null,
            identifiedSubject?.subject.id ?? null,
        );
        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }

    await maybeSaveContextEmbedding(context);
    return context;
}

async function searchPersonalContextByText(
    actorId: number,
    query: string,
    limit: number,
) {
    const result = await db.query<ContextRow>(
        `
            SELECT ${CONTEXT_PROJECTION}
            FROM contexts
            LEFT JOIN actors ON actors.id = contexts.actor_id
            WHERE contexts.visibility = 'personal'
              AND contexts.actor_id = $1
              AND (
                    contexts.content ILIKE $2
                 OR contexts.source ILIKE $2
                 OR contexts.tags::text ILIKE $2
                 OR EXISTS (
                        SELECT 1 FROM subjects
                        WHERE subjects.id = contexts.subject_id
                          AND (
                              subjects.external_id ILIKE $2
                              OR subjects.name ILIKE $2
                              OR subjects.kind ILIKE $2
                              OR subjects.aliases::text ILIKE $2
                          )
                    )
              )
            ORDER BY contexts.created_at DESC, contexts.id DESC
            LIMIT $3
        `,
        [actorId, `%${query}%`, limit],
    );

    return result.rows.map(mapContextRow);
}

export async function searchPersonalContext(
    actorId: number,
    query: string,
    limit?: number,
    sensitivity: SearchSensitivity = DEFAULT_SEARCH_SENSITIVITY,
    generateEmbedding: typeof maybeGenerateEmbedding = maybeGenerateEmbedding,
) {
    await initializeDatabase();
    const resultLimit = normalizeLimit(limit);
    const embedding = await generateEmbedding(query);

    if (!embedding.generated) {
        return searchPersonalContextByText(actorId, query, resultLimit);
    }

    const [result, textResults] = await Promise.all([
        db.query<VectorSearchRow>(
            `
                SELECT
                    ${CONTEXT_PROJECTION},
                    embeddings.model,
                    embeddings.vector
                FROM contexts
                INNER JOIN embeddings ON embeddings.context_id = contexts.id
                LEFT JOIN actors ON actors.id = contexts.actor_id
                WHERE contexts.visibility = 'personal'
                  AND contexts.actor_id = $1
                  AND embeddings.model = $2
                  AND embeddings.vector IS NOT NULL
            `,
            [actorId, embedding.model],
        ),
        searchPersonalContextByText(actorId, query, resultLimit),
    ]);

    const vectorResults = result.rows
        .map((row) => {
            const vector = parseEmbeddingVector(row.vector);
            const similarity = vector ? cosineSimilarity(embedding.vector, vector) : null;
            return similarity === null ? null : { context: mapContextRow(row), similarity };
        })
        .filter((item): item is { context: ContextRecord; similarity: number } => item !== null)
        .filter((item) => matchesSearchSensitivity(item.similarity, sensitivity))
        .sort((left, right) => right.similarity - left.similarity)
        .slice(0, resultLimit)
        .map((item) => item.context);

    return mergeHybridSearchResults(textResults, vectorResults, resultLimit);
}

export async function listPersonalContext(actorId: number, limit?: number) {
    await initializeDatabase();
    const result = await db.query<ContextRow>(
        `
            SELECT ${CONTEXT_PROJECTION}
            FROM contexts
            LEFT JOIN actors ON actors.id = contexts.actor_id
            WHERE contexts.visibility = 'personal'
              AND contexts.actor_id = $1
            ORDER BY contexts.created_at DESC, contexts.id DESC
            LIMIT $2
        `,
        [actorId, normalizeLimit(limit)],
    );

    return result.rows.map(mapContextRow);
}

export async function getPersonalContext(actorId: number, id: number) {
    await initializeDatabase();
    const result = await db.query<ContextRow>(
        `
            SELECT ${CONTEXT_PROJECTION}
            FROM contexts
            LEFT JOIN actors ON actors.id = contexts.actor_id
            WHERE contexts.id = $1
              AND contexts.visibility = 'personal'
              AND contexts.actor_id = $2
        `,
        [id, actorId],
    );

    return result.rows[0] ? mapContextRow(result.rows[0]) : null;
}

export async function updatePersonalContext(
    actorId: number,
    id: number,
    text?: string,
    tags?: string[],
    source?: string,
    subject?: SubjectIdentity,
) {
    await initializeDatabase();
    const hasText = text !== undefined;
    const hasTags = tags !== undefined;
    const hasSource = source !== undefined;
    const hasSubject = subject !== undefined;

    if (!hasText && !hasTags && !hasSource && !hasSubject) {
        throw new Error("At least one of text, tags, source, or subject must be provided.");
    }

    const tagValue = hasTags
        ? (await getTagsColumnType()) === "_text"
            ? tags
            : JSON.stringify(tags)
        : null;
    const client = await db.connect();
    let result;
    try {
        await client.query("BEGIN");
        const identifiedSubject = subject ? await resolveSubject(subject, client) : null;
        result = await client.query<ContextRow>(
        `
            WITH updated AS (
                UPDATE contexts
                SET
                    content = CASE WHEN $3 THEN $4 ELSE content END,
                    tags = CASE WHEN $5 THEN $6 ELSE tags END,
                    source = CASE WHEN $7 THEN $8 ELSE source END,
                    subject_id = CASE WHEN $9 THEN $10 ELSE subject_id END,
                    updated_at = $11
                WHERE contexts.id = $1
                  AND contexts.visibility = 'personal'
                  AND contexts.actor_id = $2
                RETURNING contexts.*
            )
            SELECT
                updated.id,
                updated.kind,
                updated.visibility,
                updated.channel_id,
                updated.group_id,
                updated.content,
                updated.source,
                updated.tags,
                updated.created_at,
                updated.updated_at,
                actors.id AS actor_id,
                actors.external_id AS actor_external_id,
                actors.name AS actor_name,
                actors.kind AS actor_kind,
                actors.created_at AS actor_created_at,
                actors.last_seen_at AS actor_last_seen_at,
                ${subjectProjection("updated")},
                ${payloadProjection("updated")}
            FROM updated
            LEFT JOIN actors ON actors.id = updated.actor_id
        `,
        [
            id,
            actorId,
            hasText,
            text ?? null,
            hasTags,
            tagValue,
            hasSource,
            source ?? null,
            hasSubject,
            identifiedSubject?.subject.id ?? null,
            new Date().toISOString(),
        ]);
        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
    const context = result.rows[0]
        ? mapContextRow(await loadCurrentPayloadReference(result.rows[0]))
        : null;

    if (context && hasText) {
        await maybeSaveContextEmbedding(context);
    }

    return context;
}

export async function deletePersonalContext(actorId: number, id: number) {
    await initializeDatabase();
    const result = await db.query<ContextRow>(
        `
            WITH deleted AS (
                DELETE FROM contexts
                WHERE contexts.id = $1
                  AND contexts.visibility = 'personal'
                  AND contexts.actor_id = $2
                RETURNING contexts.*
            )
            SELECT
                deleted.id,
                deleted.kind,
                deleted.visibility,
                deleted.channel_id,
                deleted.group_id,
                deleted.content,
                deleted.source,
                deleted.tags,
                deleted.created_at,
                deleted.updated_at,
                actors.id AS actor_id,
                actors.external_id AS actor_external_id,
                actors.name AS actor_name,
                actors.kind AS actor_kind,
                actors.created_at AS actor_created_at,
                actors.last_seen_at AS actor_last_seen_at,
                ${subjectProjection("deleted")},
                ${payloadProjection("deleted")}
            FROM deleted
            LEFT JOIN actors ON actors.id = deleted.actor_id
        `,
        [id, actorId],
    );

    return result.rows[0] ? mapContextRow(result.rows[0]) : null;
}

export async function getDatabaseMetadata() {
    await initializeDatabase();

    const result = await db.query<DatabaseMetadataRow>(
        `
            SELECT
                (SELECT COUNT(*) FROM contexts) AS context_count,
                (SELECT COUNT(*) FROM actors) AS actor_count,
                (
                    SELECT COUNT(*)
                    FROM actors
                    WHERE NOT EXISTS (
                        SELECT 1 FROM contexts WHERE contexts.actor_id = actors.id
                    )
                      AND NOT EXISTS (
                          SELECT 1 FROM context_acknowledgements
                          WHERE context_acknowledgements.actor_id = actors.id
                      )
                ) AS orphan_actor_count,
                (
                    SELECT COUNT(*)
                    FROM actors
                    WHERE actors.external_id IS NULL
                      AND NOT EXISTS (
                          SELECT 1 FROM contexts WHERE contexts.actor_id = actors.id
                      )
                      AND NOT EXISTS (
                          SELECT 1 FROM context_acknowledgements
                          WHERE context_acknowledgements.actor_id = actors.id
                      )
                ) AS purgeable_actor_count,
                pg_database_size(current_database()) AS total_size_bytes,
                pg_size_pretty(pg_database_size(current_database())) AS total_size_pretty,
                pg_total_relation_size('contexts') AS contexts_size_bytes,
                pg_size_pretty(pg_total_relation_size('contexts')) AS contexts_size_pretty,
                pg_total_relation_size('embeddings') AS embeddings_size_bytes,
                pg_size_pretty(pg_total_relation_size('embeddings')) AS embeddings_size_pretty,
                pg_total_relation_size('actors') AS actors_size_bytes,
                pg_size_pretty(pg_total_relation_size('actors')) AS actors_size_pretty
        `
    );
    const row = result.rows[0];

    return {
        context_count: Number(row?.context_count ?? 0),
        actor_count: Number(row?.actor_count ?? 0),
        orphan_actor_count: Number(row?.orphan_actor_count ?? 0),
        purgeable_actor_count: Number(row?.purgeable_actor_count ?? 0),
        total_size: {
            bytes: Number(row?.total_size_bytes ?? 0),
            pretty: row?.total_size_pretty ?? "0 bytes",
        },
        tables: {
            contexts: {
                bytes: Number(row?.contexts_size_bytes ?? 0),
                pretty: row?.contexts_size_pretty ?? "0 bytes",
            },
            embeddings: {
                bytes: Number(row?.embeddings_size_bytes ?? 0),
                pretty: row?.embeddings_size_pretty ?? "0 bytes",
            },
            actors: {
                bytes: Number(row?.actors_size_bytes ?? 0),
                pretty: row?.actors_size_pretty ?? "0 bytes",
            },
        },
    } satisfies DatabaseMetadata;
}

export async function vacuumDatabase() {
    await initializeDatabase();

    const before = await getDatabaseMetadata();

    await db.query("VACUUM (ANALYZE) contexts");
    await db.query("VACUUM (ANALYZE) embeddings");
    await db.query("VACUUM (ANALYZE) actors");
    await db.query("VACUUM (ANALYZE) context_acknowledgements");

    const after = await getDatabaseMetadata();

    return {
        tables: ["contexts", "embeddings", "actors", "context_acknowledgements"],
        before,
        after,
    };
}

async function getPurgePreview(before: string) {
    await initializeDatabase();

    const result = await db.query<PurgePreviewRow>(
        `
            SELECT
                COUNT(*) AS matched,
                MIN(created_at) AS oldest,
                MAX(created_at) AS newest
            FROM contexts
            WHERE created_at < $1
              AND visibility = 'whiteboard'
        `,
        [before]
    );
    const row = result.rows[0];

    return {
        matched: Number(row?.matched ?? 0),
        oldest: normalizeNullableTimestamp(row?.oldest ?? null),
        newest: normalizeNullableTimestamp(row?.newest ?? null),
    };
}

export async function contextPurgePreview(before: string) {
    const normalizedBefore = normalizePurgeCutoff(before);
    const preview = await getPurgePreview(normalizedBefore);
    const confirmationToken = `purge_${randomUUID()}`;
    const expiresAt = new Date(Date.now() + PURGE_CONFIRMATION_TTL_MS);

    cleanupExpiredPurgeConfirmations(pendingContextPurges);
    pendingContextPurges.set(confirmationToken, {
        before: normalizedBefore,
        matched: preview.matched,
        expiresAt,
    });

    return {
        before: normalizedBefore,
        ...preview,
        confirmation_token: confirmationToken,
        expires_at: expiresAt.toISOString(),
    };
}

export async function contextPurgeConfirm(
    before: string,
    confirmationToken: string,
    expectedCount: number
) {
    const normalizedBefore = normalizePurgeCutoff(before);
    const now = new Date();

    cleanupExpiredPurgeConfirmations(pendingContextPurges, now);

    const pendingPurge = pendingContextPurges.get(confirmationToken);

    if (!pendingPurge) {
        throw new Error("No active purge preview matched the confirmation token.");
    }

    if (pendingPurge.expiresAt <= now) {
        pendingContextPurges.delete(confirmationToken);
        throw new Error("The purge confirmation token has expired. Run context_purge_preview again.");
    }

    if (pendingPurge.before !== normalizedBefore) {
        throw new Error("The purge cutoff does not match the previewed cutoff.");
    }

    if (pendingPurge.matched !== expectedCount) {
        throw new Error("The expected count does not match the previewed count.");
    }

    const currentPreview = await getPurgePreview(normalizedBefore);

    if (currentPreview.matched !== expectedCount) {
        throw new Error("The purge match count changed after preview. Run context_purge_preview again.");
    }

    const result = await db.query<ContextRow>(
        `
            WITH deleted AS (
                DELETE FROM contexts
                WHERE created_at < $1
                  AND visibility = 'whiteboard'
                RETURNING *
            )
            SELECT
                deleted.id,
                deleted.kind,
                deleted.visibility,
                deleted.channel_id,
                deleted.group_id,
                deleted.content,
                deleted.source,
                deleted.tags,
                deleted.created_at,
                deleted.updated_at,
                actors.id AS actor_id,
                actors.external_id AS actor_external_id,
                actors.name AS actor_name,
                actors.kind AS actor_kind,
                actors.created_at AS actor_created_at,
                actors.last_seen_at AS actor_last_seen_at,
                ${subjectProjection("deleted")},
                ${payloadProjection("deleted")}
            FROM deleted
            LEFT JOIN actors ON actors.id = deleted.actor_id
        `,
        [normalizedBefore]
    );

    pendingContextPurges.delete(confirmationToken);

    return {
        before: normalizedBefore,
        expected_count: expectedCount,
        deleted_count: result.rowCount ?? result.rows.length,
        deleted: result.rows.map(mapContextRow),
    };
}

async function getActorPurgePreview(before: string) {
    await initializeDatabase();

    const result = await db.query<PurgePreviewRow>(
        `
            SELECT
                COUNT(*) AS matched,
                MIN(last_seen_at) AS oldest,
                MAX(last_seen_at) AS newest
            FROM actors
            WHERE external_id IS NULL
              AND last_seen_at < $1
              AND NOT EXISTS (
                  SELECT 1
                  FROM contexts
                  WHERE contexts.actor_id = actors.id
              )
              AND NOT EXISTS (
                  SELECT 1
                  FROM context_acknowledgements
                  WHERE context_acknowledgements.actor_id = actors.id
              )
              AND NOT EXISTS (
                  SELECT 1
                  FROM direct_context_envelopes
                  WHERE direct_context_envelopes.recipient_actor_id = actors.id
              )
        `,
        [before]
    );
    const row = result.rows[0];

    return {
        matched: Number(row?.matched ?? 0),
        oldest: normalizeNullableTimestamp(row?.oldest ?? null),
        newest: normalizeNullableTimestamp(row?.newest ?? null),
    };
}

export async function actorPurgePreview(before: string) {
    const normalizedBefore = normalizePurgeCutoff(before);
    const preview = await getActorPurgePreview(normalizedBefore);
    const confirmationToken = `actor_purge_${randomUUID()}`;
    const expiresAt = new Date(Date.now() + PURGE_CONFIRMATION_TTL_MS);

    cleanupExpiredPurgeConfirmations(pendingActorPurges);
    pendingActorPurges.set(confirmationToken, {
        before: normalizedBefore,
        matched: preview.matched,
        expiresAt,
    });

    return {
        before: normalizedBefore,
        scope: "anonymous_unreferenced_actors",
        ...preview,
        confirmation_token: confirmationToken,
        expires_at: expiresAt.toISOString(),
    };
}

export async function actorPurgeConfirm(
    before: string,
    confirmationToken: string,
    expectedCount: number,
) {
    const normalizedBefore = normalizePurgeCutoff(before);
    const now = new Date();

    cleanupExpiredPurgeConfirmations(pendingActorPurges, now);

    const pendingPurge = pendingActorPurges.get(confirmationToken);

    if (!pendingPurge) {
        throw new Error("No active actor purge preview matched the confirmation token.");
    }

    if (pendingPurge.expiresAt <= now) {
        pendingActorPurges.delete(confirmationToken);
        throw new Error("The actor purge confirmation token has expired. Run actor_purge_preview again.");
    }

    if (pendingPurge.before !== normalizedBefore) {
        throw new Error("The actor purge cutoff does not match the previewed cutoff.");
    }

    if (pendingPurge.matched !== expectedCount) {
        throw new Error("The expected count does not match the previewed actor count.");
    }

    const currentPreview = await getActorPurgePreview(normalizedBefore);

    if (currentPreview.matched !== expectedCount) {
        throw new Error("The actor purge match count changed after preview. Run actor_purge_preview again.");
    }

    const result = await db.query<ActorRow>(
        `
            DELETE FROM actors
            WHERE external_id IS NULL
              AND last_seen_at < $1
              AND NOT EXISTS (
                  SELECT 1
                  FROM contexts
                  WHERE contexts.actor_id = actors.id
              )
              AND NOT EXISTS (
                  SELECT 1
                  FROM context_acknowledgements
                  WHERE context_acknowledgements.actor_id = actors.id
              )
              AND NOT EXISTS (
                  SELECT 1
                  FROM direct_context_envelopes
                  WHERE direct_context_envelopes.recipient_actor_id = actors.id
              )
            RETURNING id, external_id, name, kind, metadata, created_at, last_seen_at
        `,
        [normalizedBefore]
    );

    pendingActorPurges.delete(confirmationToken);

    return {
        before: normalizedBefore,
        scope: "anonymous_unreferenced_actors",
        expected_count: expectedCount,
        deleted_count: result.rowCount ?? result.rows.length,
        deleted: result.rows.map(mapActorRow),
    };
}
