import assert from "node:assert/strict";
import test from "node:test";

process.env.PGDATABASE ??= "personal_context";
process.env.EMBEDDINGS_ENABLED = "false";

const {
    USER_PROFILE_TAG,
} = await import("../dist/mcp/tools.js");

test("user profile uses the explicit profile tag contract", () => {
    assert.equal(USER_PROFILE_TAG, "profile");
});
