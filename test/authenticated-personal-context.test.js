import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import test from "node:test";

process.env.PGDATABASE ??= "personal_context";
process.env.EMBEDDINGS_ENABLED = "false";

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const {
    buildRequestSigningMessage,
    enrollActorKey,
} = await import("../dist/auth/request-auth.js");
const { createServer } = await import("../dist/mcp/server.js");
const { db } = await import("../dist/storage/db.js");
const {
    getContext,
    identifyActor,
    listRecentContext,
    searchContext,
    searchPersonalContext,
} = await import("../dist/mcp/tools.js");

function uniqueValue(prefix) {
    return `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createProof(tool, payload, keyId, privateKey) {
    const timestamp = new Date().toISOString();
    const nonce = randomUUID();
    const message = buildRequestSigningMessage(tool, payload, timestamp, nonce);
    const signature = sign(null, Buffer.from(message, "utf8"), privateKey).toString("base64url");

    return {
        key_id: keyId,
        timestamp,
        nonce,
        signature,
    };
}

function textResult(result) {
    const item = result.content.find((content) => content.type === "text");
    assert.ok(item);
    return JSON.parse(item.text);
}

async function signedCall(client, tool, payload, key, privateKey) {
    return client.callTool({
        name: tool,
        arguments: {
            ...payload,
            auth: createProof(tool, payload, key.key_id, privateKey),
        },
    });
}

test("personal context is private to the authenticated actor across every operation", async () => {
    const ownerExternalId = uniqueValue("actor:test:personal-owner");
    const outsiderExternalId = uniqueValue("actor:test:personal-outsider");
    const marker = uniqueValue("private-notebook");
    const updatedMarker = `${marker}-updated`;
    const ownerIdentity = generateKeyPairSync("ed25519");
    const outsiderIdentity = generateKeyPairSync("ed25519");
    const owner = await identifyActor({
        external_id: ownerExternalId,
        name: "Personal Owner",
        kind: "ai",
    });
    const outsider = await identifyActor({
        external_id: outsiderExternalId,
        name: "Personal Outsider",
        kind: "ai",
    });
    const ownerKey = await enrollActorKey(
        ownerExternalId,
        ownerIdentity.publicKey.export({ type: "spki", format: "pem" }).toString(),
        "personal-owner-test",
    );
    const outsiderKey = await enrollActorKey(
        outsiderExternalId,
        outsiderIdentity.publicKey.export({ type: "spki", format: "pem" }).toString(),
        "personal-outsider-test",
    );
    const server = createServer();
    const client = new Client({ name: "authenticated-personal-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
    ]);
    let contextId;
    let outsiderContextId;

    try {
        const unauthenticated = await client.callTool({
            name: "list_personal_context",
            arguments: {},
        });
        assert.equal(unauthenticated.isError, true);
        assert.equal(textResult(unauthenticated).error.code, "AUTHENTICATION_REQUIRED");
        assert.equal(
            textResult(unauthenticated).error.message,
            "Provide explicit cryptographic authentication or request and claim an operator-approved native actor session.",
        );

        const saved = textResult(await signedCall(
            client,
            "save_personal_context",
            {
                text: marker,
                tags: ["personal-test"],
                source: "authenticated personal context test",
            },
            ownerKey,
            ownerIdentity.privateKey,
        ));
        contextId = saved.saved.id;
        assert.equal(saved.saved.visibility, "personal");
        assert.equal(saved.saved.channel_id, null);
        assert.equal(saved.saved.actor.external_id, ownerExternalId);

        const outsiderSaved = textResult(await signedCall(
            client,
            "save_personal_context",
            { text: marker, tags: ["personal-test", "outsider"] },
            outsiderKey,
            outsiderIdentity.privateKey,
        ));
        outsiderContextId = outsiderSaved.saved.id;

        assert.equal(await getContext(contextId), null);
        assert.ok((await listRecentContext(100)).every((context) => context.id !== contextId));
        assert.ok((await searchContext(marker, 100, "low")).every((context) => context.id !== contextId));

        await db.query(
            `
                INSERT INTO embeddings (context_id, model, vector, created_at, updated_at)
                VALUES
                    ($1, 'personal-boundary-test', '[1,0]', NOW(), NOW()),
                    ($2, 'personal-boundary-test', '[1,0]', NOW(), NOW())
                ON CONFLICT (context_id) DO UPDATE
                SET model = EXCLUDED.model,
                    vector = EXCLUDED.vector,
                    updated_at = EXCLUDED.updated_at
            `,
            [contextId, outsiderContextId],
        );
        const semanticOwnerResults = await searchPersonalContext(
            owner.actor.id,
            marker,
            100,
            "low",
            async () => ({
                generated: true,
                model: "personal-boundary-test",
                vector: [1, 0],
            }),
        );
        assert.ok(semanticOwnerResults.some((context) => context.id === contextId));
        assert.ok(semanticOwnerResults.every((context) => context.id !== outsiderContextId));

        const ownerExact = textResult(await signedCall(
            client,
            "get_personal_context",
            { id: contextId },
            ownerKey,
            ownerIdentity.privateKey,
        ));
        assert.equal(ownerExact.context.id, contextId);

        const outsiderExact = textResult(await signedCall(
            client,
            "get_personal_context",
            { id: contextId },
            outsiderKey,
            outsiderIdentity.privateKey,
        ));
        assert.equal(outsiderExact.context, null);

        const ownerList = textResult(await signedCall(
            client,
            "list_personal_context",
            { limit: 100 },
            ownerKey,
            ownerIdentity.privateKey,
        ));
        assert.ok(ownerList.results.some((context) => context.id === contextId));

        const outsiderList = textResult(await signedCall(
            client,
            "list_personal_context",
            { limit: 100 },
            outsiderKey,
            outsiderIdentity.privateKey,
        ));
        assert.ok(outsiderList.results.every((context) => context.id !== contextId));

        const ownerSearch = textResult(await signedCall(
            client,
            "search_personal_context",
            { query: marker, sensitivity: "low" },
            ownerKey,
            ownerIdentity.privateKey,
        ));
        assert.ok(ownerSearch.results.some((context) => context.id === contextId));

        const outsiderSearch = textResult(await signedCall(
            client,
            "search_personal_context",
            { query: marker, sensitivity: "low" },
            outsiderKey,
            outsiderIdentity.privateKey,
        ));
        assert.ok(outsiderSearch.results.every((context) => context.id !== contextId));

        const outsiderUpdate = textResult(await signedCall(
            client,
            "update_personal_context",
            { id: contextId, text: "outsider tampering" },
            outsiderKey,
            outsiderIdentity.privateKey,
        ));
        assert.equal(outsiderUpdate.updated, null);

        const ownerUpdated = textResult(await signedCall(
            client,
            "update_personal_context",
            { id: contextId, text: updatedMarker, tags: ["personal-test", "updated"] },
            ownerKey,
            ownerIdentity.privateKey,
        ));
        assert.equal(ownerUpdated.updated.content, updatedMarker);
        assert.deepEqual(ownerUpdated.updated.tags, ["personal-test", "updated"]);

        const outsiderDelete = textResult(await signedCall(
            client,
            "delete_personal_context",
            { id: contextId },
            outsiderKey,
            outsiderIdentity.privateKey,
        ));
        assert.equal(outsiderDelete.deleted, null);

        const ownerDeleted = textResult(await signedCall(
            client,
            "delete_personal_context",
            { id: contextId },
            ownerKey,
            ownerIdentity.privateKey,
        ));
        assert.equal(ownerDeleted.deleted.id, contextId);
        contextId = undefined;

        const outsiderDeleted = textResult(await signedCall(
            client,
            "delete_personal_context",
            { id: outsiderContextId },
            outsiderKey,
            outsiderIdentity.privateKey,
        ));
        assert.equal(outsiderDeleted.deleted.id, outsiderContextId);
        outsiderContextId = undefined;
    } finally {
        const remainingContextIds = [contextId, outsiderContextId].filter(Boolean);
        if (remainingContextIds.length > 0) {
            await db.query("DELETE FROM contexts WHERE id = ANY($1::bigint[])", [remainingContextIds]);
        }
        await client.close();
        await server.close();
        await db.query(
            "DELETE FROM actor_keys WHERE actor_id = ANY($1::bigint[])",
            [[owner.actor.id, outsider.actor.id]],
        );
        await db.query(
            "DELETE FROM actors WHERE id = ANY($1::bigint[])",
            [[owner.actor.id, outsider.actor.id]],
        );
    }
});

test.after(async () => {
    await db.end();
});
