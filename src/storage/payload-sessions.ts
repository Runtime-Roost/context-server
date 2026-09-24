import { createHash, randomUUID } from "node:crypto";
import { db, initializeDatabase } from "./db.js";

export const MAX_PAYLOAD_READ_BYTES = 32 * 1024;

type PayloadRow = {
    id: string; context_id: number | string; version: number; media_type: string;
    text_content: string; size_bytes: number | string;
};

const contextReadPredicate = `(
    contexts.visibility = 'whiteboard'
    OR (contexts.visibility = 'personal' AND contexts.actor_id = $2)
    OR (contexts.visibility = 'direct' AND EXISTS (
        SELECT 1 FROM direct_context_envelopes
        WHERE direct_context_envelopes.context_id = contexts.id
          AND direct_context_envelopes.recipient_actor_id = $2
    ))
    OR (contexts.visibility = 'channel' AND EXISTS (
        SELECT 1 FROM channel_memberships
        WHERE channel_memberships.channel_id = contexts.channel_id
          AND channel_memberships.actor_id = $2 AND channel_memberships.removed_at IS NULL
    ))
    OR (contexts.visibility = 'group' AND EXISTS (
        SELECT 1 FROM access_group_memberships
        WHERE access_group_memberships.group_id = contexts.group_id
          AND access_group_memberships.actor_id = $2 AND access_group_memberships.removed_at IS NULL
          AND access_group_memberships.can_read
    ))
)`;

export async function resolveAuthorizedContextPayload(actorId: number, payloadId: string) {
    await initializeDatabase();
    const result = await db.query<PayloadRow>(
        `SELECT context_payloads.id, context_payloads.context_id, context_payloads.version,
                context_payloads.media_type, context_payloads.text_content, context_payloads.size_bytes
         FROM context_payloads
         INNER JOIN contexts ON contexts.id = context_payloads.context_id
         WHERE context_payloads.id = $1 AND ${contextReadPredicate}`,
        [payloadId, actorId],
    );
    return result.rows[0] ?? null;
}

export async function payloadReferenceForContext(actorId: number, contextId: number) {
    await initializeDatabase();
    const result = await db.query<PayloadRow>(
        `SELECT context_payloads.id, context_payloads.context_id, context_payloads.version,
                context_payloads.media_type, context_payloads.text_content, context_payloads.size_bytes
         FROM contexts
         INNER JOIN context_payloads ON context_payloads.context_id = contexts.id
            AND context_payloads.version = contexts.payload_version
         WHERE contexts.id = $1 AND ${contextReadPredicate}`,
        [contextId, actorId],
    );
    const row = result.rows[0];
    return row ? { id: row.id, version: row.version, kind: "text" as const,
        media_type: row.media_type, size_bytes: Number(row.size_bytes) } : null;
}

export async function readContextPayload(actorId: number, payloadId: string, offset: number, maxBytes: number) {
    const row = await resolveAuthorizedContextPayload(actorId, payloadId);
    if (!row) return null;
    const bytes = Buffer.from(row.text_content, "utf8");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.length) throw new Error("PAYLOAD_OFFSET_INVALID");
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 4) throw new Error("PAYLOAD_READ_SIZE_INVALID");
    const limit = Math.min(maxBytes, MAX_PAYLOAD_READ_BYTES);
    let start = offset;
    while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
    let stop = Math.min(start + limit, bytes.length);
    while (stop > start && stop < bytes.length && (bytes[stop] & 0xc0) === 0x80) stop -= 1;
    const payloadHash = createHash("sha256").update(bytes).digest("hex");
    return {
        payload_ref: { id: row.id, version: row.version, kind: "text" as const,
            media_type: row.media_type, size_bytes: bytes.length, sha256: payloadHash },
        requested_offset: offset, byte_start: start, byte_stop: stop,
        total_bytes: bytes.length, has_more: stop < bytes.length,
        next_offset: stop < bytes.length ? stop : null,
        text: bytes.subarray(start, stop).toString("utf8"),
    };
}

type JobRow = {
    id: string; actor_id: number | string; conversation_binding: string; status: string;
    context_id: number | string; payload_ref: unknown; error_code: string | null;
    created_at: string | Date; started_at: string | Date | null; completed_at: string | Date | null;
    expires_at: string | Date; cancelled_at: string | Date | null;
};

function mapJob(row: JobRow) {
    return { job_id: `job_${row.id}`, kind: "context_payload", status: row.status,
        context_id: Number(row.context_id), payload_ref: row.payload_ref,
        error_code: row.error_code, created_at: new Date(row.created_at).toISOString(),
        started_at: row.started_at ? new Date(row.started_at).toISOString() : null,
        completed_at: row.completed_at ? new Date(row.completed_at).toISOString() : null,
        expires_at: new Date(row.expires_at).toISOString(),
        cancelled_at: row.cancelled_at ? new Date(row.cancelled_at).toISOString() : null };
}

function parseJobId(value: string) {
    const match = /^job_([0-9a-f-]{36})$/i.exec(value);
    if (!match) throw new Error("CONTEXT_JOB_ID_INVALID");
    return match[1].toLowerCase();
}

export async function startContextPayloadJob(actorId: number, conversationBinding: string, contextId: number) {
    const payload = await payloadReferenceForContext(actorId, contextId);
    if (!payload) return null;
    const id = randomUUID();
    const inserted = await db.query<JobRow>(
        `INSERT INTO context_retrieval_jobs (id, actor_id, conversation_binding, context_id, status, expires_at)
         VALUES ($1, $2, $3, $4, 'QUEUED', NOW() + INTERVAL '30 minutes') RETURNING *`,
        [id, actorId, conversationBinding, contextId],
    );
    setImmediate(async () => {
        try {
            const running = await db.query(
                `UPDATE context_retrieval_jobs SET status = 'RUNNING', started_at = NOW()
                 WHERE id = $1 AND status = 'QUEUED' AND cancelled_at IS NULL RETURNING id`, [id]);
            if (!running.rows[0]) return;
            await db.query(
                `UPDATE context_retrieval_jobs SET status = 'COMPLETE', payload_ref = $2, completed_at = NOW()
                 WHERE id = $1 AND status = 'RUNNING'`, [id, payload]);
        } catch {
            await db.query(
                `UPDATE context_retrieval_jobs SET status = 'FAILED', error_code = 'MATERIALIZATION_FAILED', completed_at = NOW()
                 WHERE id = $1 AND status IN ('QUEUED','RUNNING')`, [id]).catch(() => undefined);
        }
    });
    return mapJob(inserted.rows[0]);
}

export async function getContextJob(actorId: number, conversationBinding: string, jobId: string) {
    await initializeDatabase();
    const result = await db.query<JobRow>(
        `SELECT * FROM context_retrieval_jobs
         WHERE id = $1 AND actor_id = $2 AND conversation_binding = $3 AND expires_at > NOW()`,
        [parseJobId(jobId), actorId, conversationBinding]);
    return result.rows[0] ? mapJob(result.rows[0]) : null;
}

export async function cancelContextJob(actorId: number, conversationBinding: string, jobId: string) {
    await initializeDatabase();
    const result = await db.query<JobRow>(
        `UPDATE context_retrieval_jobs SET status = 'CANCELLED', cancelled_at = NOW(), completed_at = NOW()
         WHERE id = $1 AND actor_id = $2 AND conversation_binding = $3
           AND status IN ('QUEUED','RUNNING') AND expires_at > NOW() RETURNING *`,
        [parseJobId(jobId), actorId, conversationBinding]);
    return result.rows[0] ? mapJob(result.rows[0]) : null;
}
