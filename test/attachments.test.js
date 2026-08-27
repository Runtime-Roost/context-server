import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

process.env.PGDATABASE ??= "personal_context";
process.env.EMBEDDINGS_ENABLED = "false";
process.env.ATTACHMENT_STORAGE_DIR = await mkdtemp(join(tmpdir(), "pcs-attachments-test-"));
process.env.ATTACHMENT_PERSONAL_QUOTA_BYTES = "64";
process.env.ATTACHMENT_GROUP_QUOTA_BYTES = "64";

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { buildRequestSigningMessage, enrollActorKey } = await import("../dist/auth/request-auth.js");
const { createServer } = await import("../dist/mcp/server.js");
const { db } = await import("../dist/storage/db.js");
const { identifyActor } = await import("../dist/mcp/tools.js");
const { auditAttachmentStorage } = await import("../dist/storage/attachments.js");

function unique(prefix) {
    return `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function proof(tool, payload, keyId, privateKey) {
    const timestamp = new Date().toISOString();
    const nonce = randomUUID();
    return {
        key_id: keyId,
        timestamp,
        nonce,
        signature: sign(
            null,
            Buffer.from(buildRequestSigningMessage(tool, payload, timestamp, nonce)),
            privateKey,
        ).toString("base64url"),
    };
}

async function call(client, name, payload, key, privateKey) {
    return client.callTool({
        name,
        arguments: { ...payload, auth: proof(name, payload, key.key_id, privateKey) },
    });
}

function json(result) {
    const text = result.content.find((item) => item.type === "text");
    assert.ok(text);
    return JSON.parse(text.text);
}

test("group attachments upload through real handlers and revoke with membership", async () => {
    const ownerExternal = unique("actor:test:attachment-owner");
    const memberExternal = unique("actor:test:attachment-member");
    const outsiderExternal = unique("actor:test:attachment-outsider");
    const group = unique("attachment-group").toLowerCase();
    const actors = [];
    for (const [external_id, name] of [
        [ownerExternal, "Attachment Owner"],
        [memberExternal, "Attachment Member"],
        [outsiderExternal, "Attachment Outsider"],
    ]) {
        actors.push(await identifyActor({ external_id, name, kind: "ai" }));
    }
    const identities = actors.map(() => generateKeyPairSync("ed25519"));
    const keys = await Promise.all(actors.map((actor, index) => enrollActorKey(
        actor.actor.external_id,
        identities[index].publicKey.export({ type: "spki", format: "pem" }).toString(),
        "attachment-test",
    )));
    const server = createServer();
    const client = new Client({ name: "attachment-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    let attachmentId;
    let derivedAttachmentId;
    let contextId;
    let groupId;

    try {
        const reservationBytes = Buffer.alloc(40, 7);
        const reservationPayload = {
            scope: "personal", filename: "reservation.bin", media_type: "application/octet-stream",
            expected_size_bytes: reservationBytes.length,
            expected_sha256: createHash("sha256").update(reservationBytes).digest("hex"),
        };
        const concurrentReservations = await Promise.all([
            call(client, "begin_payload_upload", reservationPayload, keys[0], identities[0].privateKey),
            call(client, "begin_payload_upload", reservationPayload, keys[0], identities[0].privateKey),
        ]);
        assert.equal(concurrentReservations.filter((result) => !result.isError).length, 1);
        assert.equal(concurrentReservations.filter((result) => result.isError).length, 1);
        assert.equal(json(concurrentReservations.find((result) => result.isError)).error.code, "ATTACHMENT_QUOTA_EXCEEDED");
        const reservedUpload = json(concurrentReservations.find((result) => !result.isError)).upload;
        await call(client, "cancel_attachment_upload", { upload_id: reservedUpload.upload_id }, keys[0], identities[0].privateKey);

        groupId = json(await call(client, "create_access_group", {
            slug: group, name: "Attachment Group",
        }, keys[0], identities[0].privateKey)).group.id;
        await call(client, "add_access_group_member", {
            group, actor_external_id: memberExternal, role: "member", can_read: true, can_write: true,
        }, keys[0], identities[0].privateKey);

        const bytes = Buffer.from("immutable journal bytes split across chunks");
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        const begunResult = await call(client, "begin_payload_upload", {
            scope: "group", group, filename: "../Great Journal.pdf", media_type: "application/pdf",
            expected_size_bytes: bytes.length, expected_sha256: sha256,
        }, keys[0], identities[0].privateKey);
        assert.equal(begunResult.isError, undefined, JSON.stringify(json(begunResult)));
        const begun = json(begunResult).upload;

        const badOffset = await call(client, "append_attachment_chunk", {
            upload_id: begun.upload_id, offset: 1, data_base64: bytes.subarray(0, 8).toString("base64"),
        }, keys[0], identities[0].privateKey);
        assert.equal(badOffset.isError, true);
        assert.equal(json(badOffset).error.code, "ATTACHMENT_OFFSET_INVALID");

        let offset = 0;
        for (const chunk of [bytes.subarray(0, 11), bytes.subarray(11)]) {
            const appended = json(await call(client, "append_payload_chunk", {
                upload_id: begun.upload_id, offset, data_base64: chunk.toString("base64"),
            }, keys[0], identities[0].privateKey)).upload;
            offset = appended.received_size_bytes;
        }
        const finalizedPayloadResult = await call(client, "finalize_payload_upload", {
            upload_id: begun.upload_id,
        }, keys[0], identities[0].privateKey);
        assert.equal(finalizedPayloadResult.isError, undefined, JSON.stringify(json(finalizedPayloadResult)));
        const payloadRef = json(finalizedPayloadResult).payload_ref;
        attachmentId = payloadRef.id.split(":")[2];
        assert.equal(payloadRef.kind, "artifact");
        assert.equal(payloadRef.sha256, sha256);
        assert.equal(payloadRef.media_type, "application/pdf");
        assert.equal(payloadRef.size_bytes, bytes.length);

        const quota = json(await call(client, "get_attachment_quota", {
            scope: "group", group,
        }, keys[0], identities[0].privateKey)).quota;
        assert.equal(quota.limit_bytes, 64);
        assert.equal(quota.used_bytes, bytes.length);
        assert.equal(quota.reserved_bytes, 0);
        assert.equal(quota.available_bytes, 64 - bytes.length);

        const tooLarge = Buffer.alloc(64, 1);
        const rejected = await call(client, "begin_attachment_upload", {
            scope: "group", group, filename: "too-large.bin", media_type: "application/octet-stream",
            expected_size_bytes: tooLarge.length,
            expected_sha256: createHash("sha256").update(tooLarge).digest("hex"),
        }, keys[0], identities[0].privateKey);
        assert.equal(rejected.isError, true);
        assert.equal(json(rejected).error.code, "ATTACHMENT_QUOTA_EXCEEDED");

        const saved = json(await call(client, "save_group_context", {
            group, text: "Journal source manifest", tags: ["journal", "manifest"],
        }, keys[0], identities[0].privateKey)).saved;
        contextId = saved.id;
        const linked = json(await call(client, "attach_payload_to_context", {
            payload_id: payloadRef.id, context_id: contextId, role: "canonical",
        }, keys[1], identities[1].privateKey)).link;
        assert.equal(Number(linked.context_id), contextId);
        assert.equal(linked.payload_id, payloadRef.id);
        assert.equal(linked.role, "canonical");

        const derivedBytes = Buffer.from("OCR text");
        const derivedUpload = json(await call(client, "begin_payload_upload", {
            scope: "group", group, filename: "journal.txt", media_type: "text/plain",
            expected_size_bytes: derivedBytes.length,
            expected_sha256: createHash("sha256").update(derivedBytes).digest("hex"),
        }, keys[0], identities[0].privateKey)).upload;
        await call(client, "append_payload_chunk", {
            upload_id: derivedUpload.upload_id, offset: 0, data_base64: derivedBytes.toString("base64"),
        }, keys[0], identities[0].privateKey);
        const derivedPayload = json(await call(client, "finalize_payload_upload", {
            upload_id: derivedUpload.upload_id,
        }, keys[0], identities[0].privateKey)).payload_ref;
        derivedAttachmentId = derivedPayload.id.split(":")[2];

        const selfDerived = await call(client, "attach_payload_to_context", {
            payload_id: derivedPayload.id, context_id: contextId, role: "derived",
            derived_from_payload_id: derivedPayload.id,
        }, keys[1], identities[1].privateKey);
        assert.equal(selfDerived.isError, true);
        assert.equal(json(selfDerived).error.code, "PAYLOAD_DERIVATION_SOURCE_INVALID");

        const derivedLink = json(await call(client, "attach_payload_to_context", {
            payload_id: derivedPayload.id, context_id: contextId, role: "derived",
            derived_from_payload_id: payloadRef.id,
        }, keys[1], identities[1].privateKey)).link;
        assert.equal(derivedLink.derived_from_payload_id, payloadRef.id);
        const contextPayloads = json(await call(client, "list_context_attachments", {
            context_id: contextId,
        }, keys[1], identities[1].privateKey)).attachments;
        assert.equal(contextPayloads.find((item) => item.payload_ref.id === derivedPayload.id).derived_from_payload_id, payloadRef.id);

        const chunk = json(await call(client, "read_attachment_chunk", {
            id: attachmentId, offset: 0, length: 512,
        }, keys[1], identities[1].privateKey)).chunk;
        assert.deepEqual(Buffer.from(chunk.data_base64, "base64"), bytes);
        assert.equal(chunk.eof, true);

        const outsider = json(await call(client, "get_attachment", {
            id: attachmentId,
        }, keys[2], identities[2].privateKey));
        assert.equal(outsider.attachment, null);

        await call(client, "remove_access_group_member", {
            group, actor_external_id: memberExternal,
        }, keys[0], identities[0].privateKey);
        const revoked = json(await call(client, "read_attachment_chunk", {
            id: attachmentId,
        }, keys[1], identities[1].privateKey));
        assert.equal(revoked.chunk, null);

        const audit = await auditAttachmentStorage();
        assert.equal(audit.ok, true);
        assert.deepEqual(audit.discrepancies, []);
    } finally {
        await client.close();
        await server.close();
        if (contextId) await db.query("DELETE FROM contexts WHERE id = $1", [contextId]);
        if (derivedAttachmentId) await db.query("DELETE FROM attachments WHERE id = $1", [derivedAttachmentId]);
        if (attachmentId) await db.query("DELETE FROM attachments WHERE id = $1", [attachmentId]);
        if (groupId) await db.query("DELETE FROM access_groups WHERE id = $1", [groupId]);
        for (const actor of actors) await db.query("DELETE FROM actors WHERE id = $1", [actor.actor.id]);
    }
});

test.after(async () => {
    await db.end();
    await rm(process.env.ATTACHMENT_STORAGE_DIR, { recursive: true, force: true });
});
