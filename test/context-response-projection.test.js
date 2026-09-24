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

test("search projections are metadata-only by default", () => {
    const projected = projectContextResults(
        Array.from({ length: 10 }, (_, index) => context(index + 1, "x".repeat(20_000))),
        "search",
    );

    assert.equal(projected.results.length, 10);
    assert.equal(projected.response_truncated, false);
    assert.equal(projected.content_budget_bytes, 0);
    assert.equal(projected.content_bytes_returned, 0);
    assert.ok(projected.results.every((result) => result.content === undefined));
    assert.ok(projected.results.every((result) => result.content_omitted === true));
    assert.ok(projected.results.every((result) => result.content_bytes === 20_000));
    assert.ok(JSON.stringify(projected.results).length <= 24_000);
});

test("search projections honor one total UTF-8-safe content byte budget", () => {
    const projected = projectContextResults([
        context(1, "🖍️".repeat(200)),
        context(2, "second payload"),
    ], "search", 17);

    assert.equal(projected.content_budget_bytes, 17);
    assert.ok(projected.content_bytes_returned <= 17);
    assert.ok(!projected.results[0].content.includes("�"));
    assert.ok(!projected.results[1].content.includes("�"));
    assert.equal(
        Buffer.byteLength(projected.results.map((result) => result.content ?? "").join(""), "utf8"),
        projected.content_bytes_returned,
    );
});
