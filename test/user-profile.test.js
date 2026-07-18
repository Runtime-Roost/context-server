import assert from "node:assert/strict";
import test from "node:test";

process.env.PGDATABASE ??= "personal_context";
process.env.EMBEDDINGS_ENABLED = "false";

const {
    USER_PROFILE_QUERY,
    USER_PROFILE_SENSITIVITY,
} = await import("../dist/mcp/tools.js");

test("user profile uses the fixed profile search contract", () => {
    assert.equal(USER_PROFILE_QUERY, "me");
    assert.equal(USER_PROFILE_SENSITIVITY, "medium");
});
