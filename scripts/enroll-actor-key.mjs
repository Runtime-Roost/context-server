#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { enrollActorKey } from "../dist/auth/request-auth.js";
import { db } from "../dist/storage/db.js";

function argument(name) {
    const index = process.argv.indexOf(name);
    return index === -1 ? undefined : process.argv[index + 1];
}

const actorExternalId = argument("--actor");
const publicKeyPath = argument("--public-key");
const label = argument("--label");

if (!actorExternalId || !publicKeyPath) {
    console.error(
        "Usage: npm run actor-key:enroll -- --actor actor:provider:name --public-key /path/to/public.pem [--label device-name]",
    );
    process.exitCode = 2;
} else {
    try {
        const publicKeyPem = await readFile(resolve(publicKeyPath), "utf8");
        const enrolled = await enrollActorKey(actorExternalId, publicKeyPem, label);
        console.log(JSON.stringify({ enrolled }, null, 2));
    } finally {
        await db.end();
    }
}
