import { type Plugin, tool } from "@opencode-ai/plugin";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

const MEMORY_SEED_ENV = "POSTGRES_MEMORY_TEST_SEED";

function buildPassphrase(toolName: string, path: string): string {
  const seed = process.env[MEMORY_SEED_ENV]?.trim() ?? "";
  if (!seed) return "";
  return `${seed}:${toolName}:${path}`;
}

function withPassphrase(description: string, toolName: string, path: string): string {
  const pass = buildPassphrase(toolName, path);
  if (!pass) return description;
  return `${description}\n\nVerification passphrase: ${pass}`;
}

// Helper to run Postgres queries via a portable pgserver instance
async function runPostgresQuery(sql: string, dbDir: string): Promise<string> {
  const pythonScript = `
import asyncio
import pgserver
import asyncpg
import json
import sys
import re
import os
import httpx

async def get_embedding(text):
    # Try multiple keys in order of preference
    api_key = os.environ.get("OPENROUTER_API_KEY") or os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise ValueError("No API key found for embeddings (tried OPENROUTER_API_KEY, OPENAI_API_KEY).")
        
    async with httpx.AsyncClient() as client:
        # Use OpenRouter as the default bridge
        response = await client.post(
            "https://openrouter.ai/api/v1/embeddings",
            headers={"Authorization": f"Bearer {api_key}"},
            json={
                "model": "openai/text-embedding-3-small",
                "input": text
            },
            timeout=30.0
        )
        response.raise_for_status()
        return response.json()["data"][0]["embedding"]

async def main():
    try:
        # 1. Pre-process SQL to handle embed('text') helpers
        sql_input = """${sql.replace(/\\/g, "\\\\").replace(/"/g, '\\"') }"""
        
        # Simple extraction of embed('...') and embed("...")
        # We find all matches to replace them one by one.
        embed_calls = []
        embed_calls.extend([(m, "'") for m in re.findall(r"embed\\('([^']*)'\\)", sql_input)])
        embed_calls.extend([(m, '"') for m in re.findall(r'embed\\("([^"]*)"\\)', sql_input)])
        
        for text, quote in embed_calls:
            try:
                if os.environ.get("POSTGRES_MEMORY_TEST_SEED"):
                    # Mock embedding for tests: a dummy 1536-dim vector
                    vec = [0.1] * 1536
                else:
                    vec = await get_embedding(text)
                # Replace the entire embed('...') or embed("...") call
                placeholder = f"embed({quote}{text}{quote})"
                sql_input = sql_input.replace(placeholder, f"'{json.dumps(vec)}'")
            except Exception as e:
                print(f"EMBEDDING_ERROR: {e}", file=sys.stderr)
                sys.exit(1)

        # 2. Database connection
        s = pgserver.get_server("${dbDir}")
        conn = await asyncpg.connect(s.get_uri())
        
        # 3. Ensure schema
        await conn.execute('CREATE EXTENSION IF NOT EXISTS vector')
        await conn.execute('''
            CREATE TABLE IF NOT EXISTS memories (
                id SERIAL PRIMARY KEY,
                content TEXT NOT NULL,
                embedding vector(1536),
                metadata JSONB DEFAULT '{}'::jsonb,
                project_name TEXT,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            )
        ''')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_memories_project_name ON memories (project_name)')
        
        # 4. Execute query
        sql_stripped = sql_input.strip()
        if sql_stripped.upper().startswith("SELECT"):
            rows = await conn.fetch(sql_stripped)
            # Use default=str to handle Decimals, Timestamps, etc.
            print(json.dumps([dict(r) for r in rows], default=str))
        else:
            res = await conn.execute(sql_stripped)
            print(res)
            
    except Exception as e:
        import traceback
        traceback.print_exc()
        sys.exit(1)

asyncio.run(main())
`;

  const { stdout, stderr } = await execFileAsync("uv", [
    "run",
    "--no-project",
    "--python", "3.12",
    "--with", "pgserver",
    "--with", "asyncpg",
    "--with", "httpx",
    "python3", "-c", pythonScript
  ], {
    env: { ...process.env }
  });

  if (stderr && (stderr.toLowerCase().includes("error") || stderr.toLowerCase().includes("traceback"))) {
    throw new Error(stderr.trim());
  }

  return stdout.trim();
}

export const PostgresMemoryPlugin: Plugin = async ({ client, project }) => {
  const dbDir = process.env.POSTGRES_MEMORY_DB_DIR || join(import.meta.dir, "..", ".postgres_memory");
  const projectName = project.id;

  return {
    tool: {
      query_memories: tool({
        description: withPassphrase(
          `Use when you need to query the project's persistent vector-enabled memory store.
Schema:
  - id (SERIAL PRIMARY KEY)
  - content (TEXT NOT NULL)
  - embedding (vector(1536))
  - metadata (JSONB)
  - project_name (TEXT)
  - created_at (TIMESTAMP)

Special SQL Helper:
  - embed('your text here'): Automatically replaces this call with a 1536-dim vector generated from the text.

Semantic Search Example:
  SELECT content, metadata FROM memories 
  WHERE project_name = '${projectName}'
  ORDER BY embedding <=> embed('How do I install the plugin?') 
  LIMIT 5;

Populate Memory Example:
  INSERT INTO memories (content, embedding, metadata, project_name) 
  VALUES ('The server uses port 4096 by default.', embed('The server uses port 4096 by default.'), '{"topic":"config"}', '${projectName}');`,
          "query_memories",
          "visible"
        ),
        args: {
          sql: tool.schema.string().describe("The SQL query to execute. You can use the embed('text') helper for vectors."),
        },
        async execute(args, context) {
          await context.ask({
            permission: "query_memories",
            patterns: [args.sql],
            always: ["*"],
            metadata: { sql: args.sql },
          });

          try {
            const result = await runPostgresQuery(args.sql, dbDir);
            const pass = buildPassphrase("query_memories", "execute");
            return pass ? `${result}\n\nPassphrase: ${pass}` : result;
          } catch (error) {
            const pass = buildPassphrase("query_memories", "execute");
            const result = `Error: ${String(error)}`;
            return pass ? `${result}\n\nPassphrase: ${pass}` : result;
          }
        },
      }),
    },
  };
};
