# personal-context-server

A personalized context-driven MCP archive server.

ChatGPT, and many others have long-term memories for static facts and user preferences. Obviously, they also have context of the current conversation.

But what if we had a custom layer sit between the two, referencing the user's recent trends and events regardless of the conversation? It would feel more like talking to a friend, rather than a machine we brute forced into learning English and following directions.

This is that layer.

## Example

Long-term memory might know:

- User prefers TypeScript
- User owns a homelab
- User enjoys automation projects

This MCP layer might retrieve:

- User has been building an MCP server this week
- User recently migrated to an RX 7800 XT
- User spent the last month building an Elite Dangerous database

Together, the LLM gains both long-term preferences and recent context _between conversations_.

---

The full LLM runtime situation should look something like this:

<p align=center>User prompt</p>
<p align=center>↓</p>
<p align=center>Conversation context</p>
<p align=center>↓</p>
<p align=center>System prompt</p>
<p align=center>↓</p>
<p align=center>Long-term static memories of user preferences, etc.</p>
<p align=center>↓</p>
<p align=center><u>This MCP layer</u> to fetch recent or trending context outside the current conversation</p>

**AI doesn't need to remember everything. It just needs to know where its memories are.**

**Note:** Your mileage may vary _significantly_ depending on the instructions given to the model. This MCP server can provide relevant context, but it is ultimately up to the LLM to decide when to retrieve it, how to interpret it, and how much weight to give it.

## Configuring

The tracked [mcp.example.json](mcp.example.json) shows the portable MCP client
configuration. Generate the ignored, machine-specific `mcp.json` with an
absolute path to this checkout and the current OS username:

```bash
npm run mcp:config
```

The same command is available in VS Code under **Tasks: Run Task** as
`MCP: Generate config`.

The generated file is local machine configuration and is automatically added
to `.gitignore`. Standard `PGHOST`, `PGDATABASE`, `PGUSER`, `AUTO_MANAGE_DB`,
`REQUIRE_ACTOR_IDENTIFICATION`, `TRUST_OPENAI_TUNNEL_IDENTITY`, and
`EMBEDDINGS_ENABLED`, and `ATTACHMENT_STORAGE_DIR` environment variables
override the generated defaults.
Automatic database management is disabled by default.

The generated file uses this shape:

```json
{
  "mcpServers": {
    "personal_context": {
      "active": true,
      "args": [
        "/PATH/TO/personal-context-server/dist/index.js"
      ],
      "command": "node",
      "env": {
        "PGHOST": "/var/run/postgresql",
        "PGDATABASE": "personal_context",
        "PGUSER": "USERNAME"
      },
      "type": "stdio"
    }
  }
}
```

Create a local `.env` from the example if you want to run the server directly:

```bash
cp .env.example .env
```

Create and manage the local PostgreSQL database with the included helper:

```bash
scripts/db.sh create
scripts/db.sh status
scripts/db.sh shell
```

The helper always manages a database named `personal_context`. It also supports
`drop` and `reset` (with confirmation), and honors the standard PostgreSQL
connection environment variables. The same commands are available from VS Code
under **Tasks: Run Task** as the `Database: ...` tasks.

Set `AUTO_MANAGE_DB=true` to have the server run the helper's `status` check
before connecting its MCP transport and run `create` when the database is
missing. Startup fails instead of creating anything when PostgreSQL is
unreachable or the required PostgreSQL command-line tools are unavailable.

### Inspection tool

The repository includes a separate operator surface for inspecting shared
context without exposing agent controls:

```bash
npm run inspection:start
```

It listens only on `http://127.0.0.1:4180` by default. The browser receives
Whiteboard records, attribution, and actor acknowledgements. It may edit only
the body of an existing Whiteboard note, using optimistic concurrency. Source,
tags, visibility, and actor attribution remain server-owned. Notes carrying a
`message-to-*` inbox tag are read-only because changing their body could alter
an agent invocation payload. There are no create, wake, submit, approve, or
agent-control routes.

Private channel and direct-message bodies are excluded in SQL, not merely
hidden by the UI. The Inspection API returns only an envelope: channel,
participants, sender, timestamps, acknowledgement count, and record ID. Its
response includes `private_message_contents_exposed: false` as an explicit
privacy contract.

An optional native Android companion uses a separate TLS gateway on one exact
RFC1918 address:

```bash
npm run inspection:mobile
```

Set the `INSPECTION_MOBILE_*` values shown in `.env.example`. The TLS private
key and per-phone bearer token must be regular mode-0600 files outside the
repository. The gateway exposes only `GET /api/inspection` and content-only
`PATCH /api/whiteboard/:id`; it holds no MCP, runtime, or agent credential.

### Actor attribution

Actor attribution records who synthesized a memory, while `source` continues to
describe where the information came from. Durable actor IDs represent
operational categories rather than conversations or model versions, for
example `actor:openai:codex`, `actor:openai:chatgpt`, and
`actor:human:blake`.

For clients with persistent MCP sessions, call `identify_actor` once before
saving. The resolved actor becomes active for that server instance, and
subsequent `save_context` calls automatically attach it. Calling
`identify_actor` again switches actors.

Clients that may reconnect or launch a fresh stdio process between calls, such
as some LM Studio configurations, should include actor identity directly in
every save:

```json
{
  "text": "Tested actor attribution successfully.",
  "tags": ["tool_testing"],
  "source": "LM Studio actor-attribution test, 2026-07-19",
  "actor": {
    "external_id": "actor:eden",
    "name": "Eden",
    "kind": "ai"
  }
}
```

An explicit actor requires a stable `external_id`, takes precedence over the
session-active actor, and becomes active when the session does persist. Actor
resolution and context insertion share one database transaction. The standalone
`identify_actor` tool still permits intentionally anonymous actors, but display
names are never used to merge actors.

For compatibility, an unidentified save succeeds with `actor: null` and an
`ACTOR_NOT_IDENTIFIED` warning. Set `REQUIRE_ACTOR_IDENTIFICATION=true` for
clients such as LM Studio to reject the write before it happens. The structured
`ACTOR_IDENTIFICATION_REQUIRED` error tells the model to retry the same
`save_context` call with an actor object. Strict mode is disabled by default and
requires attribution without choosing the actor for the model.

Existing databases upgrade through the transactional `schema_migrations`
ledger. Existing contexts are not backfilled and remain `actor: null`.

### Whiteboard visibility

Every context now has a first-class `visibility` classification. Existing rows
are migrated to `whiteboard`, and new saves default to `whiteboard`. Whiteboard
records are shared context discoverable through `search_context`,
`list_recent_context`, `get_context`, and `get_user_profile`.

The general context tools intentionally accept only `whiteboard`.
Non-whiteboard rows fail closed: current whiteboard reads, updates, deletes,
and context purges do not expose or mutate them. This avoids presenting
self-asserted actor identity as real access control.

### Private notebook

Authenticated actors can keep Tier 2 private notebook records with the
`*_personal_context` tools. A personal record is always attributed to and owned
by the authenticated actor. The server applies that ownership predicate before
text search, semantic ranking, limiting, serialization, exact-ID lookup,
updates, and deletion.

Personal records are invisible to Whiteboard tools, channel tools, and other
authenticated actors. Missing and unauthorized exact IDs both return `null`.
The same enrolled-key and operator-approved actor-session authentication
supported by channels is supported here. Personal records are never retrieved
automatically through the general `search_context` or `list_recent_context`
surfaces; clients must deliberately call the authenticated private-notebook
tools.

### Access groups

Access groups provide Unix-like shared ownership for private archives. A
group-owned context keeps its authenticated actor as the author for provenance,
but the access group owns the authorization boundary. Current members with
`can_read` may list, search, and fetch group records. Current members with
`can_write` may save, update, and delete them.

Group owners and admins manage membership using owner/admin/member roles and
independent read/write capability flags. Removing a member revokes access
immediately without rewriting every group-owned record. Owners cannot be
removed. Membership is enforced before search, semantic ranking, limiting,
serialization, exact-ID lookup, update, and deletion. Missing and unauthorized
exact IDs both return `null`.

Group ownership is distinct from channels and actor-private notes: channels are
conversation/history scopes, personal contexts belong to one actor, and group
contexts belong to an access group shared by its current members.

### Attachments

Attachments are immutable binary source artifacts stored outside context text.
PostgreSQL keeps ownership, integrity, provenance, and context-link metadata;
the bytes live in a content-addressed filesystem store under
`ATTACHMENT_STORAGE_DIR` (default: `./data/attachments`). Never place that
directory inside a publicly served tree. Back it up together with PostgreSQL:
neither half is a complete archive by itself.

Uploads are bounded at 100 MiB and use an integrity-checked sequence:

1. `begin_attachment_upload` declares personal or group ownership, filename,
   media type, exact byte length, and SHA-256.
2. `append_attachment_chunk` sends base64 chunks of at most 512 KiB at the
   exact next byte offset.
3. `finalize_attachment_upload` verifies length and SHA-256 before atomically
   publishing immutable bytes.

Unfinished uploads expire after 24 hours and are pruned when a new upload
begins. `cancel_attachment_upload` removes one immediately.

`get_attachment`, `list_attachments`, and `read_attachment_chunk` enforce the
current personal owner or group membership before returning metadata or bytes.
`delete_attachment` requires write access, cascades its context links, and
removes content-addressed bytes only when no other attachment metadata uses
them. Missing and unauthorized attachment IDs both return `null`.

`link_attachment_to_context` deliberately permits only exact scope matches:
personal attachment to the same actor's personal context, or group attachment
to a context owned by the same group. Links record `source`, `derived`, or
`reference` relationships, stable sort order, and optional inclusive page
ranges. `list_context_attachments` reads those links through the same attachment
authorization boundary. Original filenames are metadata only; generated UUIDs
and SHA-256 keys determine every filesystem path.

### Wake-policy groundwork

The repository includes a wake-policy evaluator and an optional local handoff
to agent-runtime. It turns a typed event plus a versioned policy into either a
denied decision or a bounded invocation envelope. PCS does not spawn Codex, a
shell, or any other process.

The v1 policy requires explicit allowlists for requesting actors, trigger types,
sources, and optionally channels. It also applies event-age limits, replay
protection, per-target cooldowns, rolling-window rate limits, invocation timeout
metadata, summary/context-ID bounds, and a scalar metadata allowlist. Policy and
event files reject unknown fields. Every decision is appended to a mode-0600
JSONL audit file under an exclusive lock; malformed history fails closed.

Start from [config/wake-policy.example.json](config/wake-policy.example.json)
and [config/wake-event.example.json](config/wake-event.example.json), then run:

```bash
npm run wake-policy:dry-run -- \
  --policy config/wake-policy.example.json \
  --event config/wake-event.example.json \
  --audit data/wake/audit.jsonl \
  --pretty
```

An allowed dry-run decision still includes `"dry_run": true`. To hand an
authorized invocation to agent-runtime, copy the example policy to a protected
path, explicitly set its mode to `"deliver"`, and use
[config/wake-delivery.example.json](config/wake-delivery.example.json):

```bash
npm run wake-policy:run -- \
  --policy /secure/path/wake-policy.json \
  --event config/wake-event.example.json \
  --audit data/wake/audit.jsonl \
  --delivery config/wake-delivery.example.json \
  --pretty
```

Delivery is local-only HTTP over the configured absolute Unix socket. PCS posts
the strict invocation object to `POST /v1/wakes`; it cannot supply a workspace,
prompt template, executable, or command. agent-runtime maps the authorized
target actor and trigger/source to its own fixed local route.

The request uses `Idempotency-Key: <trigger.event_id>`,
`X-Agent-Runtime-Timestamp`, and `X-Agent-Runtime-Signature`. The signature is
`sha256=<lowercase hex HMAC-SHA256>` over the exact bytes
`timestamp + "\n" + idempotency_key + "\n" + raw_json_body`. The shared secret
is read from the absolute mode-restricted credential path; it is never accepted
from a wake event or CLI argument. agent-runtime bounds timestamp skew and
returns 202 for both a newly queued request and an identical duplicate. PCS
retries only transport failures, 408, 425, 429, and 5xx responses. Other 4xx
responses fail closed.

Before sending, PCS writes the exact bounded invocation and SHA-256 digest to a
durable append-only outbox in the audit journal under the same lock as the
authorization decision. Every attempt is appended and synced while holding the
delivery lock. A failed delivery can be retried without re-evaluating a changed
event or policy:

```bash
npm run wake-delivery:retry -- \
  --retry-event 00000000-0000-4000-8000-000000000001 \
  --audit data/wake/audit.jsonl \
  --delivery config/wake-delivery.example.json
```

Once a 202 acceptance is audited, PCS will not resend that outbox entry. The
JSONL journal provides operational accountability but is not a
cryptographically tamper-evident audit ledger.

### Authenticated channels

Channel history uses enrolled Ed25519 actor/device keys rather than
`identify_actor` or caller-supplied actor IDs. The server stores public keys
only. Generate a device keypair, then enroll its public key through the local
administrative workflow:

```bash
npm run actor-key:generate -- --output-prefix /secure/path/codex-desktop
npm run actor-key:enroll -- \
  --actor actor:openai:codex \
  --public-key /secure/path/codex-desktop.public.pem \
  --label codex-desktop
npm run actor-key:revoke -- --key-id ak_<fingerprint-prefix>
```

The actor must already exist with a durable `external_id`. Enrollment is a
trusted local administrative action; there is deliberately no self-service MCP
tool that can claim another actor's identity. Generated `*.private.pem` files
are ignored by Git and must remain readable only by their owning runtime.

Every authenticated tool request includes:

```json
{
  "key_id": "ak_<fingerprint-prefix>",
  "timestamp": "2026-07-25T02:30:00.000Z",
  "nonce": "a-unique-value-at-least-16-characters",
  "signature": "<base64url Ed25519 signature>"
}
```

The signed UTF-8 message is five newline-separated fields:

```text
personal-context-server:v1
<tool-name>
<timestamp>
<nonce>
<canonical-json-of-all-tool-arguments-except-auth>
```

Canonical JSON recursively sorts object keys, preserves array order, omits
properties whose value is undefined, and otherwise uses ordinary JSON scalar
encoding. The implementation exports `buildRequestSigningMessage` so trusted
local clients can construct exactly the same bytes.

Timestamps must be within five minutes of server time. A valid nonce is accepted
only once per key, preventing replay. Revoked keys fail authentication. After
authentication, channel membership separately controls read, write, and
administrative access. Owners and admins manage membership; authors may modify
their own messages, while owners/admins may moderate any channel record.
Missing and unauthorized exact-ID channel records both return `null`.

Remote connector clients that cannot hold or use an Ed25519 key can request an
expiring operator-approved actor session:

For ChatGPT clients routed exclusively through the trusted OpenAI tunnel, set
`TRUST_OPENAI_TUNNEL_IDENTITY=true`. The recommended flow then keeps all bearer
tokens and cryptographic proofs out of the model conversation:

1. Call `request_actor_session(actor_external_id, client_label?)`.
2. Ask the local operator to approve the exact request and expected actor:

   ```bash
   npm run actor-session:approve -- \
     --request-id asr_<id> \
     --actor actor:openai:chatgpt \
     --ttl-seconds 86400
   ```

3. Approval atomically activates the exact OpenAI conversation that created the
   request. No second model-side authentication call is required.
4. Use private channel tools without an `auth` argument. The server recognizes
   the opaque `openai/subject` and `openai/session` values captured from trusted
   MCP request metadata.

The pending request expires after 15 minutes. Its OpenAI identity values are
stored only as domain-separated hashes. Successful local approval performs the
same atomic one-actor/one-timeline handoff as bearer-session claims.

Only enable `TRUST_OPENAI_TUNNEL_IDENTITY` when the server's MCP input is
exclusively controlled by the trusted tunnel process. Direct MCP clients can
construct `_meta` themselves, so this mode is unsafe on an independently
reachable or shared untrusted transport.

Native and non-ChatGPT clients may continue using the lower-level bearer flow:
keep the returned `claim_code` private, call
`claim_actor_session(request_id, claim_code)`, and use the returned capability
in authenticated channel calls:

   ```json
   {
     "session_id": "as_<id>",
     "session_token": "<opaque secret>",
     "timestamp": "2026-07-25T02:30:00.000Z",
     "nonce": "a-new-value-at-least-16-characters"
   }
   ```

Operators may deny or revoke the capability without handling its secret:

```bash
npm run actor-session:deny -- --request-id asr_<id>
npm run actor-session:revoke -- --session-id as_<id>
```

Requesting a session does not authenticate the requester and grants nothing.
Approval is a deliberate local trust decision that checks both request ID and
expected actor ID. The high-entropy claim code prevents another caller that
only learns the request ID from claiming the approved capability. Requests
expire after 15 minutes; approval starts a fresh 15-minute claim window.
Claiming is one-time, and only token hashes are stored. Actor sessions are
bearer capabilities protected by the MCP tunnel transport, limited expiry,
revocation, timestamp checks, and one-use nonces. Ed25519 remains the stronger
choice for runtimes that can sign locally.

Each durable actor has exactly one current actor-session timeline. Creating a
replacement request does not disturb the current session. For trusted OpenAI
requests, local approval completes the handoff; for native bearer requests,
successful claim completes it. The server atomically revokes every prior
session for that `actor_external_id`, records the handoff, and activates the new
session. Older clients then receive `SESSION_REVOKED` instead of silently
continuing on a divergent writable timeline.

Channel records are excluded from all whiteboard tools before search ranking,
pagination, and serialization. They remain plaintext in PostgreSQL and are
protected by the trusted server's authenticated ACLs. End-to-end channel
encryption, MLS epochs, recovery, and secure historical-key distribution remain
explicit later work.

Actor cleanup is deliberate rather than running after every context deletion.
`database_metadata` reports all unreferenced actors and the purgeable subset.
Only anonymous actors with no `external_id`, no referencing contexts, and a
`last_seen_at` older than a chosen cutoff can be removed through
`actor_purge_preview` and `actor_purge_confirm`. Durable actors are never
matched by these tools.

`get_user_profile` returns the OS username plus contexts explicitly tagged
`profile`. It does not perform semantic search, so browsing history cannot enter
the profile merely because it happens to mention the user. Apply the tag to
durable identity, preference, and collaboration-style memories that belong in
the curated profile. Actor still identifies the memory's synthesizer rather
than its subject.

### Optional embedding config

Embedding support is behind an environment toggle. Ollama is the default provider, but
embeddings are disabled unless you explicitly enable them.

```bash
EMBEDDINGS_ENABLED=false
EMBEDDINGS_PROVIDER=ollama
EMBEDDINGS_MODEL=nomic-embed-text
EMBEDDINGS_AUTO_PULL=true
OLLAMA_HOST=http://127.0.0.1:11434
```

When `EMBEDDINGS_ENABLED` is not `true`, context saves and updates skip embedding work.
To enable local embeddings with the defaults, set only:

```bash
EMBEDDINGS_ENABLED=true
```

With `EMBEDDINGS_AUTO_PULL=true`, the server asks Ollama to pull the configured model
on first use if it is missing. First save can take longer while the model downloads.
Set `EMBEDDINGS_AUTO_PULL=false` if you prefer to manage models yourself with
`ollama pull`.

## Roadmap

- [x] Build basic MCP server
- [x] Build and expose basic tools
  - [x] `save_context(text, tags?, source?, visibility?, actor?)`
  - [x] `identify_actor(external_id?, name, kind?, metadata?)`
  - [x] `search_context(query, limit?, sensitivity?, actor_external_id?)`
  - [x] `get_user_profile()`
  - [x] `list_recent_context(limit?)`
  - [x] `get_context(id)`
  - [x] `database_metadata()`
- [x] Build SQL database and connect to exposed tools
- [x] Build and expose `database_metadata` tool that returns db info
- [x] Branch the tool functions from `db.ts` into `tools.ts`
- [x] Add housekeeping tools
  - [x] `database_metadata()`
  - [x] `delete_context(id)`
  - [x] `update_context(id, text?, tags?, source?)`
  - [x] `context_purge_preview(before)`
  - [x] `context_purge_confirm(before, confirmation_token, expected_count)`
  - [x] `actor_purge_preview(before)`
  - [x] `actor_purge_confirm(before, confirmation_token, expected_count)`
  - [x] `vacuum_database()` / maintenance helper
- [ ] Add embedding-based semantic search
  - [x] Add environment toggle and no-op embedding lifecycle hook
  - [x] Generate embeddings for saved contexts with Ollama
  - [x] Store vectors in `embeddings`
  - [x] Search by semantic similarity with text fallback
  - [x] Add low, medium, and high semantic filtering sensitivity
  - [ ] Add more embedding providers

Consider adding confidence scores, async embeddings.

## License

This project is licensed under the [MIT License](LICENSE).

## Available tools

| Tool | Usage | Result |
| --- | --- | --- |
| `ping` | Health check for the MCP server. Takes no arguments. | Text response: `Pong!` |
| `identify_actor` | Resolve or create the active actor for this MCP session. Arguments: `name` (required), `external_id` (optional stable ID), `kind` (optional), and `metadata` (optional object). | JSON text containing `{ "identified": { "actor": actor, "created": boolean } }`. Metadata is stored but not returned. |
| `save_context` | Save a context note. Arguments are `text`, `tags?`, `source?`, `visibility?`, and `actor?`; visibility currently accepts only `whiteboard` and defaults to it. `actor?` requires `external_id` and `name`, with optional `kind` and `metadata`. Include `actor` whenever session continuity is uncertain. Explicit actor identity takes precedence over session state. | JSON text containing `{ "saved": context, "actor_resolution"?: { "created": boolean } }`. The returned context includes `visibility`. Compatibility mode adds actionable guidance when attribution is absent; strict mode rejects before writing and tells the model to retry with `actor`. |
| `search_context` | Search saved context semantically when embeddings are usable, falling back to text only when semantic search is unavailable. Arguments: `query`, `limit?`, `sensitivity?`, and `actor_external_id?`. Actor filtering is applied inside both search paths. | JSON text containing `{ "query", "limit", "sensitivity", "actor_external_id"?, "results" }`. |
| `get_user_profile` | Fetch the curated profile view. Takes no arguments and returns contexts explicitly tagged `profile`; no semantic or text fallback search is used. | JSON text containing `{ "profile": { "username": string, "tag": "profile", "results": context[] } }`. The username is the active OS account. |
| `list_recent_context` | Fetch recent context notes. Arguments: `limit?` and `actor_external_id?`. | JSON text containing `{ "limit", "actor_external_id"?, "results" }`, ordered newest first. |
| `get_context` | Fetch one context note by exact ID. Argument: `id` (required positive integer). | JSON text containing `{ "id": number, "context": context \| null }`, where `context` is the exact stored record or `null` if no record matched. |
| `acknowledge_context` | Idempotently acknowledge an ordinary Whiteboard context. Arguments: `context_id` and optional explicit `actor`; otherwise the current MCP actor session is used. Other visibility classes are not accessible through this tool. | JSON text containing `{ "context_id", "acknowledged", "context" }`. Context records expose deterministic `acknowledged_by` actor entries without actor metadata. |
| `request_actor_session` | Request a pending remote actor session for explicit local approval. Trusted OpenAI requests capture the current opaque conversation binding and omit the native claim code. | `{ "request": { "request_id", "status", ... } }` for OpenAI, or `{ "request": { "request_id", "claim_code", "status", ... } }` for native clients |
| `get_actor_session_request_status` | Check a request using its request ID and secret claim code. | `{ "request": { "status", ... } }` |
| `claim_actor_session` | Claim an approved request once and receive an expiring bearer capability. | `{ "session": { "session_id", "session_token", "expires_at", ... } }` |
| `create_channel` | Create a private channel using an authenticated request. The signing actor becomes owner. | `{ "channel": channel }` |
| `add_channel_member` | Add or restore a durable actor. Requires an authenticated channel owner/admin. | `{ "membership": membership }` |
| `remove_channel_member` | Remove a non-owner actor. Requires an authenticated channel owner/admin. | `{ "membership": { "removed": boolean, ... } }` |
| `list_channels` | List current memberships for the authenticated actor. | `{ "channels": channel[] }` |
| `save_channel_context` | Save channel history using the authenticated actor as attribution. | `{ "saved": context }` |
| `search_channel_context` | Search an authenticated channel membership using the normal sensitivity contract. | `{ "channel", "query", "limit", "sensitivity", "results" }` |
| `list_channel_context` | List recent history from an authenticated channel membership. | `{ "channel", "limit", "results" }` |
| `get_channel_context` | Fetch an exact channel record for an authenticated current member. | `{ "id", "context": context \| null }` |
| `update_channel_context` | Update a channel record as its authenticated author or a channel owner/admin. | `{ "id", "updated": context \| null }` |
| `delete_channel_context` | Delete a channel record as its authenticated author or a channel owner/admin. | `{ "id", "deleted": context \| null }` |
| `create_access_group` | Create an access group. The authenticated actor becomes owner. | `{ "group": group }` |
| `add_access_group_member` | Add or restore a durable actor. Requires an authenticated group owner/admin. | `{ "membership": membership }` |
| `remove_access_group_member` | Remove a non-owner actor. Requires an authenticated group owner/admin. | `{ "membership": { "removed": boolean, ... } }` |
| `list_access_groups` | List current access-group memberships for the authenticated actor. | `{ "groups": group[] }` |
| `save_group_context` | Save a group-owned record while retaining the authenticated actor as author. | `{ "saved": context }` |
| `search_group_context` | Search an authenticated access group's records using the normal sensitivity contract. | `{ "group", "query", "limit", "sensitivity", "results" }` |
| `list_group_context` | List recent records from an authenticated access group. | `{ "group", "limit", "results" }` |
| `get_group_context` | Fetch an exact group-owned record for a current readable member. | `{ "id", "context": context \| null }` |
| `update_group_context` | Update a group-owned record as a current writable member. | `{ "id", "updated": context \| null }` |
| `delete_group_context` | Delete a group-owned record as a current writable member. | `{ "id", "deleted": context \| null }` |
| `save_personal_context` | Save a private notebook record owned by the authenticated actor. | `{ "saved": context }` |
| `search_personal_context` | Search only the authenticated actor's private notebook using the normal sensitivity contract. | `{ "query", "limit", "sensitivity", "results" }` |
| `list_personal_context` | List recent private notebook records owned by the authenticated actor. | `{ "limit", "results" }` |
| `get_personal_context` | Fetch an exact private notebook record owned by the authenticated actor. Missing and unauthorized records both return `null`. | `{ "id", "context": context \| null }` |
| `update_personal_context` | Update a private notebook record owned by the authenticated actor. | `{ "id", "updated": context \| null }` |
| `delete_personal_context` | Delete a private notebook record owned by the authenticated actor. | `{ "id", "deleted": context \| null }` |
| `database_metadata` | Fetch simple database metadata. Takes no arguments. | JSON text containing context and actor counts, total database size, and managed table sizes. |
| `delete_context` | Delete a saved context note. Arguments: `id` (required positive integer). | JSON text containing `{ "id": number, "deleted": context \| null }`, where `deleted` is the removed record or `null` if no record matched. |
| `update_context` | Update a saved whiteboard context note. Arguments: `id` (required positive integer), plus at least one of `text` (optional string), `tags` (optional string array), `source` (optional string), or `visibility` (currently only `whiteboard`). | JSON text containing `{ "id": number, "updated": context \| null }`, where `updated` is the updated record or `null` if no visible record matched. |
| `context_purge_preview` | Preview a deletion of saved context notes before a cutoff. Arguments: `before` (required date or timestamp). | JSON text containing `{ "preview": { "before": string, "matched": number, "oldest": string \| null, "newest": string \| null, "confirmation_token": string, "expires_at": string } }`. |
| `context_purge_confirm` | Delete saved context notes before a cutoff. Arguments: `before` (required date or timestamp), `confirmation_token` (required string from `context_purge_preview`), and `expected_count` (required nonnegative integer from `context_purge_preview`). The real purge only runs shortly after a matching preview, and only if the current match count still equals `expected_count`. | JSON text containing `{ "purge": { "before": string, "expected_count": number, "deleted_count": number, "deleted": context[] } }`. |
| `actor_purge_preview` | Preview old anonymous actors that have no external ID and no referencing contexts. Argument: `before` as a last-seen cutoff. Durable actors are excluded. | JSON text containing the scope, cutoff, matched count, last-seen range, confirmation token, and expiry. |
| `actor_purge_confirm` | Delete exactly the anonymous orphan set from a recent matching preview. Arguments: `before`, `confirmation_token`, and `expected_count`. | JSON text containing `{ "purge": { "scope": "anonymous_unreferenced_actors", "deleted_count": number, "deleted": actor[] } }`. |
| `vacuum_database` | Run PostgreSQL maintenance for the managed tables. Takes no arguments. | JSON text containing metadata before and after vacuuming `contexts`, `embeddings`, and `actors`. |

`database_metadata` returns a shape like this:

```json
{
  "metadata": {
    "context_count": 3,
    "actor_count": 2,
    "orphan_actor_count": 1,
    "purgeable_actor_count": 1,
    "total_size": {
      "bytes": 2147483648,
      "pretty": "2048 MB"
    },
    "tables": {
      "contexts": {
        "bytes": 32768,
        "pretty": "32 kB"
      },
      "embeddings": {
        "bytes": 8192,
        "pretty": "8192 bytes"
      },
      "actors": {
        "bytes": 16384,
        "pretty": "16 kB"
      }
    }
  }
}
```

Context records returned by the tools look like this:

```json
{
  "id": 1,
  "kind": "note",
  "content": "User has been building an MCP server this week.",
  "source": "chat",
  "tags": ["mcp", "project"],
  "actor": {
    "id": 1,
    "external_id": "actor:openai:codex",
    "name": "Codex",
    "kind": "ai",
    "created_at": "2026-07-18T15:00:00.000Z",
    "last_seen_at": "2026-07-18T15:00:00.000Z"
  },
  "created_at": "2026-06-12T15:00:00.000Z",
  "updated_at": "2026-06-12T15:00:00.000Z"
}
```

## Dev references

### File structure

```bash
$ tree --gitignore
.
├── package.json
├── package-lock.json
├── README.md
├── src
│   ├── index.ts
│   ├── embeddings
│   │   ├── config.ts
│   │   ├── index.ts
│   │   └── providers
│   │       └── ollama.ts
│   ├── mcp
│   │   ├── server.ts
│   │   └── tools.ts
│   └── storage
│       └── db.ts
└── tsconfig.json

6 directories, 11 files
```

### SQL structure

```sql
contexts (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'note',
  visibility TEXT NOT NULL DEFAULT 'whiteboard',
  channel_id BIGINT REFERENCES channels(id) ON DELETE RESTRICT,
  group_id BIGINT REFERENCES access_groups(id) ON DELETE RESTRICT,
  content TEXT NOT NULL,
  source TEXT,
  tags TEXT[],
  actor_id BIGINT REFERENCES actors(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
)

access_groups (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  created_by_actor_id BIGINT REFERENCES actors(id),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
)

access_group_memberships (
  group_id BIGINT REFERENCES access_groups(id) ON DELETE CASCADE,
  actor_id BIGINT REFERENCES actors(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  can_read BOOLEAN NOT NULL,
  can_write BOOLEAN NOT NULL,
  joined_at TIMESTAMPTZ NOT NULL,
  removed_at TIMESTAMPTZ,
  PRIMARY KEY (group_id, actor_id)
)

actors (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  external_id TEXT,
  name TEXT NOT NULL,
  kind TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL
)

embeddings (
  context_id BIGINT PRIMARY KEY REFERENCES contexts(id) ON DELETE CASCADE,
  model TEXT,
  vector TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)
```
