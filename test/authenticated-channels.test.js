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
    revokeActorKey,
} = await import("../dist/auth/request-auth.js");
const { createServer } = await import("../dist/mcp/server.js");
const { db } = await import("../dist/storage/db.js");
const {
    getContext,
    identifyActor,
    searchContext,
} = await import("../dist/mcp/tools.js");

function uniqueValue(prefix) {
    return `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createSigningIdentity() {
    return generateKeyPairSync("ed25519");
}

function createProof(tool, payload, keyId, privateKey, overrides = {}) {
    const timestamp = overrides.timestamp ?? new Date().toISOString();
    const nonce = overrides.nonce ?? randomUUID();
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

async function connectTestClient() {
    const server = createServer();
    const client = new Client({ name: "authenticated-channel-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
    ]);

    return {
        client,
        server,
        async close() {
            await client.close();
            await server.close();
        },
    };
}

async function signedCall(client, tool, payload, key, privateKey, proofOverrides) {
    const auth = createProof(tool, payload, key.key_id, privateKey, proofOverrides);
    return client.callTool({
        name: tool,
        arguments: { ...payload, auth },
    });
}

test("authenticated channel history enforces signatures, replay protection, and membership", async () => {
    const ownerExternalId = uniqueValue("actor:test:channel-owner");
    const memberExternalId = uniqueValue("actor:test:channel-member");
    const outsiderExternalId = uniqueValue("actor:test:channel-outsider");
    const slug = uniqueValue("secure-channel").toLowerCase().replaceAll(":", "-");
    const marker = uniqueValue("authenticated-channel-context");
    const ownerIdentity = createSigningIdentity();
    const memberIdentity = createSigningIdentity();
    const outsiderIdentity = createSigningIdentity();
    const owner = await identifyActor({ external_id: ownerExternalId, name: "Channel Owner", kind: "ai" });
    const member = await identifyActor({ external_id: memberExternalId, name: "Channel Member", kind: "ai" });
    const outsider = await identifyActor({ external_id: outsiderExternalId, name: "Channel Outsider", kind: "ai" });
    const ownerKey = await enrollActorKey(
        ownerExternalId,
        ownerIdentity.publicKey.export({ type: "spki", format: "pem" }).toString(),
        "owner-test",
    );
    const memberKey = await enrollActorKey(
        memberExternalId,
        memberIdentity.publicKey.export({ type: "spki", format: "pem" }).toString(),
        "member-test",
    );
    const outsiderKey = await enrollActorKey(
        outsiderExternalId,
        outsiderIdentity.publicKey.export({ type: "spki", format: "pem" }).toString(),
        "outsider-test",
    );
    const connection = await connectTestClient();
    let channelId;
    let contextId;

    try {
        const createPayload = { slug, name: "Secure Test Channel" };
        const replayNonce = randomUUID();
        const createAuth = createProof(
            "create_channel",
            createPayload,
            ownerKey.key_id,
            ownerIdentity.privateKey,
            { nonce: replayNonce },
        );
        const created = textResult(await connection.client.callTool({
            name: "create_channel",
            arguments: { ...createPayload, auth: createAuth },
        }));
        channelId = created.channel.id;
        assert.equal(created.channel.slug, slug);
        assert.equal(created.channel.role, "owner");

        const replayed = await connection.client.callTool({
            name: "create_channel",
            arguments: { ...createPayload, auth: createAuth },
        });
        assert.equal(replayed.isError, true);
        assert.equal(textResult(replayed).error.code, "AUTHENTICATION_FAILED");

        const tamperedPayload = { slug, name: "Tampered Name" };
        const tamperedAuth = createProof(
            "create_channel",
            createPayload,
            ownerKey.key_id,
            ownerIdentity.privateKey,
        );
        const tampered = await connection.client.callTool({
            name: "create_channel",
            arguments: { ...tamperedPayload, auth: tamperedAuth },
        });
        assert.equal(tampered.isError, true);
        assert.equal(textResult(tampered).error.code, "AUTHENTICATION_FAILED");

        const added = textResult(await signedCall(
            connection.client,
            "add_channel_member",
            { channel: slug, actor_external_id: memberExternalId },
            ownerKey,
            ownerIdentity.privateKey,
        ));
        assert.equal(added.membership.actor_external_id, memberExternalId);
        assert.equal(added.membership.role, "member");

        const saved = textResult(await signedCall(
            connection.client,
            "save_channel_context",
            { channel: slug, text: marker, tags: ["secure-test"] },
            memberKey,
            memberIdentity.privateKey,
        ));
        contextId = saved.saved.id;
        assert.equal(saved.saved.visibility, "channel");
        assert.equal(saved.saved.channel_id, channelId);
        assert.equal(saved.saved.actor.external_id, memberExternalId);

        assert.equal(await getContext(contextId), null);
        assert.ok((await searchContext(marker, 20, "low")).every((context) => context.id !== contextId));

        const exactMember = textResult(await signedCall(
            connection.client,
            "get_channel_context",
            { id: contextId },
            memberKey,
            memberIdentity.privateKey,
        ));
        assert.equal(exactMember.context.id, contextId);

        const exactOutsider = textResult(await signedCall(
            connection.client,
            "get_channel_context",
            { id: contextId },
            outsiderKey,
            outsiderIdentity.privateKey,
        ));
        assert.equal(exactOutsider.context, null);

        const outsiderList = await signedCall(
            connection.client,
            "list_channel_context",
            { channel: slug },
            outsiderKey,
            outsiderIdentity.privateKey,
        );
        assert.equal(outsiderList.isError, true);
        assert.equal(textResult(outsiderList).error.code, "CHANNEL_NOT_FOUND_OR_NOT_AUTHORIZED");

        const nonMemberUpdate = textResult(await signedCall(
            connection.client,
            "update_channel_context",
            { id: contextId, text: "non-member tampering" },
            outsiderKey,
            outsiderIdentity.privateKey,
        ));
        assert.equal(nonMemberUpdate.updated, null);

        const outsiderAdmin = textResult(await signedCall(
            connection.client,
            "add_channel_member",
            { channel: slug, actor_external_id: outsiderExternalId, role: "admin" },
            ownerKey,
            ownerIdentity.privateKey,
        ));
        assert.equal(outsiderAdmin.membership.role, "admin");

        const adminCannotDemoteOwner = await signedCall(
            connection.client,
            "add_channel_member",
            { channel: slug, actor_external_id: ownerExternalId, role: "member" },
            outsiderKey,
            outsiderIdentity.privateKey,
        );
        assert.equal(adminCannotDemoteOwner.isError, true);
        assert.equal(textResult(adminCannotDemoteOwner).error.code, "CHANNEL_OWNER_CANNOT_BE_REMOVED");

        const adminCannotRemoveOwner = await signedCall(
            connection.client,
            "remove_channel_member",
            { channel: slug, actor_external_id: ownerExternalId },
            outsiderKey,
            outsiderIdentity.privateKey,
        );
        assert.equal(adminCannotRemoveOwner.isError, true);
        assert.equal(textResult(adminCannotRemoveOwner).error.code, "CHANNEL_OWNER_CANNOT_BE_REMOVED");

        const memberSearch = textResult(await signedCall(
            connection.client,
            "search_channel_context",
            { channel: slug, query: marker, sensitivity: "low" },
            memberKey,
            memberIdentity.privateKey,
        ));
        assert.equal(memberSearch.results[0].id, contextId);

        const memberUpdated = textResult(await signedCall(
            connection.client,
            "update_channel_context",
            { id: contextId, text: `${marker} updated` },
            memberKey,
            memberIdentity.privateKey,
        ));
        assert.equal(memberUpdated.updated.content, `${marker} updated`);

        const adminUpdate = textResult(await signedCall(
            connection.client,
            "update_channel_context",
            { id: contextId, text: "outsider tampering" },
            outsiderKey,
            outsiderIdentity.privateKey,
        ));
        assert.equal(adminUpdate.updated.content, "outsider tampering");

        const removed = textResult(await signedCall(
            connection.client,
            "remove_channel_member",
            { channel: slug, actor_external_id: memberExternalId },
            ownerKey,
            ownerIdentity.privateKey,
        ));
        assert.equal(removed.membership.removed, true);

        const afterRemoval = textResult(await signedCall(
            connection.client,
            "get_channel_context",
            { id: contextId },
            memberKey,
            memberIdentity.privateKey,
        ));
        assert.equal(afterRemoval.context, null);

        const afterRemovalUpdate = textResult(await signedCall(
            connection.client,
            "update_channel_context",
            { id: contextId, text: "removed member tampering" },
            memberKey,
            memberIdentity.privateKey,
        ));
        assert.equal(afterRemovalUpdate.updated, null);

        const ownerDeleted = textResult(await signedCall(
            connection.client,
            "delete_channel_context",
            { id: contextId },
            ownerKey,
            ownerIdentity.privateKey,
        ));
        assert.equal(ownerDeleted.deleted.id, contextId);
        contextId = undefined;

        await revokeActorKey(outsiderKey.key_id);
        const afterRevocation = await signedCall(
            connection.client,
            "list_channels",
            {},
            outsiderKey,
            outsiderIdentity.privateKey,
        );
        assert.equal(afterRevocation.isError, true);
        assert.equal(textResult(afterRevocation).error.code, "AUTHENTICATION_FAILED");
    } finally {
        if (contextId) {
            await db.query("DELETE FROM contexts WHERE id = $1", [contextId]);
        }
        if (channelId) {
            await db.query("DELETE FROM channels WHERE id = $1", [channelId]);
        }
        await db.query(
            "DELETE FROM actor_keys WHERE actor_id = ANY($1::bigint[])",
            [[owner.actor.id, member.actor.id, outsider.actor.id]],
        );
        await db.query(
            "DELETE FROM actors WHERE id = ANY($1::bigint[])",
            [[owner.actor.id, member.actor.id, outsider.actor.id]],
        );
        await connection.close();
    }
});

test.after(async () => {
    await db.end();
});
