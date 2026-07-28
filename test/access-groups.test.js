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

test("access groups own shared records and membership controls every operation", async () => {
    const ownerExternalId = uniqueValue("actor:test:group-owner");
    const memberExternalId = uniqueValue("actor:test:group-member");
    const outsiderExternalId = uniqueValue("actor:test:group-outsider");
    const groupSlug = uniqueValue("journal-readers").toLowerCase().replaceAll(":", "-");
    const marker = uniqueValue("group-owned-context");
    const ownerIdentity = generateKeyPairSync("ed25519");
    const memberIdentity = generateKeyPairSync("ed25519");
    const outsiderIdentity = generateKeyPairSync("ed25519");
    const owner = await identifyActor({
        external_id: ownerExternalId,
        name: "Group Owner",
        kind: "ai",
    });
    const member = await identifyActor({
        external_id: memberExternalId,
        name: "Group Member",
        kind: "ai",
    });
    const outsider = await identifyActor({
        external_id: outsiderExternalId,
        name: "Group Outsider",
        kind: "ai",
    });
    const ownerKey = await enrollActorKey(
        ownerExternalId,
        ownerIdentity.publicKey.export({ type: "spki", format: "pem" }).toString(),
        "group-owner-test",
    );
    const memberKey = await enrollActorKey(
        memberExternalId,
        memberIdentity.publicKey.export({ type: "spki", format: "pem" }).toString(),
        "group-member-test",
    );
    const outsiderKey = await enrollActorKey(
        outsiderExternalId,
        outsiderIdentity.publicKey.export({ type: "spki", format: "pem" }).toString(),
        "group-outsider-test",
    );
    const server = createServer();
    const client = new Client({ name: "access-group-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
    ]);
    let groupId;
    let contextId;

    try {
        const created = textResult(await signedCall(
            client,
            "create_access_group",
            {
                slug: groupSlug,
                name: "Journal Readers",
                description: "Shared private archive",
            },
            ownerKey,
            ownerIdentity.privateKey,
        ));
        groupId = created.group.id;
        assert.equal(created.group.slug, groupSlug);
        assert.equal(created.group.role, "owner");

        const added = textResult(await signedCall(
            client,
            "add_access_group_member",
            {
                group: groupSlug,
                actor_external_id: memberExternalId,
                role: "member",
                can_read: true,
                can_write: true,
            },
            ownerKey,
            ownerIdentity.privateKey,
        ));
        assert.equal(added.membership.actor_external_id, memberExternalId);

        const saved = textResult(await signedCall(
            client,
            "save_group_context",
            {
                group: groupSlug,
                text: marker,
                tags: ["access-group-test"],
                source: "group integration test",
            },
            ownerKey,
            ownerIdentity.privateKey,
        ));
        contextId = saved.saved.id;
        assert.equal(saved.saved.visibility, "group");
        assert.equal(saved.saved.group_id, groupId);
        assert.equal(saved.saved.channel_id, null);
        assert.equal(saved.saved.actor.external_id, ownerExternalId);

        assert.equal(await getContext(contextId), null);
        assert.ok((await listRecentContext(100)).every((context) => context.id !== contextId));
        assert.ok((await searchContext(marker, 100, "low")).every((context) => context.id !== contextId));

        const memberGroups = textResult(await signedCall(
            client,
            "list_access_groups",
            {},
            memberKey,
            memberIdentity.privateKey,
        ));
        assert.ok(memberGroups.groups.some((group) => group.id === groupId));

        const memberExact = textResult(await signedCall(
            client,
            "get_group_context",
            { id: contextId },
            memberKey,
            memberIdentity.privateKey,
        ));
        assert.equal(memberExact.context.id, contextId);

        const outsiderExact = textResult(await signedCall(
            client,
            "get_group_context",
            { id: contextId },
            outsiderKey,
            outsiderIdentity.privateKey,
        ));
        assert.equal(outsiderExact.context, null);

        const outsiderList = await signedCall(
            client,
            "list_group_context",
            { group: groupSlug },
            outsiderKey,
            outsiderIdentity.privateKey,
        );
        assert.equal(outsiderList.isError, true);
        assert.equal(
            textResult(outsiderList).error.code,
            "ACCESS_GROUP_NOT_FOUND_OR_NOT_AUTHORIZED",
        );

        const memberSearch = textResult(await signedCall(
            client,
            "search_group_context",
            { group: groupSlug, query: marker, sensitivity: "low" },
            memberKey,
            memberIdentity.privateKey,
        ));
        assert.equal(memberSearch.results[0].id, contextId);

        const memberUpdated = textResult(await signedCall(
            client,
            "update_group_context",
            { id: contextId, text: `${marker}-updated` },
            memberKey,
            memberIdentity.privateKey,
        ));
        assert.equal(memberUpdated.updated.content, `${marker}-updated`);
        assert.equal(memberUpdated.updated.actor.external_id, ownerExternalId);

        await signedCall(
            client,
            "add_access_group_member",
            {
                group: groupSlug,
                actor_external_id: memberExternalId,
                role: "member",
                can_read: true,
                can_write: false,
            },
            ownerKey,
            ownerIdentity.privateKey,
        );
        const readOnlyDelete = textResult(await signedCall(
            client,
            "delete_group_context",
            { id: contextId },
            memberKey,
            memberIdentity.privateKey,
        ));
        assert.equal(readOnlyDelete.deleted, null);

        const removed = textResult(await signedCall(
            client,
            "remove_access_group_member",
            { group: groupSlug, actor_external_id: memberExternalId },
            ownerKey,
            ownerIdentity.privateKey,
        ));
        assert.equal(removed.membership.removed, true);

        const removedExact = textResult(await signedCall(
            client,
            "get_group_context",
            { id: contextId },
            memberKey,
            memberIdentity.privateKey,
        ));
        assert.equal(removedExact.context, null);

        const removedUpdate = textResult(await signedCall(
            client,
            "update_group_context",
            { id: contextId, text: "removed-member-tampering" },
            memberKey,
            memberIdentity.privateKey,
        ));
        assert.equal(removedUpdate.updated, null);

        const ownerDeleted = textResult(await signedCall(
            client,
            "delete_group_context",
            { id: contextId },
            ownerKey,
            ownerIdentity.privateKey,
        ));
        assert.equal(ownerDeleted.deleted.id, contextId);
        contextId = undefined;
    } finally {
        if (contextId) {
            await db.query("DELETE FROM contexts WHERE id = $1", [contextId]);
        }
        if (groupId) {
            await db.query("DELETE FROM access_groups WHERE id = $1", [groupId]);
        }
        await client.close();
        await server.close();
        await db.query(
            "DELETE FROM actor_keys WHERE actor_id = ANY($1::bigint[])",
            [[owner.actor.id, member.actor.id, outsider.actor.id]],
        );
        await db.query(
            "DELETE FROM actors WHERE id = ANY($1::bigint[])",
            [[owner.actor.id, member.actor.id, outsider.actor.id]],
        );
    }
});

test.after(async () => {
    await db.end();
});
