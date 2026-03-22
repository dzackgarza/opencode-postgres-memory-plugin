[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/I2I57UKJ8)
# opencode-memory-plugin

Persistent file-backed memory tools for OpenCode.

This package is a thin OpenCode wrapper around the `memory-manager` CLI surface. The
plugin-owned tool contract is limited to:

- `remember`
- `list_memories`
- `forget`

Manager-only commands such as `recall`, `list-files`, and `doctor` are not exposed as
OpenCode plugin tools from this repo.

## Configuration

Add the plugin and allow only the wrapper-owned tools:

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

### MCP Server

This repo also ships a standalone MCP server entrypoint:

```json
{
  "mcpServers": {
    "opencode-memory": {
      "command": "uvx",
      "args": [
        "--from",
        "git+https://github.com/dzackgarza/opencode-memory-plugin#subdirectory=mcp-server",
        "opencode-memory-mcp"
      ]
    }
  }
}
```

## Tools

### `remember`

Write a new memory into the file-backed store.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `content` | `string` | Yes | Memory content as markdown text |
| `project` | `string` | No | Use `"global"` to force global storage. Omit to auto-detect from the current working directory. |
| `session_id` | `string` | No | Provenance session ID. Defaults to the current OpenCode session. |
| `tags` | `string[]` | No | Tags for filtering, for example `["deploy", "ops"]` |

Example:

```json
{
  "content": "Production deploy requires manual approval from @ops",
  "tags": ["deploy", "ops"]
}
```

### `list_memories`

Query memory metadata through SQL against the manager-owned index.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sql` | `string` | Yes | SQL `SELECT` query against the `memories` table |

`memories` table columns:

| Field | Type | Description |
|-------|------|-------------|
| `id` | `TEXT` | Memory ID such as `mem_abc123` |
| `path` | `TEXT` | Absolute path to the markdown file |
| `project` | `TEXT` | Project slug or `"global"` |
| `session_id` | `TEXT` | Stored provenance session ID |
| `tags` | `TEXT` | JSON array of tags |
| `mtime` | `TEXT` | ISO 8601 modification time |

Example:

```json
{
  "sql": "SELECT id, path FROM memories WHERE project = 'global' ORDER BY mtime DESC LIMIT 5"
}
```

### `forget`

Delete a memory permanently by ID.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | Yes | Memory ID such as `mem_abc123` |

Example:

```json
{
  "id": "mem_abc123"
}
```

## Wrapper Boundary

The plugin delegates to the underlying `memory-manager` CLI via `uvx`. The wrapper does
not own the manager CLI command set; it owns only the three OpenCode tools above plus
their result formatting and permission contract.

If you need to point the plugin at a local manager checkout during proof or refactor
work, set `MEMORY_MANAGER_CLI_SPEC` to a local path or alternate package spec.

## Environment Variables

| Name | Required | Default | Controls |
|------|----------|---------|---------|
| `OPENCODE_MEMORY_ROOT` | No | `~/.local/share/opencode-memory` | Root directory for the memory store |
| `MEMORY_MANAGER_CLI_SPEC` | No | `git+https://github.com/dzackgarza/memory-manager.git` | Alternate manager package or local checkout for wrapper execution |
| `OPENCODE_MEMORY_TEST_SEED` | No | — | Test-only verification passphrase seed |

## Dependencies

| Tool | Purpose |
|------|---------|
| `bun` | Plugin runtime and TypeScript tooling |
| `uv` | Runs the delegated Python manager and MCP tests |
| `git` | Version-controls the memory store |

## Development

```bash
direnv allow .
just install
```

## Checks

```bash
direnv allow .
just check
```

Targeted entrypoints:

```bash
just typecheck
just test
just mcp-test
```

Use the `justfile` entrypoints instead of ad hoc `bun test`, `bunx tsc`, or direct
`uv run python -m pytest` calls.

## License

MIT
