import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createInspectionServer } from "../dist/inspection/server.js";
import {
    createInspectionWhiteboardContext,
    deleteInspectionWhiteboardContext,
    getInspectionSnapshot,
    updateInspectionWhiteboardContext,
} from "../dist/inspection/store.js";
import { db } from "../dist/storage/db.js";
import { saveContext } from "../dist/mcp/tools.js";

const snapshot = {
    generated_at: "2026-07-30T00:00:00.000Z",
    whiteboard: [],
    private_channels: [],
    private_messages: [],
    privacy: { private_message_contents_exposed: false },
};

async function withServer(store, callback) {
    const publicRoot = await mkdtemp(join(tmpdir(), "inspection-public-"));
    await writeFile(join(publicRoot, "index.html"), "<h1>Inspection</h1>");
    const server = createInspectionServer({
        store,
        publicRoot,
        allowedOrigin: "http://127.0.0.1:4180",
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    try {
        await callback(`http://127.0.0.1:${address.port}`);
    } finally {
        server.close();
        await once(server, "close");
    }
}

test("inspection server exposes snapshot and no agent-control routes", async () => {
    const store = {
        snapshot: async () => snapshot,
        create: async () => assert.fail("create should not be called"),
        update: async () => ({ status: "not_found" }),
        delete: async () => assert.fail("delete should not be called"),
    };
    await withServer(store, async (origin) => {
        const response = await fetch(`${origin}/api/inspection`);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), snapshot);
        assert.equal((await fetch(`${origin}/api/agents`)).status, 404);
        assert.equal((await fetch(`${origin}/api/wakes`, { method: "POST" })).status, 404);
        assert.equal((await fetch(`${origin}/api/contexts`, { method: "POST" })).status, 404);
    });
});

test("whiteboard edit is body-only, same-origin, and forwards the expected version", async () => {
    const calls = [];
    const store = {
        snapshot: async () => snapshot,
        create: async (content) => ({ id: 43, content }),
        update: async (...args) => {
            calls.push(args);
            return {
                status: "updated",
                context: { id: args[0], content: args[1] },
            };
        },
        delete: async (id) => ({ status: "deleted", id }),
    };
    await withServer(store, async (origin) => {
        const blocked = await fetch(`${origin}/api/whiteboard/42`, {
            method: "PATCH",
            headers: {
                "content-type": "application/json",
                origin: "https://malicious.example",
            },
            body: JSON.stringify({
                content: "changed",
                expected_updated_at: "2026-07-30T00:00:00.000Z",
                tags: ["message-to-codex"],
            }),
        });
        assert.equal(blocked.status, 403);

        const accepted = await fetch(`${origin}/api/whiteboard/42`, {
            method: "PATCH",
            headers: {
                "content-type": "application/json",
                origin: "http://127.0.0.1:4180",
                "sec-fetch-site": "same-origin",
            },
            body: JSON.stringify({
                content: "changed",
                expected_updated_at: "2026-07-30T00:00:00.000Z",
                tags: ["ignored-by-contract"],
                actor: "ignored-by-contract",
            }),
        });
        assert.equal(accepted.status, 200);
        assert.deepEqual(calls, [[42, "changed", "2026-07-30T00:00:00.000Z"]]);

        const created = await fetch(`${origin}/api/whiteboard`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                origin: "http://127.0.0.1:4180",
                "sec-fetch-site": "same-origin",
            },
            body: JSON.stringify({ content: "new note", tags: ["ignored"] }),
        });
        assert.equal(created.status, 201);
        assert.equal((await created.json()).context.content, "new note");

        const deleted = await fetch(`${origin}/api/whiteboard/43`, {
            method: "DELETE",
            headers: {
                "content-type": "application/json",
                origin: "http://127.0.0.1:4180",
                "sec-fetch-site": "same-origin",
            },
            body: JSON.stringify({ expected_updated_at: "2026-07-30T00:00:00.000Z" }),
        });
        assert.equal(deleted.status, 200);
    });
});

test("inspection store edits an ordinary Whiteboard note and keeps private bodies out of envelopes", async () => {
    const marker = `inspection-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const saved = await saveContext(marker, ["inspection-test"], "inspection test");
    try {
        const updated = await updateInspectionWhiteboardContext(
            saved.id,
            `${marker}-updated`,
            saved.updated_at,
        );
        assert.equal(updated.status, "updated");
        assert.equal(updated.context.content, `${marker}-updated`);
        assert.deepEqual(updated.context.tags, ["inspection-test"]);
        assert.equal(updated.context.source, "inspection test");

        const inspection = await getInspectionSnapshot(500);
        assert.equal(inspection.privacy.private_message_contents_exposed, false);
        assert.ok(inspection.private_messages.every((message) => !("content" in message)));
        assert.ok(inspection.private_messages.every((message) => !("tags" in message)));
        assert.ok(inspection.private_messages.every((message) => !("source" in message)));
    } finally {
        await db.query("DELETE FROM contexts WHERE id = $1", [saved.id]);
    }
});

test("agent-inbox Whiteboard records are visible but not editable", async () => {
    const marker = `inspection-inbox-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const saved = await saveContext(marker, ["message-to-codex"], "inspection test");
    try {
        const result = await updateInspectionWhiteboardContext(
            saved.id,
            `${marker}-changed`,
            saved.updated_at,
        );
        assert.equal(result.status, "blocked");
        assert.match(result.reason, /invocation payload/i);
        assert.equal(result.context.content, marker);
        const deletion = await deleteInspectionWhiteboardContext(saved.id, saved.updated_at);
        assert.equal(deletion.status, "blocked");
    } finally {
        await db.query("DELETE FROM contexts WHERE id = $1", [saved.id]);
    }
});

test("inspection-created notes are plain attributed Whiteboard records and can be deleted", async () => {
    const marker = `inspection-create-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const created = await createInspectionWhiteboardContext(marker);
    try {
        assert.equal(created.content, marker);
        assert.equal(created.visibility, "whiteboard");
        assert.deepEqual(created.tags, []);
        assert.equal(created.source, "inspection-tool");
        assert.equal(created.actor.external_id, "actor:human:blake");
        const deleted = await deleteInspectionWhiteboardContext(created.id, created.updated_at);
        assert.deepEqual(deleted, { status: "deleted", id: created.id });
        assert.equal(await db.query("SELECT id FROM contexts WHERE id = $1", [created.id])
            .then((result) => result.rowCount), 0);
    } finally {
        await db.query("DELETE FROM contexts WHERE id = $1", [created.id]);
    }
});
