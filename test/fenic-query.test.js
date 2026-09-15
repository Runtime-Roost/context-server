import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

const python = process.env.FENIC_TEST_PYTHON;
const canRunFenic = Boolean(python && existsSync(python));

test("Fenic projects only selected fields from a bounded authorized result", {
    skip: canRunFenic ? false : "set FENIC_TEST_PYTHON to run the Fenic integration test",
}, async () => {
    process.env.FENIC_PYTHON = python;
    const { projectWithFenic } = await import("../dist/query/fenic.js");
    const rows = [{
        id: 7,
        kind: "note",
        visibility: "personal",
        content: "private body",
        source: "test",
        tags: ["fenic"],
        actor: null,
        subject: null,
        payload_ref: null,
        connections: [],
        lifecycle: null,
        acknowledged_by: [],
        created_at: "2026-09-15T00:00:00.000Z",
        updated_at: "2026-09-15T00:00:00.000Z",
    }];
    assert.deepEqual(await projectWithFenic(rows, ["id", "content"]), [{
        id: 7,
        content: "private body",
    }]);
});
