import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

process.env.PGDATABASE ??= "personal_context";
process.env.REQUIRE_CONTEXT_AUTHENTICATION = "true";
process.env.TRUST_OPENAI_TUNNEL_IDENTITY = "true";

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { enforceRoostToolCapability } = await import("../dist/auth/roost-sso-authority.js");
const { createServer } = await import("../dist/mcp/server.js");
const { WorkshopDraftsClient } = await import("../dist/mcp/workshop-drafts.js");

const workspaceId = "b346b742-c2d8-484a-b5d1-7e65d5e8a808";
const draftId = "04d60944-f95a-4ba8-94b4-97ff9464fa20";
const openId = "8a3f44af-e91a-4aa5-94c1-1ed8aed1092e";
const assignedDraftId = "a87fdfe5-dd59-44a7-a8a1-f216d263508c";
const chatgpt = { actor_id: 92, actor_external_id: "actor:openai:chatgpt", actor_name: "ChatGPT", key_id: "roost-sso-authority" };
const chatgptCaps = ["workshop.drafts.read", "workshop.drafts.create", "workshop.drafts.update"];
const conversation = { "openai/subject": "v1/workshop-test-subject", "openai/session": "v1/workshop-test-session" };
const whiteboardConversation = { "openai/subject": "v1/whiteboard-only-subject", "openai/session": "v1/whiteboard-only-session" };

function parseResult(result) {
  return JSON.parse(result.content.find((item) => item.type === "text").text);
}

test("conversation MCP exposes draft-only tools, derives ChatGPT actor from SSO, and denies other actors", async () => {
  const root = await mkdtemp(join(tmpdir(), "context-workshop-drafts-"));
  const credentialFile = join(root, "workshop.env");
  await writeFile(credentialFile, "ROOST_WORKSHOP_SERVICE_TOKEN=workshop-test-token-0123456789\n", { mode: 0o600 });
  const requests = [];
  const currentDraft = {
    task_id: draftId, workspace_id: workspaceId, status: "draft", revision: 1,
    owner_actor_id: null, created_by_actor_id: chatgpt.actor_external_id, title: "Draft task",
    description: "", priority: "normal", acceptance_criteria: ["Reviewed"], source_context_ids: [],
  };
  const assignedDraft = { ...currentDraft, task_id: assignedDraftId, owner_actor_id: "actor:human:blake" };
  const fetcher = async (input, init) => {
    const url = new URL(String(input));
    const actor = new Headers(init.headers).get("x-roost-actor");
    requests.push({ method: init.method, pathname: url.pathname, search: url.search, actor, body: init.body ? JSON.parse(init.body) : null });
    assert.equal(actor, chatgpt.actor_external_id);
    if (url.pathname.endsWith("/tasks") && init.method === "GET") {
      return Response.json({ tasks: [currentDraft, { ...currentDraft, task_id: openId, status: "open" }] });
    }
    if (url.pathname.endsWith(`/tasks/${draftId}`) && init.method === "GET") return Response.json({ task: currentDraft });
    if (url.pathname.endsWith(`/tasks/${assignedDraftId}`) && init.method === "GET") return Response.json({ task: assignedDraft });
    if (url.pathname.endsWith(`/tasks/${openId}`) && init.method === "GET") return Response.json({ task: { ...currentDraft, task_id: openId, status: "open" } });
    if (url.pathname.endsWith("/tasks") && init.method === "POST") {
      const body = JSON.parse(init.body);
      return Response.json({ task: { ...currentDraft, ...body.task, status: body.initial_status, created_by_actor_id: actor } }, { status: 201 });
    }
    if (url.pathname.endsWith(`/tasks/${draftId}`) && init.method === "PATCH") {
      const body = JSON.parse(init.body);
      return Response.json({ task: { ...currentDraft, ...body.changes, revision: 2 } });
    }
    if (url.pathname.endsWith(`/tasks/${assignedDraftId}`) && init.method === "PATCH") {
      const body = JSON.parse(init.body);
      return Response.json({ task: { ...assignedDraft, ...body.changes, revision: 2 } });
    }
    throw new Error(`unexpected request ${init.method} ${url.pathname}`);
  };
  const draftsClient = new WorkshopDraftsClient({
    baseUrl: "http://127.0.0.1:4340/", serviceEnvFile: credentialFile, workspaceId, fetcher,
  });
  const authority = {
    async authorize(identity, tool, payload) {
      const isChatgpt = identity.subject === conversation["openai/subject"] && identity.session === conversation["openai/session"];
      const isWhiteboard = identity.subject === whiteboardConversation["openai/subject"] && identity.session === whiteboardConversation["openai/session"];
      if (!isChatgpt && !isWhiteboard) {
        throw new Error("AUTHENTICATION_REQUIRED");
      }
      const capabilities = isWhiteboard ? ["context.whiteboard.read"] : chatgptCaps;
      enforceRoostToolCapability(capabilities, tool, payload);
      return chatgpt;
    },
  };
  const server = createServer({ surface: "conversation", authority, workshopDraftsClient: draftsClient });
  const client = new Client({ name: "workshop-drafts-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const names = (await client.listTools()).tools.map(({ name }) => name);
    for (const name of ["workshop_list_drafts", "workshop_get_draft", "workshop_create_draft", "workshop_update_draft"]) assert.ok(names.includes(name));

    const listed = await client.callTool({ name: "workshop_list_drafts", arguments: { limit: 20 }, _meta: conversation });
    assert.equal(listed.isError, false);
    assert.deepEqual(parseResult(listed).result.map((task) => task.task_id), [draftId]);

    const created = await client.callTool({ name: "workshop_create_draft", arguments: {
      title: "Mama's draft", acceptance_criteria: ["Ready for review"], owner_actor_id: "actor:human:blake",
    }, _meta: conversation });
    assert.equal(created.isError, false);
    const createRequest = requests.find(({ method }) => method === "POST");
    assert.equal(createRequest.body.initial_status, "draft");
    assert.equal(createRequest.body.task.owner_actor_id, null);
    assert.equal(createRequest.body.task.source_context_ids.length, 0);
    assert.equal(createRequest.body.task.title, "Mama's draft");

    const updated = await client.callTool({ name: "workshop_update_draft", arguments: {
      task_id: draftId, expected_revision: 1, changes: { title: "Edited draft" },
    }, _meta: conversation });
    assert.equal(updated.isError, false);
    assert.equal(requests.find(({ method }) => method === "PATCH").body.changes.title, "Edited draft");

    const updatedAssigned = await client.callTool({ name: "workshop_update_draft", arguments: {
      task_id: assignedDraftId, expected_revision: 1, changes: { title: "Edited assigned draft" },
    }, _meta: conversation });
    assert.equal(updatedAssigned.isError, false);
    assert.equal(parseResult(updatedAssigned).result.owner_actor_id, "actor:human:blake");

    const openTask = await client.callTool({ name: "workshop_get_draft", arguments: { task_id: openId }, _meta: conversation });
    assert.equal(openTask.isError, true);
    assert.equal(parseResult(openTask).error.code, "DRAFT_NOT_FOUND");

    const beforeDeniedCall = requests.length;
    const unauthorized = await client.callTool({ name: "workshop_create_draft", arguments: {
      title: "Denied draft", acceptance_criteria: ["Must not reach Workshop"],
    }, _meta: whiteboardConversation });
    assert.equal(unauthorized.isError, true);
    assert.equal(parseResult(unauthorized).error.code, "CAPABILITY_REQUIRED");
    assert.equal(requests.length, beforeDeniedCall);

    const mismatchedBinding = await client.callTool({ name: "workshop_list_drafts", arguments: {}, _meta: {
      "openai/subject": conversation["openai/subject"], "openai/session": "v1/another-session",
    } });
    assert.equal(mismatchedBinding.isError, true);
    assert.equal(parseResult(mismatchedBinding).error.code, "AUTHENTICATION_REQUIRED");
  } finally {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
