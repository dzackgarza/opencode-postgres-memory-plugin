# opencode-memory-mcp

FastMCP wrapper for `opencode-file-memory`. This server provides persistent, git-backed markdown memories to any MCP client.

## Installation

### Remote

```bash
uvx --from git+https://github.com/dzackgarza/opencode-memory-plugin#subdirectory=mcp-server opencode-memory-mcp
```

### Local

```bash
cd mcp-server
uv run opencode-memory-mcp
```

## Tools

- `remember`: Save a memory (markdown) to the store.
- `list_memories`: Query memory metadata via SQL SELECT.
- `forget`: Delete a memory by its ID.

## Architecture

This is a thin FastMCP wrapper that delegates all operations to the canonical `src/cli.py` in the parent repository. This ensures consistent behavior between the OpenCode plugin and the MCP server.
