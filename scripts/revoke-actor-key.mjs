#!/usr/bin/env node

import { revokeActorKey } from "../dist/auth/request-auth.js";
import { db } from "../dist/storage/db.js";

function argument(name) {
    const index = process.argv.indexOf(name);
    return index === -1 ? undefined : process.argv[index + 1];
}

const keyId = argument("--key-id");

if (!keyId) {
    console.error("Usage: npm run actor-key:revoke -- --key-id ak_<fingerprint-prefix>");
    process.exitCode = 2;
} else {
    try {
        const revoked = await revokeActorKey(keyId);
        console.log(JSON.stringify({ key_id: keyId, revoked }, null, 2));
    } finally {
        await db.end();
    }
}
