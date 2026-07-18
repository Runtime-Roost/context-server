import assert from "node:assert/strict";
import test from "node:test";

process.env.PGDATABASE ??= "personal_context";
process.env.EMBEDDINGS_ENABLED = "false";

const {
    matchesSearchSensitivity,
    resolveSearchResultsWithFallback,
    similarityThresholdForSensitivity,
} = await import("../dist/mcp/tools.js");

test("higher sensitivity uses a stricter similarity threshold", () => {
    assert.equal(similarityThresholdForSensitivity("low"), -1);
    assert.equal(similarityThresholdForSensitivity("medium"), 0.5);
    assert.equal(similarityThresholdForSensitivity("high"), 0.75);

    assert.ok(
        similarityThresholdForSensitivity("low") <
        similarityThresholdForSensitivity("medium"),
    );
    assert.ok(
        similarityThresholdForSensitivity("medium") <
        similarityThresholdForSensitivity("high"),
    );
});

test("sensitivity boundaries filter from broad low to narrow high", () => {
    assert.equal(matchesSearchSensitivity(-0.5, "low"), true);
    assert.equal(matchesSearchSensitivity(0.49, "medium"), false);
    assert.equal(matchesSearchSensitivity(0.5, "medium"), true);
    assert.equal(matchesSearchSensitivity(0.74, "high"), false);
    assert.equal(matchesSearchSensitivity(0.75, "high"), true);
});

test("an empty semantic result does not activate text fallback", async () => {
    let fallbackCalls = 0;
    const results = await resolveSearchResultsWithFallback([], async () => {
        fallbackCalls += 1;
        return [{ id: 1 }];
    });

    assert.deepEqual(results, []);
    assert.equal(fallbackCalls, 0);
});

test("unavailable semantic search activates text fallback", async () => {
    let fallbackCalls = 0;
    const fallbackResults = [{ id: 1 }];
    const results = await resolveSearchResultsWithFallback(null, async () => {
        fallbackCalls += 1;
        return fallbackResults;
    });

    assert.equal(results, fallbackResults);
    assert.equal(fallbackCalls, 1);
});
