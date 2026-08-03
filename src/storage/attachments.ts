import { createHash, randomUUID } from "node:crypto";
import {
    mkdir,
    open,
    readFile,
    rename,
    stat,
    unlink,
} from "node:fs/promises";
import { resolve } from "node:path";

import { db, initializeDatabase } from "./db.js";

export const ATTACHMENT_SCOPE_VALUES = ["personal", "group"] as const;
export type AttachmentScope = (typeof ATTACHMENT_SCOPE_VALUES)[number];
export const ATTACHMENT_RELATIONSHIP_VALUES = ["source", "derived", "reference"] as const;
export type AttachmentRelationship = (typeof ATTACHMENT_RELATIONSHIP_VALUES)[number];

const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
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
};

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
    };
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
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ATTACHMENT_BYTES) {
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
    const expired = await db.query<{ id: string }>(
        "DELETE FROM attachment_uploads WHERE expires_at <= NOW() RETURNING id",
    );
    await Promise.all(expired.rows.map((row) => unlink(uploadPath(row.id)).catch(() => undefined)));
    const clean = validateUploadMetadata(filename, mediaType, expectedSizeBytes, expectedSha256);
    const owner = await resolveScope(actorId, scope, group, "write");
    const id = randomUUID();
    await mkdir(resolve(storageRoot(), "uploads"), { recursive: true, mode: 0o700 });
    const handle = await open(uploadPath(id), "wx", 0o600);
    await handle.close();
    try {
        await db.query(
            `INSERT INTO attachment_uploads (
                id, original_filename, media_type, expected_size_bytes, expected_sha256,
                owner_actor_id, group_id, created_by_actor_id, expires_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [id, clean.filename, clean.mediaType, expectedSizeBytes, clean.sha256,
                owner.ownerActorId, owner.groupId, actorId, new Date(Date.now() + UPLOAD_TTL_MS).toISOString()],
        );
    } catch (error) {
        await unlink(uploadPath(id)).catch(() => undefined);
        throw error;
    }
    return { upload_id: id, received_size_bytes: 0, expected_size_bytes: expectedSizeBytes, expires_at: new Date(Date.now() + UPLOAD_TTL_MS).toISOString() };
}

export async function cancelAttachmentUpload(actorId: number, uploadId: string) {
    await initializeDatabase();
    const result = await db.query<{ id: string }>(
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
         RETURNING id`,
        [uploadId, actorId],
    );
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
        let bytes: Buffer;
        try {
            bytes = await readFile(uploadPath(uploadId));
        } catch {
            bytes = await readFile(objectPath(upload.expected_sha256));
        }
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        if (bytes.length !== Number(upload.expected_size_bytes) || sha256 !== upload.expected_sha256) {
            throw new Error("ATTACHMENT_INTEGRITY_MISMATCH");
        }
        const destination = objectPath(sha256);
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`attachment:${sha256}`]);
        await mkdir(resolve(storageRoot(), "objects", sha256.slice(0, 2)), { recursive: true, mode: 0o700 });
        try {
            await stat(destination);
            await unlink(uploadPath(uploadId)).catch(() => undefined);
        } catch {
            await rename(uploadPath(uploadId), destination);
        }
        const inserted = await client.query<AttachmentRow>(
            `INSERT INTO attachments (
                id, original_filename, media_type, size_bytes, sha256, storage_key,
                owner_actor_id, group_id, created_by_actor_id
             ) VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8)
             RETURNING *`,
            [upload.id, upload.original_filename, upload.media_type, bytes.length, sha256,
                upload.owner_actor_id, upload.group_id, upload.created_by_actor_id],
        );
        await client.query("DELETE FROM attachment_uploads WHERE id = $1", [uploadId]);
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
) {
    await initializeDatabase();
    const result = await db.query(
        `INSERT INTO context_attachments (
            context_id, attachment_id, relationship, sort_order, page_start, page_end, created_by_actor_id
         )
         SELECT contexts.id, attachments.id, $4, $5, $6, $7, $2
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
         SET sort_order = EXCLUDED.sort_order, page_start = EXCLUDED.page_start, page_end = EXCLUDED.page_end
         RETURNING context_id, attachment_id, relationship, sort_order, page_start, page_end`,
        [contextId, actorId, attachmentId, relationship, sortOrder, pageStart ?? null, pageEnd ?? null],
    );
    return result.rows[0] ?? null;
}

export async function listContextAttachments(actorId: number, contextId: number) {
    await initializeDatabase();
    const result = await db.query<AttachmentRow & {
        relationship: AttachmentRelationship; sort_order: number; page_start: number | null; page_end: number | null;
    }>(
        `SELECT attachments.*, context_attachments.relationship, context_attachments.sort_order,
                context_attachments.page_start, context_attachments.page_end
         FROM context_attachments
         INNER JOIN attachments ON attachments.id = context_attachments.attachment_id
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
