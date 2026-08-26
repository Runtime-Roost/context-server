import assert from "node:assert/strict";
import test from "node:test";

import { projectContextResults } from "../dist/mcp/server.js";

function context(id, content) {
    return {
        id,
        kind: "note",
        visibility: "channel",
        channel_id: 1,
        group_id: null,
        content,
        source: null,
        tags: [],
        actor: null,
        acknowledged_by: [],
        created_at: "2026-08-26T00:00:00.000Z",
        updated_at: "2026-08-26T00:00:00.000Z",
    };
}

test("list projections expose bounded excerpts instead of complete history", () => {
    const projected = projectContextResults([context(1, "x".repeat(2_000))], "list");

    assert.equal(projected.results.length, 1);
    assert.equal(projected.results[0].content.length, 500);
    assert.equal(projected.results[0].content_length, 2_000);
    assert.equal(projected.results[0].content_truncated, true);
});

test("search projections enforce per-record and aggregate response budgets", () => {
    const projected = projectContextResults(
        Array.from({ length: 10 }, (_, index) => context(index + 1, "x".repeat(20_000))),
        "search",
    );

    assert.ok(projected.results.length < 10);
    assert.equal(projected.response_truncated, true);
    assert.ok(projected.results.every((result) => result.content.length <= 8_000));
    assert.ok(JSON.stringify(projected.results).length <= 24_000);
});
