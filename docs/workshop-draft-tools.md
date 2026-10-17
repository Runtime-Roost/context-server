# Context Server Workshop draft tools

The conversation MCP surface exposes four tools for the actor already authenticated by the exact OpenAI conversation binding:

- `workshop_list_drafts`
- `workshop_get_draft`
- `workshop_create_draft`
- `workshop_update_draft`

The tools use one configured workspace. They cannot set source Context IDs, publish tasks, assign owners, approve work, or execute work. New tasks are recorded with the authenticated actor as creator, status `draft`, and no owner. Edits are revision-checked and limited to title, description, priority, and acceptance criteria. An assigned draft can still be edited, but the tool cannot change its owner.

## Required service configuration

Configure the Context Server conversation process with:

- `ROOST_WORKSHOP_API_URL=http://127.0.0.1:4340/` (optional; the default is loopback port 4340)
- `ROOST_WORKSHOP_SERVICE_ENV_FILE=/absolute/path/to/workshop-service.env`
- `ROOST_WORKSHOP_DRAFTS_WORKSPACE_ID=<UUID>`

The environment file must be a regular, non-symlink file with mode `0600`, readable by the Context Server service account, and contain exactly one `ROOST_WORKSHOP_SERVICE_TOKEN=...` entry. The service token is read for each call and is never returned through MCP. The upstream URL is restricted to loopback HTTP; redirects are rejected.

## Authorization

The trusted conversation actor is derived from Roost SSO. The SSO policy should grant `actor:openai:chatgpt` only `workshop.drafts.read`, `workshop.drafts.create`, and `workshop.drafts.update` for the `context-server` audience. Workshop independently checks that actor's membership and editor role in the configured workspace. No permission should be assigned to Whiteboard-only actors, Codex, or a wildcard group for this feature.

The Workshop schema must support ownerless drafts before enabling the Context Server tools. Migration `007_unassigned_drafts.sql` allows a null owner only while a task is a draft or cancelled; the state-transition layer also refuses publication until an owner is assigned.

## Rollback note

First remove the ChatGPT draft role and disable the Context Server tool configuration, then restart only the Context Server conversation process. Keep the nullable-owner-aware Workshop build and migration 007 in place if ownerless drafts exist. The previous Workshop build does not correctly handle ownerless rows; returning to it requires first resolving each such draft through the normal owner-assignment workflow. Do not delete or silently assign drafts during rollback.
