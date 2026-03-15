[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/I2I57UKJ8)

# Postgres Memory Plugin

Postgres-backed memory store for OpenCode, implemented CLI-first:

- standalone Typer CLI is the canonical product surface
- OpenCode plugin is a thin adapter that delegates to the CLI
- canonical table is `memories`

## CLI First

Run help:

```bash
uv run --script src/postgres_memory_cli.py --help
```

### Commands

Show environment and schema diagnostics:

```bash
uv run --script src/postgres_memory_cli.py doctor
```

Bootstrap extension, schema, and indexes:

```bash
uv run --script src/postgres_memory_cli.py bootstrap
```

Run a SQL query against the memory database:

```bash
uv run --script src/postgres_memory_cli.py query --sql "SELECT now()"
```

Return machine-readable output:

```bash
uv run --script src/postgres_memory_cli.py query --sql "SELECT 1 AS ok" --output json
```

## Configuration

The CLI and plugin resolve database settings in this order:

- `POSTGRES_MEMORY_DATABASE_URL`
- `DATABASE_URL`
- `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`

Example:

```bash
export POSTGRES_MEMORY_DATABASE_URL='postgresql://postgres:password@127.0.0.1:5432/opencode_memories'
```

`pgvector` must be available on the target PostgreSQL server.

For repo-local verification, use the tracked [`.envrc`](/home/dzack/.worktrees/opencode-plugins-clean/opencode-postgres-memory-plugin/repo/.envrc) and put real database URLs in an ignored `.env` file.

## OpenCode Plugin Registration

Register the plugin in OpenCode after validating the CLI:

```json
{
  "plugin": [
    "@dzackgarza/opencode-postgres-memory-plugin@git+https://github.com/dzackgarza/opencode-postgres-memory-plugin.git"
  ],
  "permission": {
    "query_memories": "allow"
  }
}
```

The plugin exposes one tool, `query_memories`, and delegates execution to the same CLI implementation used above.

## Canonical Schema

```sql
CREATE TABLE memories (
  id BIGSERIAL PRIMARY KEY,
  scope TEXT NOT NULL,
  session_id TEXT,
  content TEXT NOT NULL,
  embedding VECTOR(1536),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  project_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

Conventions:

- session memories: `scope = 'session'` and `session_id` is non-null
- global memories: `scope = 'global'` and `session_id IS NULL`

## Examples

Insert a session memory:

```sql
INSERT INTO memories (scope, session_id, project_name, content, metadata)
VALUES (
  'session',
  'session-alpha',
  'my-project',
  '# Deploy notes',
  '{"topic":"ops"}'
);
```

Run semantic search:

```sql
SELECT content, metadata
FROM memories
WHERE project_name = 'my-project'
  AND scope = 'session'
  AND session_id = 'session-alpha'
  AND embedding IS NOT NULL
ORDER BY embedding <-> '[0.1,0.2,0.3]'::vector
LIMIT 5;
```

## Failure Classes

- `QUERY FAILURE`: SQL execution failed
- `TOOL FAILURE`: configuration, connectivity, bootstrap, or runtime failure

## Development

```bash
just install
just cli-help
just typecheck
just test
just check
```
