import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import type { PoolClient } from "pg";

import { maybeGenerateEmbedding, maybeSaveContextEmbedding } from "../embeddings/index.js";
import { db, initializeDatabase } from "../storage/db.js";

export type ContextRecord = {
    id: number;
    kind: string;
    visibility: ContextVisibility;
    content: string;
    source: string | null;
    tags: string[];
    actor: ActorRecord | null;
    created_at: string;
    updated_at: string;
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
};

export const SEARCH_SENSITIVITY_VALUES = ["low", "medium", "high"] as const;
export type SearchSensitivity = (typeof SEARCH_SENSITIVITY_VALUES)[number];
export const CONTEXT_VISIBILITY_VALUES = [
    "whiteboard",
    "channel",
    "direct",
    "personal",
    "system",
] as const;
export type ContextVisibility = (typeof CONTEXT_VISIBILITY_VALUES)[number];
export const WRITABLE_CONTEXT_VISIBILITY_VALUES = ["whiteboard"] as const;
export type WritableContextVisibility = (typeof WRITABLE_CONTEXT_VISIBILITY_VALUES)[number];
export const USER_PROFILE_TAG = "profile";

type ContextRow = {
    id: number | string;
    kind: string;
    visibility: ContextVisibility;
    content: string;
    source: string | null;
    tags: string | string[] | null;
    actor_id: number | string | null;
    actor_external_id: string | null;
    actor_name: string | null;
    actor_kind: string | null;
    actor_created_at: string | Date | null;
    actor_last_seen_at: string | Date | null;
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

const DEFAULT_CONTEXT_LIMIT = 20;
const MAX_CONTEXT_LIMIT = 100;
const DEFAULT_SEARCH_SENSITIVITY: SearchSensitivity = "low";
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

function mapContextRow(row: ContextRow): ContextRecord {
    return {
        id: Number(row.id),
        kind: row.kind,
        visibility: row.visibility,
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
    contexts.content,
    contexts.source,
    contexts.tags,
    contexts.created_at,
    contexts.updated_at,
    actors.id AS actor_id,
    actors.external_id AS actor_external_id,
    actors.name AS actor_name,
    actors.kind AS actor_kind,
    actors.created_at AS actor_created_at,
    actors.last_seen_at AS actor_last_seen_at
`;

function normalizeWritableVisibility(
    visibility: WritableContextVisibility | undefined,
): WritableContextVisibility {
    return visibility ?? DEFAULT_CONTEXT_VISIBILITY;
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

export async function identifyActor(identity: ActorIdentity) {
    await initializeDatabase();
    const client = await db.connect();

    try {
        return await resolveActor(identity, client);
    } finally {
        client.release();
    }
}

async function insertContext(
    client: PoolClient,
    text: string,
    tags: string[] | undefined,
    source: string | undefined,
    actorId: number | null,
    visibility: WritableContextVisibility | undefined,
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
                    created_at,
                    updated_at
                )
                VALUES ('note', $1, $2, $3, $4, $5, $6, $6)
                RETURNING *
            )
            SELECT
                inserted.id,
                inserted.kind,
                inserted.visibility,
                inserted.content,
                inserted.source,
                inserted.tags,
                inserted.created_at,
                inserted.updated_at,
                actors.id AS actor_id,
                actors.external_id AS actor_external_id,
                actors.name AS actor_name,
                actors.kind AS actor_kind,
                actors.created_at AS actor_created_at,
                actors.last_seen_at AS actor_last_seen_at
            FROM inserted
            LEFT JOIN actors ON actors.id = inserted.actor_id
        `,
        [normalizeWritableVisibility(visibility), text, source ?? null, tagValue, actorId, now]
    );

    return mapContextRow(result.rows[0]);
}

export async function saveContext(
    text: string,
    tags?: string[],
    source?: string,
    actorId?: number | null,
    visibility?: WritableContextVisibility,
) {
    await initializeDatabase();
    const client = await db.connect();
    let context: ContextRecord;

    try {
        context = await insertContext(
            client,
            text,
            tags,
            source,
            actorId ?? null,
            visibility,
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
): Promise<SaveContextResult> {
    if (!actor) {
        return {
            context: await saveContext(text, tags, source, activeActorId, visibility),
        };
    }

    await initializeDatabase();
    const client = await db.connect();
    let context: ContextRecord;
    let identified: Awaited<ReturnType<typeof resolveActor>>;

    try {
        await client.query("BEGIN");
        identified = await resolveActor(actor, client);
        context = await insertContext(
            client,
            text,
            tags,
            source,
            identified.actor.id,
            visibility,
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
    };
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
                actors.last_seen_at AS actor_last_seen_at
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
) {
    await initializeDatabase();

    const hasText = text !== undefined;
    const hasTags = tags !== undefined;
    const hasSource = source !== undefined;
    const hasVisibility = visibility !== undefined;

    if (!hasText && !hasTags && !hasSource && !hasVisibility) {
        throw new Error("At least one of text, tags, source, or visibility must be provided.");
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
                    content = CASE WHEN $2 THEN $3 ELSE content END,
                    tags = CASE WHEN $4 THEN $5 ELSE tags END,
                    source = CASE WHEN $6 THEN $7 ELSE source END,
                    visibility = CASE WHEN $8 THEN $9 ELSE visibility END,
                    updated_at = $10
                WHERE id = $1
                  AND visibility = 'whiteboard'
                RETURNING *
            )
            SELECT
                updated.id,
                updated.kind,
                updated.visibility,
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
                actors.last_seen_at AS actor_last_seen_at
            FROM updated
            LEFT JOIN actors ON actors.id = updated.actor_id
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
            new Date().toISOString(),
        ]
    );

    const updatedContext = result.rows[0];

    if (!updatedContext) {
        return null;
    }

    const context = mapContextRow(updatedContext);

    if (hasText) {
        await maybeSaveContextEmbedding(context);
    }

    return context;
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
                ) AS orphan_actor_count,
                (
                    SELECT COUNT(*)
                    FROM actors
                    WHERE actors.external_id IS NULL
                      AND NOT EXISTS (
                          SELECT 1 FROM contexts WHERE contexts.actor_id = actors.id
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

    const after = await getDatabaseMetadata();

    return {
        tables: ["contexts", "embeddings", "actors"],
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
                actors.last_seen_at AS actor_last_seen_at
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
