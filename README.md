
# Postgres Memory Plugin

Persistent, vector-enabled memory store for OpenCode agents, backed by PostgreSQL. Encodes and filters memories by project name.

## Features

- **Project Scoping**: All memories are encoded with a `project_name` and indexed for fast retrieval within specific project contexts.
- **Vector Search**: Native vector support for semantic similarity search using the `embed()` SQL helper.
- **Conversational Persistence**: Agents can store facts in one turn and retrieve them in subsequent turns or sessions.
- **Isolated Storage**: Defaults to storing the database in the project's worktree (`.postgres_memory/`).

## Installation

Register the plugin in your OpenCode configuration:

```json
{
  "plugin": [
    "file:///path/to/opencode-postgres-memory-plugin/src/index.ts"
  ]
}
```

## Schema

| Column | Type | Description |
|--------|------|-------------|
| `id` | `SERIAL` | Primary Key |
| `content` | `TEXT` | The memory content |
| `embedding` | `vector(1536)` | Vector representation for semantic search |
| `metadata` | `JSONB` | Additional context (tags, topics, etc.) |
| `project_name` | `TEXT` | Canonical name of the project (indexed) |
| `created_at` | `TIMESTAMP` | Record timestamp |

## Usage Examples

### Semantic Search

```sql
SELECT content, metadata FROM memories 
WHERE project_name = 'my-project'
ORDER BY embedding <=> embed('How do I install the plugin?') 
LIMIT 5;
```

### Storing a Memory

```sql
INSERT INTO memories (content, embedding, metadata, project_name) 
VALUES (
  'The server uses port 4096 by default.', 
  embed('The server uses port 4096 by default.'), 
  '{"topic":"config"}', 
  'my-project'
);
```

## Environment Variables

- `POSTGRES_MEMORY_DB_DIR`: Overrides the default database storage path.
- `POSTGRES_MEMORY_TEST_SEED`: Used in tests to enable embedding mocking and passphrase verification.

## Development

Run integration tests:

```bash
bun test tests/integration/postgres-memory-plugin.test.ts
```
