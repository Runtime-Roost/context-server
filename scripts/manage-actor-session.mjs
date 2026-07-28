#!/usr/bin/env node

import {
    approveActorSessionRequest,
    denyActorSessionRequest,
    revokeActorSession,
} from "../dist/auth/actor-sessions.js";
import { db } from "../dist/storage/db.js";

function argument(name) {
    const index = process.argv.indexOf(name);
    return index === -1 ? undefined : process.argv[index + 1];
}

const command = process.argv[2];

try {
    if (command === "approve") {
        const requestId = argument("--request-id");
        const actorExternalId = argument("--actor");
        const ttlText = argument("--ttl-seconds");

        if (!requestId || !actorExternalId) {
            throw new Error(
                "Usage: npm run actor-session:approve -- --request-id asr_<id> --actor actor:provider:name [--ttl-seconds 86400]",
            );
        }

        const ttlSeconds = ttlText === undefined ? undefined : Number.parseInt(ttlText, 10);
        const approved = await approveActorSessionRequest(
            requestId,
            actorExternalId,
            ttlSeconds,
        );
        console.log(JSON.stringify({ approved }, null, 2));
    } else if (command === "deny") {
        const requestId = argument("--request-id");

        if (!requestId) {
            throw new Error(
                "Usage: npm run actor-session:deny -- --request-id asr_<id>",
            );
        }

        const denied = await denyActorSessionRequest(requestId);
        console.log(JSON.stringify({ request_id: requestId, denied }, null, 2));
    } else if (command === "revoke") {
        const sessionId = argument("--session-id");

        if (!sessionId) {
            throw new Error(
                "Usage: npm run actor-session:revoke -- --session-id as_<id>",
            );
        }

        const revoked = await revokeActorSession(sessionId);
        console.log(JSON.stringify({ session_id: sessionId, revoked }, null, 2));
    } else {
        throw new Error("Expected actor-session command: approve, deny, or revoke.");
    }
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
} finally {
    await db.end();
}
