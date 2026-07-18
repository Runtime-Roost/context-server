import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";

import { maybeGenerateEmbedding, maybeSaveContextEmbedding } from "../embeddings/index.js";
import { db, initializeDatabase } from "../storage/db.js";

export type ContextRecord = {
    id: number;
    kind: string;
    content: string;
    source: string | null;
    tags: string[];
    created_at: string;
    updated_at: string;
};

export const SEARCH_SENSITIVITY_VALUES = ["low", "medium", "high"] as const;
export type SearchSensitivity = (typeof SEARCH_SENSITIVITY_VALUES)[number];
export const USER_PROFILE_QUERY = "me";
export const USER_PROFILE_SENSITIVITY: SearchSensitivity = "medium";

type ContextRow = {
    id: number | string;
    kind: string;
    content: string;
    source: string | null;
    tags: string | string[] | null;
    created_at: string | Date;
    updated_at: string | Date;
};

type VectorSearchRow = ContextRow & {
    model: string | null;
    vector: unknown;
};

type DatabaseMetadataRow = {
    context_count: string;
    total_size_bytes: string;
    total_size_pretty: string;
    contexts_size_bytes: string;
    contexts_size_pretty: string;
    embeddings_size_bytes: string;
    embeddings_size_pretty: string;
};

type DatabaseMetadata = {
    context_count: number;
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
const PURGE_CONFIRMATION_TTL_MS = 10 * 60 * 1000;
let tagsColumnType: string | undefined;
const pendingPurges = new Map<string, PendingPurge>();

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
        content: row.content,
        source: row.source,
        tags: parseTags(row.tags),
        created_at: normalizeTimestamp(row.created_at),
        updated_at: normalizeTimestamp(row.updated_at),
    };
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

function cleanupExpiredPurgeConfirmations(now = new Date()) {
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

export async function saveContext(text: string, tags?: string[], source?: string) {
    await initializeDatabase();

    const now = new Date().toISOString();
    const tagList = tags ?? [];
    const tagValue = (await getTagsColumnType()) === "_text" ? tagList : JSON.stringify(tagList);
    const result = await db.query<ContextRow>(
        `
            INSERT INTO contexts (kind, content, source, tags, created_at, updated_at)
            VALUES ('note', $1, $2, $3, $4, $4)
            RETURNING id, kind, content, source, tags, created_at, updated_at
        `,
        [text, source ?? null, tagValue, now]
    );

    const context = mapContextRow(result.rows[0]);

    await maybeSaveContextEmbedding(context);

    return context;
}

async function searchContextByText(query: string, limit: number) {
    await initializeDatabase();

    const searchPattern = `%${query}%`;
    const result = await db.query<ContextRow>(
        `
            SELECT id, kind, content, source, tags, created_at, updated_at
            FROM contexts
            WHERE content ILIKE $1
               OR source ILIKE $1
               OR tags::text ILIKE $1
            ORDER BY created_at DESC, id DESC
            LIMIT $2
        `,
        [searchPattern, limit]
    );

    return result.rows.map(mapContextRow);
}

async function searchContextByVector(
    query: string,
    limit: number,
    sensitivity: SearchSensitivity,
) {
    const embedding = await maybeGenerateEmbedding(query);

    if (!embedding.generated) {
        return null;
    }

    const result = await db.query<VectorSearchRow>(
        `
            SELECT
                contexts.id,
                contexts.kind,
                contexts.content,
                contexts.source,
                contexts.tags,
                contexts.created_at,
                contexts.updated_at,
                embeddings.model,
                embeddings.vector
            FROM contexts
            INNER JOIN embeddings
                ON embeddings.context_id = contexts.id
            WHERE embeddings.model = $1
              AND embeddings.vector IS NOT NULL
        `,
        [embedding.model]
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
) {
    await initializeDatabase();

    const resultLimit = normalizeLimit(limit);
    const vectorResults = await searchContextByVector(query, resultLimit, sensitivity);

    return resolveSearchResultsWithFallback(
        vectorResults,
        () => searchContextByText(query, resultLimit),
    );
}

export async function getUserProfile() {
    const results = await searchContext(
        USER_PROFILE_QUERY,
        undefined,
        USER_PROFILE_SENSITIVITY,
    );

    return {
        username: userInfo().username,
        query: USER_PROFILE_QUERY,
        sensitivity: USER_PROFILE_SENSITIVITY,
        results,
    };
}

export async function listRecentContext(limit?: number) {
    await initializeDatabase();

    const result = await db.query<ContextRow>(
        `
            SELECT id, kind, content, source, tags, created_at, updated_at
            FROM contexts
            ORDER BY created_at DESC, id DESC
            LIMIT $1
        `,
        [normalizeLimit(limit)]
    );

    return result.rows.map(mapContextRow);
}

export async function deleteContext(id: number) {
    await initializeDatabase();

    const result = await db.query<ContextRow>(
        `
            DELETE FROM contexts
            WHERE id = $1
            RETURNING id, kind, content, source, tags, created_at, updated_at
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
    source?: string
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
            UPDATE contexts
            SET
                content = CASE WHEN $2 THEN $3 ELSE content END,
                tags = CASE WHEN $4 THEN $5 ELSE tags END,
                source = CASE WHEN $6 THEN $7 ELSE source END,
                updated_at = $8
            WHERE id = $1
            RETURNING id, kind, content, source, tags, created_at, updated_at
        `,
        [
            id,
            hasText,
            text ?? null,
            hasTags,
            tagValue,
            hasSource,
            source ?? null,
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
                pg_database_size(current_database()) AS total_size_bytes,
                pg_size_pretty(pg_database_size(current_database())) AS total_size_pretty,
                pg_total_relation_size('contexts') AS contexts_size_bytes,
                pg_size_pretty(pg_total_relation_size('contexts')) AS contexts_size_pretty,
                pg_total_relation_size('embeddings') AS embeddings_size_bytes,
                pg_size_pretty(pg_total_relation_size('embeddings')) AS embeddings_size_pretty
        `
    );
    const row = result.rows[0];

    return {
        context_count: Number(row?.context_count ?? 0),
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
        },
    } satisfies DatabaseMetadata;
}

export async function vacuumDatabase() {
    await initializeDatabase();

    const before = await getDatabaseMetadata();

    await db.query("VACUUM (ANALYZE) contexts");
    await db.query("VACUUM (ANALYZE) embeddings");

    const after = await getDatabaseMetadata();

    return {
        tables: ["contexts", "embeddings"],
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

    cleanupExpiredPurgeConfirmations();
    pendingPurges.set(confirmationToken, {
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

    cleanupExpiredPurgeConfirmations(now);

    const pendingPurge = pendingPurges.get(confirmationToken);

    if (!pendingPurge) {
        throw new Error("No active purge preview matched the confirmation token.");
    }

    if (pendingPurge.expiresAt <= now) {
        pendingPurges.delete(confirmationToken);
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
            DELETE FROM contexts
            WHERE created_at < $1
            RETURNING id, kind, content, source, tags, created_at, updated_at
        `,
        [normalizedBefore]
    );

    pendingPurges.delete(confirmationToken);

    return {
        before: normalizedBefore,
        expected_count: expectedCount,
        deleted_count: result.rowCount ?? result.rows.length,
        deleted: result.rows.map(mapContextRow),
    };
}
