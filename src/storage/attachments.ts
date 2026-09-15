import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
    mkdir,
    open,
    readdir,
    rename,
    stat,
    unlink,
} from "node:fs/promises";
import { resolve } from "node:path";

import { db, initializeDatabase } from "./db.js";

export const ATTACHMENT_SCOPE_VALUES = ["personal", "group"] as const;
export type AttachmentScope = (typeof ATTACHMENT_SCOPE_VALUES)[number];
export const ATTACHMENT_RELATIONSHIP_VALUES = ["canonical", "source", "derived", "reference"] as const;
export type AttachmentRelationship = (typeof ATTACHMENT_RELATIONSHIP_VALUES)[number];

const DEFAULT_ATTACHMENT_QUOTA_BYTES = 100 * 1024 * 1024;
const MAX_CHUNK_BYTES = 512 * 1024;
const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

type AttachmentRow = {
    id: string;
    original_filename: string;
    media_type: string;
    size_bytes: string | number;
    sha256: string;
    storage_key: string;
    owner_actor_id: string | number | null;
    group_id: string | number | null;
    created_by_actor_id: string | number;
    created_at: string | Date;
    payload_external_id: string;
};

type AttachmentOwner = { ownerActorId: number | null; groupId: number | null };

function configuredQuotaBytes(scope: AttachmentScope) {
    const key = scope === "personal" ? "ATTACHMENT_PERSONAL_QUOTA_BYTES" : "ATTACHMENT_GROUP_QUOTA_BYTES";
    const raw = process.env[key]?.trim();
    if (!raw) return DEFAULT_ATTACHMENT_QUOTA_BYTES;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("ATTACHMENT_QUOTA_CONFIG_INVALID");
    return value;
}

function ownerScope(owner: AttachmentOwner): AttachmentScope {
    return owner.ownerActorId === null ? "group" : "personal";
}

function quotaLockKey(owner: AttachmentOwner) {
    return owner.ownerActorId === null
        ? `attachment-quota:group:${owner.groupId}`
        : `attachment-quota:actor:${owner.ownerActorId}`;
}

async function lockQuota(client: import("pg").PoolClient, owner: AttachmentOwner) {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [quotaLockKey(owner)]);
}

async function quotaUsage(client: import("pg").PoolClient, owner: AttachmentOwner) {
    const result = await client.query<{ used_bytes: string; reserved_bytes: string }>(
        `SELECT
            COALESCE((SELECT SUM(size_bytes) FROM attachments
                WHERE owner_actor_id IS NOT DISTINCT FROM $1 AND group_id IS NOT DISTINCT FROM $2), 0)::text AS used_bytes,
            COALESCE((SELECT SUM(expected_size_bytes) FROM attachment_uploads
                WHERE owner_actor_id IS NOT DISTINCT FROM $1 AND group_id IS NOT DISTINCT FROM $2
                  AND expires_at > NOW()), 0)::text AS reserved_bytes`,
        [owner.ownerActorId, owner.groupId],
    );
    return { usedBytes: Number(result.rows[0].used_bytes), reservedBytes: Number(result.rows[0].reserved_bytes) };
}

function quotaSnapshot(owner: AttachmentOwner, usedBytes: number, reservedBytes: number) {
    const limitBytes = configuredQuotaBytes(ownerScope(owner));
    return {
        scope: ownerScope(owner),
        limit_bytes: limitBytes,
        used_bytes: usedBytes,
        reserved_bytes: reservedBytes,
        available_bytes: Math.max(0, limitBytes - usedBytes - reservedBytes),
    };
}

async function recordAudit(client: import("pg").PoolClient, eventType: string, actorId: number | null,
    owner: AttachmentOwner, attachmentId: string | null, uploadId: string | null, sizeBytes: number | null,
    details: Record<string, unknown> = {}) {
    await client.query(
        `INSERT INTO attachment_audit_events
            (event_type, actor_id, owner_actor_id, group_id, attachment_id, upload_id, size_bytes, details)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [eventType, actorId, owner.ownerActorId, owner.groupId, attachmentId, uploadId, sizeBytes, details],
    );
}

async function hashFile(path: string) {
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of createReadStream(path)) {
        const bytes = chunk as Buffer;
        size += bytes.length;
        hash.update(bytes);
    }
    return { size, sha256: hash.digest("hex") };
}

async function pruneExpiredUploads() {
    const client = await db.connect();
    let expired: Array<{ id: string; owner_actor_id: string | number | null; group_id: string | number | null; expected_size_bytes: string | number }> = [];
    try {
        await client.query("BEGIN");
        const result = await client.query<typeof expired[number]>(
            `DELETE FROM attachment_uploads WHERE expires_at <= NOW()
             RETURNING id, owner_actor_id, group_id, expected_size_bytes`,
        );
        expired = result.rows;
        for (const row of expired) {
            await recordAudit(client, "upload_expired", null,
                { ownerActorId: row.owner_actor_id === null ? null : Number(row.owner_actor_id), groupId: row.group_id === null ? null : Number(row.group_id) },
                null, row.id, Number(row.expected_size_bytes));
        }
        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally { client.release(); }
    await Promise.all(expired.map((row) => unlink(uploadPath(row.id)).catch(() => undefined)));
}

function storageRoot() {
    return resolve(process.env.ATTACHMENT_STORAGE_DIR?.trim() || resolve(process.cwd(), "data", "attachments"));
}

function uploadPath(id: string) {
    return resolve(storageRoot(), "uploads", `${id}.part`);
}

function objectPath(storageKey: string) {
    return resolve(storageRoot(), "objects", storageKey.slice(0, 2), storageKey);
}

function normalizeTimestamp(value: string | Date) {
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapAttachment(row: AttachmentRow) {
    return {
        id: row.id,
        original_filename: row.original_filename,
        media_type: row.media_type,
        size_bytes: Number(row.size_bytes),
        sha256: row.sha256,
        scope: row.group_id === null ? "personal" as const : "group" as const,
        owner_actor_id: row.owner_actor_id === null ? null : Number(row.owner_actor_id),
        group_id: row.group_id === null ? null : Number(row.group_id),
        created_by_actor_id: Number(row.created_by_actor_id),
        created_at: normalizeTimestamp(row.created_at),
        payload_ref: {
            id: row.payload_external_id,
            version: 1,
            kind: "artifact" as const,
            media_type: row.media_type,
            size_bytes: Number(row.size_bytes),
            sha256: row.sha256,
        },
    };
}

export function attachmentIdFromPayloadReference(payloadId: string) {
    const match = /^payload:artifact:([0-9a-f-]{36}):v1$/i.exec(payloadId.trim());
    if (!match) throw new Error("PAYLOAD_REFERENCE_INVALID");
    return match[1].toLowerCase();
}

export async function linkPayloadToContext(
    actorId: number,
    payloadId: string,
    contextId: number,
    role: AttachmentRelationship,
    derivedFromPayloadId?: string,
) {
    const attachmentId = attachmentIdFromPayloadReference(payloadId);
    let derivedFromAttachmentId: string | undefined;
    if (role === "derived") {
        if (!derivedFromPayloadId) throw new Error("PAYLOAD_DERIVATION_SOURCE_REQUIRED");
        derivedFromAttachmentId = attachmentIdFromPayloadReference(derivedFromPayloadId);
        if (derivedFromAttachmentId === attachmentId) throw new Error("PAYLOAD_DERIVATION_SOURCE_INVALID");
        const [payload, source] = await Promise.all([
            getAttachment(actorId, attachmentId),
            getAttachment(actorId, derivedFromAttachmentId),
        ]);
        if (!payload || !source
            || payload.owner_actor_id !== source.owner_actor_id
            || payload.group_id !== source.group_id) {
            throw new Error("PAYLOAD_NOT_FOUND_OR_NOT_AUTHORIZED");
        }
    } else if (derivedFromPayloadId !== undefined) {
        throw new Error("PAYLOAD_DERIVATION_SOURCE_INVALID");
    }
    const linked = await linkAttachmentToContext(actorId, attachmentId, contextId, role, 0, undefined, undefined, derivedFromAttachmentId);
    if (!linked) return null;
    return { ...linked, payload_id: payloadId, role, derived_from_payload_id: derivedFromPayloadId ?? null };
}

function validateUploadMetadata(filename: string, mediaType: string, size: number, sha256: string) {
    const cleanFilename = filename.trim();
    const cleanMediaType = mediaType.trim().toLowerCase();
    const cleanSha = sha256.trim().toLowerCase();
    if (!cleanFilename || cleanFilename.length > 500 || /[\u0000\r\n]/.test(cleanFilename)) {
        throw new Error("INVALID_ATTACHMENT_FILENAME");
    }
    if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(cleanMediaType)) {
        throw new Error("INVALID_ATTACHMENT_MEDIA_TYPE");
    }
    if (!Number.isSafeInteger(size) || size < 0) {
        throw new Error("ATTACHMENT_SIZE_INVALID");
    }
    if (!/^[0-9a-f]{64}$/.test(cleanSha)) {
        throw new Error("ATTACHMENT_SHA256_INVALID");
    }
    return { filename: cleanFilename, mediaType: cleanMediaType, sha256: cleanSha };
}

async function resolveScope(actorId: number, scope: AttachmentScope, groupSlug: string | undefined, capability: "read" | "write") {
    if (scope === "personal") {
        if (groupSlug !== undefined) throw new Error("ATTACHMENT_SCOPE_INVALID");
        return { ownerActorId: actorId, groupId: null };
    }
    if (!groupSlug) throw new Error("ATTACHMENT_SCOPE_INVALID");
    const result = await db.query<{ id: string | number }>(
        `SELECT access_groups.id
         FROM access_groups
         INNER JOIN access_group_memberships ON access_group_memberships.group_id = access_groups.id
         WHERE access_groups.slug = $1
           AND access_group_memberships.actor_id = $2
           AND access_group_memberships.removed_at IS NULL
           AND CASE WHEN $3 = 'read' THEN access_group_memberships.can_read
                    ELSE access_group_memberships.can_write END`,
        [groupSlug.trim().toLowerCase(), actorId, capability],
    );
    if (!result.rows[0]) throw new Error("ACCESS_GROUP_NOT_FOUND_OR_NOT_AUTHORIZED");
    return { ownerActorId: null, groupId: Number(result.rows[0].id) };
}

const attachmentAccessSql = `
    (
        (attachments.owner_actor_id = $2 AND attachments.group_id IS NULL)
        OR EXISTS (
            SELECT 1 FROM access_group_memberships
            WHERE access_group_memberships.group_id = attachments.group_id
              AND access_group_memberships.actor_id = $2
              AND access_group_memberships.removed_at IS NULL
              AND CASE WHEN $3 = 'read' THEN access_group_memberships.can_read
                       ELSE access_group_memberships.can_write END
        )
    )
`;

export async function beginAttachmentUpload(
    actorId: number,
    scope: AttachmentScope,
    filename: string,
    mediaType: string,
    expectedSizeBytes: number,
    expectedSha256: string,
    group?: string,
) {
    await initializeDatabase();
    await pruneExpiredUploads();
    const clean = validateUploadMetadata(filename, mediaType, expectedSizeBytes, expectedSha256);
    const owner = await resolveScope(actorId, scope, group, "write");
    const quotaLimit = configuredQuotaBytes(scope);
    if (expectedSizeBytes > quotaLimit) throw new Error("ATTACHMENT_QUOTA_EXCEEDED");
    const id = randomUUID();
    await mkdir(resolve(storageRoot(), "uploads"), { recursive: true, mode: 0o700 });
    const handle = await open(uploadPath(id), "wx", 0o600);
    await handle.close();
    try {
        const client = await db.connect();
        try {
            await client.query("BEGIN");
            await lockQuota(client, owner);
            const usage = await quotaUsage(client, owner);
            if (usage.usedBytes + usage.reservedBytes + expectedSizeBytes > quotaLimit) {
                throw new Error("ATTACHMENT_QUOTA_EXCEEDED");
            }
            await client.query(
            `INSERT INTO attachment_uploads (
                id, original_filename, media_type, expected_size_bytes, expected_sha256,
                owner_actor_id, group_id, created_by_actor_id, expires_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [id, clean.filename, clean.mediaType, expectedSizeBytes, clean.sha256,
                owner.ownerActorId, owner.groupId, actorId, new Date(Date.now() + UPLOAD_TTL_MS).toISOString()],
            );
            await recordAudit(client, "upload_reserved", actorId, owner, null, id, expectedSizeBytes,
                { filename: clean.filename, media_type: clean.mediaType, expected_sha256: clean.sha256 });
            await client.query("COMMIT");
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    } catch (error) {
        await unlink(uploadPath(id)).catch(() => undefined);
        throw error;
    }
    const quota = await getAttachmentQuota(actorId, scope, group);
    return { upload_id: id, received_size_bytes: 0, expected_size_bytes: expectedSizeBytes, expires_at: new Date(Date.now() + UPLOAD_TTL_MS).toISOString(), quota };
}

export async function getAttachmentQuota(actorId: number, scope: AttachmentScope, group?: string) {
    await initializeDatabase();
    const owner = await resolveScope(actorId, scope, group, "read");
    const client = await db.connect();
    try {
        await client.query("BEGIN");
        await lockQuota(client, owner);
        const usage = await quotaUsage(client, owner);
        await client.query("COMMIT");
        return quotaSnapshot(owner, usage.usedBytes, usage.reservedBytes);
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

export async function cancelAttachmentUpload(actorId: number, uploadId: string) {
    await initializeDatabase();
    const client = await db.connect();
    let result;
    try {
        await client.query("BEGIN");
        result = await client.query<{ id: string; owner_actor_id: string | number | null; group_id: string | number | null; expected_size_bytes: string | number }>(
        `DELETE FROM attachment_uploads
         WHERE id = $1
           AND (
                owner_actor_id = $2
                OR EXISTS (
                    SELECT 1 FROM access_group_memberships
                    WHERE access_group_memberships.group_id = attachment_uploads.group_id
                      AND access_group_memberships.actor_id = $2
                      AND access_group_memberships.removed_at IS NULL
                      AND access_group_memberships.can_write
                )
           )
         RETURNING id, owner_actor_id, group_id, expected_size_bytes`,
        [uploadId, actorId],
        );
        if (result.rows[0]) {
            const row = result.rows[0];
            await recordAudit(client, "upload_cancelled", actorId,
                { ownerActorId: row.owner_actor_id === null ? null : Number(row.owner_actor_id), groupId: row.group_id === null ? null : Number(row.group_id) },
                null, uploadId, Number(row.expected_size_bytes));
        }
        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally { client.release(); }
    if (!result.rows[0]) return { upload_id: uploadId, cancelled: false };
    await unlink(uploadPath(uploadId)).catch(() => undefined);
    return { upload_id: uploadId, cancelled: true };
}

export async function appendAttachmentChunk(actorId: number, uploadId: string, offset: number, dataBase64: string) {
    await initializeDatabase();
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("ATTACHMENT_OFFSET_INVALID");
    const data = Buffer.from(dataBase64, "base64");
    if (data.length > MAX_CHUNK_BYTES || data.toString("base64").replace(/=+$/, "") !== dataBase64.replace(/=+$/, "")) {
        throw new Error("ATTACHMENT_CHUNK_INVALID");
    }
    const client = await db.connect();
    try {
        await client.query("BEGIN");
        const result = await client.query<{
            received_size_bytes: string | number;
            expected_size_bytes: string | number;
        }>(
            `SELECT received_size_bytes, expected_size_bytes
             FROM attachment_uploads
             WHERE id = $1 AND expires_at > NOW()
               AND (
                    owner_actor_id = $2
                    OR EXISTS (
                        SELECT 1 FROM access_group_memberships
                        WHERE access_group_memberships.group_id = attachment_uploads.group_id
                          AND access_group_memberships.actor_id = $2
                          AND access_group_memberships.removed_at IS NULL
                          AND access_group_memberships.can_write
                    )
               )
             FOR UPDATE`,
            [uploadId, actorId],
        );
        const upload = result.rows[0];
        if (!upload) throw new Error("ATTACHMENT_UPLOAD_NOT_FOUND_OR_NOT_AUTHORIZED");
        const received = Number(upload.received_size_bytes);
        const expected = Number(upload.expected_size_bytes);
        if (offset !== received || received + data.length > expected) throw new Error("ATTACHMENT_OFFSET_INVALID");
        const handle = await open(uploadPath(uploadId), "r+");
        try {
            await handle.write(data, 0, data.length, offset);
            await handle.sync();
        } finally {
            await handle.close();
        }
        const next = received + data.length;
        await client.query("UPDATE attachment_uploads SET received_size_bytes = $2 WHERE id = $1", [uploadId, next]);
        await client.query("COMMIT");
        return { upload_id: uploadId, received_size_bytes: next, expected_size_bytes: expected, complete: next === expected };
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

export async function finalizeAttachmentUpload(actorId: number, uploadId: string) {
    await initializeDatabase();
    const client = await db.connect();
    try {
        await client.query("BEGIN");
        const result = await client.query<{
            id: string; original_filename: string; media_type: string;
            expected_size_bytes: string | number; expected_sha256: string;
            received_size_bytes: string | number; owner_actor_id: string | number | null;
            group_id: string | number | null; created_by_actor_id: string | number;
        }>(
            `SELECT * FROM attachment_uploads
             WHERE id = $1 AND expires_at > NOW()
               AND (
                    owner_actor_id = $2
                    OR EXISTS (
                        SELECT 1 FROM access_group_memberships
                        WHERE access_group_memberships.group_id = attachment_uploads.group_id
                          AND access_group_memberships.actor_id = $2
                          AND access_group_memberships.removed_at IS NULL
                          AND access_group_memberships.can_write
                    )
               )
             FOR UPDATE`,
            [uploadId, actorId],
        );
        const upload = result.rows[0];
        if (!upload) throw new Error("ATTACHMENT_UPLOAD_NOT_FOUND_OR_NOT_AUTHORIZED");
        if (Number(upload.received_size_bytes) !== Number(upload.expected_size_bytes)) throw new Error("ATTACHMENT_UPLOAD_INCOMPLETE");
        let sourcePath: string;
        try {
            await stat(uploadPath(uploadId));
            sourcePath = uploadPath(uploadId);
        } catch {
            sourcePath = objectPath(upload.expected_sha256);
        }
        const verified = await hashFile(sourcePath);
        if (verified.size !== Number(upload.expected_size_bytes) || verified.sha256 !== upload.expected_sha256) {
            throw new Error("ATTACHMENT_INTEGRITY_MISMATCH");
        }
        const destination = objectPath(verified.sha256);
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`attachment:${verified.sha256}`]);
        await mkdir(resolve(storageRoot(), "objects", verified.sha256.slice(0, 2)), { recursive: true, mode: 0o700 });
        try {
            await stat(destination);
            await unlink(uploadPath(uploadId)).catch(() => undefined);
        } catch {
            await rename(uploadPath(uploadId), destination);
        }
        const inserted = await client.query<AttachmentRow>(
            `INSERT INTO attachments (
                id, original_filename, media_type, size_bytes, sha256, storage_key,
                owner_actor_id, group_id, created_by_actor_id, payload_external_id
             ) VALUES ($1::uuid,$2,$3,$4,$5,$5,$6,$7,$8,'payload:artifact:' || $1::text || ':v1')
             RETURNING *`,
            [upload.id, upload.original_filename, upload.media_type, verified.size, verified.sha256,
                upload.owner_actor_id, upload.group_id, upload.created_by_actor_id],
        );
        await client.query("DELETE FROM attachment_uploads WHERE id = $1", [uploadId]);
        await recordAudit(client, "upload_finalized", actorId,
            { ownerActorId: upload.owner_actor_id === null ? null : Number(upload.owner_actor_id), groupId: upload.group_id === null ? null : Number(upload.group_id) },
            upload.id, uploadId, verified.size, { sha256: verified.sha256 });
        await client.query("COMMIT");
        return mapAttachment(inserted.rows[0]);
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

export async function getAttachment(actorId: number, id: string) {
    await initializeDatabase();
    const result = await db.query<AttachmentRow>(
        `SELECT attachments.* FROM attachments WHERE attachments.id = $1 AND ${attachmentAccessSql}`,
        [id, actorId, "read"],
    );
    return result.rows[0] ? mapAttachment(result.rows[0]) : null;
}

export async function listAttachments(actorId: number, scope: AttachmentScope, group?: string, limit = 20) {
    await initializeDatabase();
    const owner = await resolveScope(actorId, scope, group, "read");
    const result = await db.query<AttachmentRow>(
        `SELECT * FROM attachments
         WHERE owner_actor_id IS NOT DISTINCT FROM $1 AND group_id IS NOT DISTINCT FROM $2
         ORDER BY created_at DESC, id DESC LIMIT $3`,
        [owner.ownerActorId, owner.groupId, Math.min(Math.max(Math.trunc(limit), 1), 100)],
    );
    return result.rows.map(mapAttachment);
}

export async function readAttachmentChunk(actorId: number, id: string, offset = 0, length = MAX_CHUNK_BYTES) {
    const attachment = await getAttachment(actorId, id);
    if (!attachment) return null;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > attachment.size_bytes) throw new Error("ATTACHMENT_OFFSET_INVALID");
    const safeLength = Math.min(Math.max(Math.trunc(length), 1), MAX_CHUNK_BYTES, attachment.size_bytes - offset);
    const handle = await open(objectPath(attachment.sha256), "r");
    const buffer = Buffer.alloc(safeLength);
    try {
        await handle.read(buffer, 0, safeLength, offset);
    } finally {
        await handle.close();
    }
    return { attachment, offset, length: safeLength, data_base64: buffer.toString("base64"), eof: offset + safeLength >= attachment.size_bytes };
}

export async function linkAttachmentToContext(
    actorId: number,
    attachmentId: string,
    contextId: number,
    relationship: AttachmentRelationship = "source",
    sortOrder = 0,
    pageStart?: number,
    pageEnd?: number,
    derivedFromAttachmentId?: string,
) {
    await initializeDatabase();
    const result = await db.query(
        `INSERT INTO context_attachments (
            context_id, attachment_id, relationship, sort_order, page_start, page_end,
            created_by_actor_id, derived_from_attachment_id
         )
         SELECT contexts.id, attachments.id, $4, $5, $6, $7, $2, $8
         FROM contexts, attachments
         WHERE contexts.id = $1 AND attachments.id = $3
           AND (
                (contexts.visibility = 'personal' AND contexts.actor_id = $2
                 AND attachments.owner_actor_id = $2 AND attachments.group_id IS NULL)
                OR
                (contexts.visibility = 'group' AND contexts.group_id = attachments.group_id
                 AND EXISTS (
                    SELECT 1 FROM access_group_memberships
                    WHERE access_group_memberships.group_id = contexts.group_id
                      AND access_group_memberships.actor_id = $2
                      AND access_group_memberships.removed_at IS NULL
                      AND access_group_memberships.can_write
                 ))
           )
         ON CONFLICT (context_id, attachment_id, relationship) DO UPDATE
         SET sort_order = EXCLUDED.sort_order, page_start = EXCLUDED.page_start,
             page_end = EXCLUDED.page_end, derived_from_attachment_id = EXCLUDED.derived_from_attachment_id
         RETURNING context_id, attachment_id, relationship, sort_order, page_start, page_end,
                   derived_from_attachment_id`,
        [contextId, actorId, attachmentId, relationship, sortOrder, pageStart ?? null, pageEnd ?? null,
            derivedFromAttachmentId ?? null],
    );
    return result.rows[0] ?? null;
}

export async function listContextAttachments(actorId: number, contextId: number) {
    await initializeDatabase();
    const result = await db.query<AttachmentRow & {
        relationship: AttachmentRelationship; sort_order: number; page_start: number | null; page_end: number | null;
        derived_from_payload_id: string | null;
    }>(
        `SELECT attachments.*, context_attachments.relationship, context_attachments.sort_order,
                context_attachments.page_start, context_attachments.page_end,
                derived_payload.payload_external_id AS derived_from_payload_id
         FROM context_attachments
         INNER JOIN attachments ON attachments.id = context_attachments.attachment_id
         LEFT JOIN attachments AS derived_payload
           ON derived_payload.id = context_attachments.derived_from_attachment_id
         WHERE context_attachments.context_id = $1 AND ${attachmentAccessSql}
         ORDER BY context_attachments.sort_order, attachments.id`,
        [contextId, actorId, "read"],
    );
    return result.rows.map((row) => ({
        ...mapAttachment(row),
        relationship: row.relationship,
        sort_order: row.sort_order,
        page_start: row.page_start,
        page_end: row.page_end,
        derived_from_payload_id: row.derived_from_payload_id,
    }));
}

export async function deleteAttachment(actorId: number, id: string) {
    await initializeDatabase();
    const client = await db.connect();
    try {
        await client.query("BEGIN");
        const result = await client.query<AttachmentRow>(
            `DELETE FROM attachments
             WHERE attachments.id = $1 AND ${attachmentAccessSql}
             RETURNING *`,
            [id, actorId, "write"],
        );
        const row = result.rows[0];
        if (!row) {
            await client.query("COMMIT");
            return null;
        }
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`attachment:${row.storage_key}`]);
        const remaining = await client.query("SELECT 1 FROM attachments WHERE storage_key = $1 LIMIT 1", [row.storage_key]);
        await recordAudit(client, "attachment_deleted", actorId,
            { ownerActorId: row.owner_actor_id === null ? null : Number(row.owner_actor_id), groupId: row.group_id === null ? null : Number(row.group_id) },
            row.id, null, Number(row.size_bytes), { sha256: row.sha256 });
        await client.query("COMMIT");
        if (!remaining.rows[0]) await unlink(objectPath(row.storage_key)).catch(() => undefined);
        return mapAttachment(row);
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

async function listFiles(root: string): Promise<string[]> {
    let entries;
    try {
        entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
    }
    const files: string[] = [];
    for (const entry of entries) {
        const path = resolve(root, entry.name);
        if (entry.isDirectory()) files.push(...await listFiles(path));
        else if (entry.isFile()) files.push(path);
    }
    return files;
}

export async function auditAttachmentStorage() {
    await initializeDatabase();
    const attachments = await db.query<AttachmentRow>("SELECT * FROM attachments ORDER BY id");
    const uploads = await db.query<{ id: string; received_size_bytes: string | number; expected_size_bytes: string | number }>(
        "SELECT id, received_size_bytes, expected_size_bytes FROM attachment_uploads WHERE expires_at > NOW() ORDER BY id",
    );
    const discrepancies: Array<Record<string, unknown>> = [];
    const expectedObjects = new Set<string>();
    const checkedObjects = new Set<string>();
    for (const row of attachments.rows) {
        expectedObjects.add(objectPath(row.storage_key));
        if (checkedObjects.has(row.storage_key)) continue;
        checkedObjects.add(row.storage_key);
        try {
            const actual = await hashFile(objectPath(row.storage_key));
            if (actual.size !== Number(row.size_bytes) || actual.sha256 !== row.sha256 || row.storage_key !== row.sha256) {
                discrepancies.push({ kind: "object_integrity_mismatch", attachment_id: row.id, storage_key: row.storage_key,
                    expected_size_bytes: Number(row.size_bytes), actual_size_bytes: actual.size,
                    expected_sha256: row.sha256, actual_sha256: actual.sha256 });
            }
        } catch (error) {
            discrepancies.push({ kind: "object_missing_or_unreadable", attachment_id: row.id, storage_key: row.storage_key,
                error: error instanceof Error ? error.message : String(error) });
        }
    }
    const expectedUploads = new Set<string>();
    for (const row of uploads.rows) {
        const path = uploadPath(row.id);
        expectedUploads.add(path);
        try {
            const actual = await stat(path);
            if (actual.size !== Number(row.received_size_bytes) || actual.size > Number(row.expected_size_bytes)) {
                discrepancies.push({ kind: "upload_size_mismatch", upload_id: row.id,
                    expected_received_size_bytes: Number(row.received_size_bytes), actual_size_bytes: actual.size,
                    declared_size_bytes: Number(row.expected_size_bytes) });
            }
        } catch (error) {
            discrepancies.push({ kind: "upload_missing_or_unreadable", upload_id: row.id,
                error: error instanceof Error ? error.message : String(error) });
        }
    }
    for (const path of await listFiles(resolve(storageRoot(), "objects"))) {
        if (!expectedObjects.has(path)) discrepancies.push({ kind: "orphan_object", path });
    }
    for (const path of await listFiles(resolve(storageRoot(), "uploads"))) {
        if (!expectedUploads.has(path)) discrepancies.push({ kind: "orphan_upload", path });
    }
    const client = await db.connect();
    try {
        await client.query("BEGIN");
        await recordAudit(client, discrepancies.length === 0 ? "reconciliation_passed" : "reconciliation_failed",
            null, { ownerActorId: null, groupId: null }, null, null, null,
            { attachment_count: attachments.rowCount, upload_count: uploads.rowCount, discrepancies });
        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally { client.release(); }
    return { ok: discrepancies.length === 0, attachment_count: attachments.rowCount,
        upload_count: uploads.rowCount, discrepancies };
}
