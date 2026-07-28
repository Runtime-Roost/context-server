#!/usr/bin/env node

import { generateKeyPairSync } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

function argument(name) {
    const index = process.argv.indexOf(name);
    return index === -1 ? undefined : process.argv[index + 1];
}

const outputPrefix = argument("--output-prefix");

if (!outputPrefix) {
    console.error(
        "Usage: npm run actor-key:generate -- --output-prefix /secure/path/actor-device",
    );
    process.exitCode = 2;
} else {
    const prefix = resolve(outputPrefix);
    const privatePath = `${prefix}.private.pem`;
    const publicPath = `${prefix}.public.pem`;
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });
    const publicPem = publicKey.export({ type: "spki", format: "pem" });

    await mkdir(dirname(prefix), { recursive: true, mode: 0o700 });
    await writeFile(privatePath, privatePem, { mode: 0o600, flag: "wx" });
    await writeFile(publicPath, publicPem, { mode: 0o644, flag: "wx" });

    console.log(JSON.stringify({
        generated: {
            label: basename(prefix),
            private_key: privatePath,
            public_key: publicPath,
        },
    }, null, 2));
}
