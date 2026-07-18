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
and `EMBEDDINGS_ENABLED` environment variables override the generated defaults.
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
  - [x] `save_context(text, tags?, source?)`
  - [x] `search_context(query, limit?, sensitivity?)`
  - [x] `get_user_profile()`
  - [x] `list_recent_context(limit?)`
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
| `save_context` | Save a new personal context note. Arguments: `text` (required string), `tags` (optional string array), `source` (optional string). | JSON text containing `{ "saved": context }`, where `context` is the saved record. |
| `search_context` | Search saved context by semantic similarity when embeddings are enabled and usable, falling back to text search only when semantic search is unavailable. Arguments: `query` (required string), `limit` (optional positive integer, defaults to `20`, capped at `100`), and `sensitivity` (optional `low`, `medium`, or `high`; defaults to `low`). Low is broad, medium is balanced, and high filters aggressively and may return no results. Text fallback searches content, source, and tags and is not filtered by sensitivity. | JSON text containing `{ "query": string, "limit": number, "sensitivity": string, "results": context[] }`. Semantic results are ordered by similarity; fallback text results are ordered newest first. |
| `get_user_profile` | Fetch a broad profile-oriented context view. Takes no arguments and runs the query `me` with medium sensitivity. | JSON text containing `{ "profile": { "username": string, "query": "me", "sensitivity": "medium", "results": context[] } }`. The username is the active OS account. |
| `list_recent_context` | Fetch recently saved context notes. Arguments: `limit` (optional positive integer, defaults to `20`, capped at `100`). | JSON text containing `{ "limit": number, "results": context[] }`, ordered newest first. |
| `database_metadata` | Fetch simple database metadata. Takes no arguments. | JSON text containing row count, total database size, and table sizes for `contexts` and `embeddings`. |
| `delete_context` | Delete a saved context note. Arguments: `id` (required positive integer). | JSON text containing `{ "id": number, "deleted": context \| null }`, where `deleted` is the removed record or `null` if no record matched. |
| `update_context` | Update a saved context note. Arguments: `id` (required positive integer), plus at least one of `text` (optional string), `tags` (optional string array), or `source` (optional string). | JSON text containing `{ "id": number, "updated": context \| null }`, where `updated` is the updated record or `null` if no record matched. |
| `context_purge_preview` | Preview a deletion of saved context notes before a cutoff. Arguments: `before` (required date or timestamp). | JSON text containing `{ "preview": { "before": string, "matched": number, "oldest": string \| null, "newest": string \| null, "confirmation_token": string, "expires_at": string } }`. |
| `context_purge_confirm` | Delete saved context notes before a cutoff. Arguments: `before` (required date or timestamp), `confirmation_token` (required string from `context_purge_preview`), and `expected_count` (required nonnegative integer from `context_purge_preview`). The real purge only runs shortly after a matching preview, and only if the current match count still equals `expected_count`. | JSON text containing `{ "purge": { "before": string, "expected_count": number, "deleted_count": number, "deleted": context[] } }`. |
| `vacuum_database` | Run PostgreSQL maintenance for the managed tables. Takes no arguments. | JSON text containing `{ "vacuum": { "tables": ["contexts", "embeddings"], "before": metadata, "after": metadata } }`. |

`database_metadata` returns a shape like this:

```json
{
  "metadata": {
    "context_count": 3,
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
  content TEXT NOT NULL,
  source TEXT,
  tags TEXT[],
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
)

embeddings (
  context_id BIGINT PRIMARY KEY REFERENCES contexts(id) ON DELETE CASCADE,
  model TEXT,
  vector TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)
```
