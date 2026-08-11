import { db, initializeDatabase } from "../storage/db.js";
import { approveActorSessionRequest, denyActorSessionRequest } from "./actor-sessions.js";

const TTL_PRESETS = new Set([900, 3_600, 86_400, 604_800]);
const REQUEST_ID = /^asr_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTOR_ID = /^actor:[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*$/i;

type PendingRow = {
    request_id: string;
    actor_external_id: string;
    actor_name: string;
    client_label: string | null;
    requested_at: string | Date;
    request_expires_at: string | Date;
    openai_subject_hash: string | null;
    openai_session_hash: string | null;
};

function iso(value: string | Date) {
    return value instanceof Date ? value.toISOString() : value;
}

export async function listPendingActorSessionRequests() {
    await initializeDatabase();
    await db.query(`
        UPDATE actor_session_requests
        SET status = 'expired'
        WHERE status = 'pending' AND request_expires_at <= NOW()
    `);
    const result = await db.query<PendingRow>(`
        SELECT requests.request_id, actors.external_id AS actor_external_id,
               actors.name AS actor_name, requests.client_label,
               requests.requested_at, requests.request_expires_at,
               requests.openai_subject_hash, requests.openai_session_hash
        FROM actor_session_requests AS requests
        INNER JOIN actors ON actors.id = requests.actor_id
        WHERE requests.status = 'pending' AND requests.request_expires_at > NOW()
        ORDER BY requests.requested_at ASC
        LIMIT 100
    `);
    return result.rows.map((request) => ({
        request_id: request.request_id,
        actor_external_id: request.actor_external_id,
        actor_name: request.actor_name,
        client_label: request.client_label,
        requested_at: iso(request.requested_at),
        request_expires_at: iso(request.request_expires_at),
        binding: request.openai_subject_hash && request.openai_session_hash
            ? "trusted_openai_conversation" as const : "native_client" as const,
        status: "pending" as const,
    }));
}

export async function decideActorSessionRequest(requestId: string, decision: {
    approved: boolean;
    expected_actor_external_id: string;
    expected_client_label: string | null;
    ttl_seconds?: number;
}) {
    if (!REQUEST_ID.test(requestId) || !ACTOR_ID.test(decision.expected_actor_external_id)) {
        throw new Error("Invalid actor-session decision binding");
    }
    if (decision.approved && !TTL_PRESETS.has(decision.ttl_seconds ?? 86_400)) {
        throw new Error("Invalid actor-session TTL preset");
    }
    if (!decision.approved && decision.ttl_seconds !== undefined) {
        throw new Error("Denied actor-session requests cannot include a TTL");
    }
    await initializeDatabase();
    const matched = await db.query<{ client_label: string | null }>(`
        SELECT requests.client_label
        FROM actor_session_requests AS requests
        INNER JOIN actors ON actors.id = requests.actor_id
        WHERE requests.request_id = $1 AND actors.external_id = $2
          AND requests.client_label IS NOT DISTINCT FROM $3
          AND requests.status = 'pending' AND requests.request_expires_at > NOW()
    `, [requestId, decision.expected_actor_external_id, decision.expected_client_label]);
    if (matched.rowCount !== 1) throw new Error("No exact unexpired pending actor-session request matched");
    if (!decision.approved) {
        if (!await denyActorSessionRequest(requestId)) throw new Error("Actor-session request was not denied");
        return { request_id: requestId, actor_external_id: decision.expected_actor_external_id,
            client_label: decision.expected_client_label, status: "denied" as const };
    }
    const approved = await approveActorSessionRequest(
        requestId, decision.expected_actor_external_id, decision.ttl_seconds ?? 86_400,
    );
    const activated = "activated_session" in approved ? approved.activated_session : undefined;
    return {
        request_id: approved.request_id,
        actor_external_id: approved.actor_external_id,
        client_label: approved.client_label,
        status: approved.status === "claimed" ? "claimed" as const : "approved" as const,
        ...(activated?.expires_at ? { session_expires_at: iso(activated.expires_at) } : {}),
    };
}
