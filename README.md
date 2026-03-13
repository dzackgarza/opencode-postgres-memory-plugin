[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/I2I57UKJ8)

# Postgres Memory Plugin

OpenCode plugin that exposes a simple Postgres-backed memory store through one raw SQL tool, `query_memories`.

The design is intentionally thin:

- the interface is standard PostgreSQL syntax
- semantic search uses `pgvector`
- embeddings are expected to be managed by your database-side pipeline
- one canonical table, `memories`, is the source of truth

This fits setups such as a standard PostgreSQL server with `pgvector` plus an automatic embedding pipeline like Supabase automatic embeddings.

## Features

- Exposes a single `query_memories` tool accepting raw SQL against a `memories` table
- Delegates all embedding and semantic indexing to the database layer (no in-process ML)
- Connects to any PostgreSQL-compatible server via `DATABASE_URL`
- Compatible with `pgvector` for vector similarity queries

## Install

Register the plugin in OpenCode:

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

## Configuration

Point the plugin at a real PostgreSQL database with one of:

- `POSTGRES_MEMORY_DATABASE_URL`
- `DATABASE_URL`
- standard `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`

Example:

```bash
export POSTGRES_MEMORY_DATABASE_URL='postgresql://postgres:password@127.0.0.1:5432/opencode-memories'
```

For repo-local verification, the package `.envrc` exports `OPENCODE_CONFIG`,
`OPENCODE_CONFIG_DIR`, and the Postgres test database URLs so the checked-in
`.config/plugins/` shim is the runtime source of the plugin under test.

The database must have the `vector` extension available.

## Tool: `query_memories`

Executes a raw SQL query against the configured PostgreSQL memory database.

#### Input

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sql` | `string` | Yes | Any valid PostgreSQL statement |

#### Example Input

```json
{ "sql": "SELECT content FROM memories WHERE project_name = 'my-project' LIMIT 5" }
```

#### Example Output

```
content
-----------
# Deploy notes
The production hostname is api.internal.example
```

Errors are returned as strings prefixed with `QUERY FAILURE:` or `TOOL FAILURE:`.

## Database Schema

Canonical table: `memories`

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

- session memories use `scope = 'session'` and a non-null `session_id`
- global memories use `scope = 'global'` and `session_id IS NULL`

The plugin bootstraps this schema and creates the supporting indexes it needs, including an `hnsw` index on `embedding`.

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

Insert a global memory:

```sql
INSERT INTO memories (scope, session_id, project_name, content, metadata)
VALUES (
  'global',
  NULL,
  'my-project',
  'The production hostname is api.internal.example',
  '{"topic":"infrastructure"}'
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

## Errors

The tool returns two distinct failure classes:

- `QUERY FAILURE`: your SQL was invalid or failed at the query layer
- `TOOL FAILURE`: configuration, connection, extension bootstrap, or schema bootstrap failed

This is meant to make it obvious whether the agent wrote bad SQL or the plugin/database environment is misconfigured.

## Side Effects

- Connects to the configured PostgreSQL database on every tool invocation.
- On first connection, bootstraps the `memories` table and `hnsw` index if they do not exist.
- All writes are permanent; there is no TTL or automatic eviction.

## External Dependencies

- [PostgreSQL](https://www.postgresql.org/) ≥ 14
- [pgvector](https://github.com/pgvector/pgvector) extension (`CREATE EXTENSION IF NOT EXISTS vector`)

## Development

```bash
just install
just test
just check
```

Run only this plugin's integration suite:

```bash
bun test tests/integration/postgres-memory-plugin.test.ts
```
