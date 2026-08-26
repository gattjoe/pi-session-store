# Pi Session Store

**Mirrors pi coding agent session transcripts to a remote [session-store](https://github.com/gattjoe/pathfinder/tree/main/session-store) server**, so sessions started by `pi` and by `claude-task` agents land in one shared, queryable place instead of living only in `~/.pi/agent/sessions/` on whichever machine ran them.

## Install

```bash
pi install git:github.com/gattjoe/pi-session-store
```

## Configuration

Two environment variables (or their `PI_`-prefixed equivalents, e.g. `PI_SESSION_STORE_TOKEN`):

| Variable | Required | Default |
|---|---|---|
| `SESSION_STORE_TOKEN` | Yes | none — the extension no-ops entirely if unset |
| `SESSION_STORE_URL` | No | `https://sessions.echobase.network` |

Without a token configured, this extension does nothing (no network calls, no errors).

## What it does

On `session_start`/`session_switch` it registers the session with the store (`POST /sessions`). On `turn_end`, `session_switch`, and `session_shutdown` it re-reads the local session JSONL file and ships any entries not yet synced (`POST /sessions/{id}/entries`), reusing pi's own entry `id`/`parentId` so the remote tree matches the local one exactly.

pi's entry `type` vocabulary is richer than session-store's fixed set (`message`, `tool_result`, `compaction`, `branch_summary`, `meta`, `custom`). `message` entries split into `message`/`tool_result` by role; `compaction`, `branch_summary`, and `custom` map straight across; everything else (`custom_message`, `model_change`, `thinking_level_change`, `label`, `session_info`) folds into `meta`, with the original pi `type` preserved in the payload.

## Status line

| Status | Meaning |
|---|---|
| `● synced` | Latest entries accepted by the store |
| `● store <code>` | Store reachable but returned an error status |
| `● store unreachable` | Request failed (network error, timeout, DNS, etc.) |
