[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/I2I57UKJ8)
# opencode-memory-plugin
Persistent, git-backed markdown memory store for OpenCode agents. This tool exists because agents need a version-controlled memory that is human-readable, searchable via standard CLI tools, and portable across project boundaries without requiring a heavy database.

## Configuration

Add to your OpenCode configuration:

```json
{
  "plugin": [
    "@dzackgarza/opencode-memory-plugin@git+https://github.com/dzackgarza/opencode-memory-plugin.git"
  ],
  "permission": {
    "remember": "allow",
    "list_memories": "allow",
    "forget": "allow"
  }
}
```

### MCP Configuration

This plugin also provides a standalone MCP server. Add to any MCP client config:

```json
{
  "mcpServers": {
    "opencode-memory": {
      "command": "uvx",
      "args": [
        "--from", "git+https://github.com/dzackgarza/opencode-memory-plugin#subdirectory=mcp-server",
        "opencode-memory-mcp"
      ]
    }
  }
}
```

## Tools

### `remember`
Use when you need to save a memory to the persistent store.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `content` | `string` | Yes | Memory content (markdown) |
| `project` | `string` | No | `"global"` for cross-project storage. Omit to auto-detect from working directory. |
| `session_id` | `string` | No | Provenance metadata. Defaults to current session ID. |
| `tags` | `string[]` | No | Tags for filtering, e.g. `["deploy", "ops"]` |

#### Example Input
```json
{
  "content": "Production deploy requires manual approval from @ops",
  "tags": ["deploy", "ops"]
}
```

### `list_memories`
Use when you need to query memory metadata using SQL.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sql` | `string` | Yes | SQL SELECT query against the memories table |

**`memories` table schema:**
| Field | Type | Description |
|-------|------|-------------|
| `id` | `TEXT` | Unique memory ID (e.g. `mem_abc123`) |
| `path` | `TEXT` | Absolute path to the .md file |
| `project` | `TEXT` | `"global"` or a git-root slug |
| `session_id` | `TEXT` | Original session provenance |
| `tags` | `TEXT` | JSON array of tags |
| `mtime` | `TEXT` | ISO 8601 timestamp |

#### Example Input
```json
{
  "sql": "SELECT * FROM memories WHERE project = 'global' AND tags LIKE '%deploy%'"
}
```

### `forget`
Use when you need to delete a memory permanently by its ID.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | Yes | Memory ID (e.g. `mem_abc123`) |

#### Example Input
```json
{
  "id": "mem_abc123"
}
```

## CLI

`src/cli.py` is the canonical core logic. It can be used directly for manual inspection or semantic search:

```bash
# Save a memory
uv run src/cli.py remember --content "nginx handles SSL" --project global

# List memories via SQL
uv run src/cli.py list --sql "SELECT * FROM memories WHERE project = 'global'"

# Semantic search (requires semtools)
uv run src/cli.py recall "nginx configuration"
```

## Environment Variables

| Name | Required | Default | Controls |
|------|----------|---------|---------|
| `OPENCODE_MEMORY_ROOT` | No | `~/.local/share/opencode-memory` | Override the memory store root directory |

## Dependencies

The plugin requires these tools to be installed and on `PATH`:

| Tool | Purpose | Install |
|------|---------|---------|
| [`uv`](https://docs.astral.sh/uv/) | Runs the bundled CLI and resolves deps | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| `git` | Memory repo version control | OS package manager |
| [`semtools`](https://github.com/run-llama/semtools) | Local semantic search (optional) | `npm install -g @llamaindex/semtools` |

## Development Setup

For contributors working on the plugin locally:

```bash
direnv allow .
just install
```

## Checks

```bash
direnv allow .
just check
```

For targeted runs, use the canonical `justfile` entrypoints:

```bash
just typecheck
just test
just mcp-test
```

Do not run `bun test`, `bunx tsc`, or `uv run python -m pytest` directly.

## License

MIT
