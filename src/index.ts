import { type Plugin, tool } from "@opencode-ai/plugin";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pkg from "../package.json" assert { type: "json" };

const execFileAsync = promisify(execFile);

const PLUGIN_VERSION = pkg.version;
const BUG_REPORTING_URL =
  "https://github.com/dzackgarza/opencode-postgres-memory-plugin/issues/new?labels=bug";
const DATABASE_URL_ENV = "POSTGRES_MEMORY_DATABASE_URL";
const MEMORY_SEED_ENV = "POSTGRES_MEMORY_TEST_SEED";
const UV_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const POSTGRES_MEMORY_CLI_PATH = fileURLToPath(
  new URL("./postgres_memory_cli.py", import.meta.url),
);
const ISSUE_REPORTING_HINT =
  `If this looks like a plugin/runtime bug, file a GitHub issue tagged \`bug\`: ${BUG_REPORTING_URL}. Include the SQL, redacted database URL, and exact error below.`;

type QueryRowsSuccess = {
  ok: true;
  kind: "rows";
  rowCount: number;
  rows: Array<Record<string, unknown>>;
};

type QueryCommandSuccess = {
  ok: true;
  kind: "command";
  commandTag: string;
};

type QueryFailure = {
  ok: false;
  failureKind: "query_failure";
  code?: string | null;
  detail?: string | null;
  hint?: string | null;
  message: string;
  position?: number | string | null;
  sql: string;
  where?: string | null;
};

type ToolFailure = {
  ok: false;
  databaseUrl: string;
  detail?: string | null;
  failureKind: "tool_failure";
  message: string;
  sql: string;
  stage: string;
};

type QueryExecutionResult =
  | QueryRowsSuccess
  | QueryCommandSuccess
  | QueryFailure
  | ToolFailure;

type DoctorResult =
  | {
      ok: true;
      kind: "doctor";
      checks: Record<string, string>;
      databaseUrl: string;
      message: string;
    }
  | (ToolFailure & { checks?: Record<string, string> });

type BootstrapResult =
  | {
      ok: true;
      kind: "bootstrap";
      message: string;
      databaseUrl: string;
    }
  | ToolFailure;

function buildPassphrase(
  toolName: string,
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const seed = env[MEMORY_SEED_ENV]?.trim() ?? "";
  if (!seed) return "";
  return `${seed}:${toolName}:${path}`;
}

function withPassphrase(
  description: string,
  toolName: string,
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const pass = buildPassphrase(toolName, path, env);
  if (!pass) return description;
  return `${description}\n\nVerification passphrase: ${pass}`;
}

function withPluginVersion(description: string): string {
  return `${description} (Plugin version: ${PLUGIN_VERSION})`;
}

function buildPostgresUrlFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const host = env.PGHOST?.trim();
  const user = env.PGUSER?.trim();
  const database = env.PGDATABASE?.trim();
  if (!host || !user || !database) return undefined;

  const protocol = env.PGSSLMODE?.trim() === "require" ? "postgresqls:" : "postgresql:";
  const url = new URL(`${protocol}//placeholder`);
  url.hostname = host;
  url.username = user;
  url.password = env.PGPASSWORD?.trim() ?? "";
  url.pathname = `/${database}`;

  const port = env.PGPORT?.trim();
  if (port) url.port = port;

  if (env.PGSSLMODE?.trim()) {
    url.searchParams.set("sslmode", env.PGSSLMODE.trim());
  }

  return url.toString();
}

function resolveDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env[DATABASE_URL_ENV]?.trim() || env.DATABASE_URL?.trim();
  if (explicit) return explicit;

  const built = buildPostgresUrlFromEnv(env);
  if (built) return built;

  throw new Error(
    `No PostgreSQL connection details were configured. Set ${DATABASE_URL_ENV}, DATABASE_URL, or the standard PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE variables.`,
  );
}

function redactDatabaseUrl(databaseUrl: string): string {
  if (!databaseUrl) return "";

  try {
    const url = new URL(databaseUrl);
    if (url.password) url.password = "***";
    return url.toString();
  } catch {
    return databaseUrl;
  }
}

function buildToolFailure(
  stage: string,
  message: string,
  sql: string,
  databaseUrl: string,
  detail?: string,
): ToolFailure {
  return {
    ok: false,
    failureKind: "tool_failure",
    stage,
    message,
    detail,
    sql,
    databaseUrl: redactDatabaseUrl(databaseUrl),
  };
}

function parseRunnerResult<T>(raw: string | undefined): T | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return undefined;
  }
}

function extractExecErrorDetail(error: unknown): {
  detail: string;
  stdout?: string;
  stderr?: string;
} {
  if (typeof error !== "object" || error === null) {
    return { detail: String(error) };
  }

  const message =
    "message" in error && typeof error.message === "string"
      ? error.message
      : String(error);
  const stdout =
    "stdout" in error && typeof error.stdout === "string" ? error.stdout : undefined;
  const stderr =
    "stderr" in error && typeof error.stderr === "string" ? error.stderr : undefined;

  return { detail: message, stdout, stderr };
}

async function runCliJson<T>(
  args: string[],
  contextForFailure: {
    fallbackFailureStage: string;
    fallbackMessage: string;
    sql: string;
    databaseUrl: string;
  },
  env: NodeJS.ProcessEnv = process.env,
): Promise<ToolFailure | T> {
  const command = [
    "run",
    "--script",
    POSTGRES_MEMORY_CLI_PATH,
    ...args,
    "--output",
    "json",
  ];

  try {
    const { stdout } = await execFileAsync("uv", command, {
      env,
      maxBuffer: UV_MAX_BUFFER_BYTES,
    });

    const parsed = parseRunnerResult<T | ToolFailure>(stdout);
    if (parsed) return parsed;
    return buildToolFailure(
      "runner_output",
      "The Postgres memory CLI returned a non-JSON payload.",
      contextForFailure.sql,
      contextForFailure.databaseUrl,
      stdout.trim(),
    );
  } catch (error) {
    const { detail, stdout, stderr } = extractExecErrorDetail(error);
    const parsed = parseRunnerResult<T | ToolFailure>(stdout);
    if (parsed) return parsed;

    return buildToolFailure(
      contextForFailure.fallbackFailureStage,
      contextForFailure.fallbackMessage,
      contextForFailure.sql,
      contextForFailure.databaseUrl,
      [detail, stderr].filter(Boolean).join("\n"),
    );
  }
}

async function runPostgresQuery(
  sql: string,
  databaseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<QueryExecutionResult> {
  const result = await runCliJson<QueryExecutionResult>(
    ["query", "--sql", sql, "--database-url", databaseUrl],
    {
      fallbackFailureStage: "runner_process",
      fallbackMessage: "The Postgres memory CLI exited before returning a result.",
      sql,
      databaseUrl,
    },
    env,
  );

  return result;
}

async function runBootstrap(
  databaseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<BootstrapResult> {
  const result = await runCliJson<BootstrapResult>(
    ["bootstrap", "--database-url", databaseUrl],
    {
      fallbackFailureStage: "runner_process",
      fallbackMessage: "The Postgres memory CLI exited before bootstrap completed.",
      sql: "-- bootstrap --",
      databaseUrl,
    },
    env,
  );

  return result;
}

async function runDoctor(
  databaseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DoctorResult> {
  const result = await runCliJson<DoctorResult>(
    ["doctor", "--database-url", databaseUrl],
    {
      fallbackFailureStage: "runner_process",
      fallbackMessage: "The Postgres memory CLI exited before doctor completed.",
      sql: "-- doctor --",
      databaseUrl,
    },
    env,
  );

  return result;
}

function formatQueryResult(result: QueryExecutionResult): string {
  if (result.ok) {
    return result.kind === "rows"
      ? JSON.stringify(result.rows, null, 2)
      : result.commandTag;
  }

  if (result.failureKind === "query_failure") {
    return [
      "QUERY FAILURE",
      `message: ${result.message}`,
      result.code ? `sqlstate: ${result.code}` : undefined,
      result.detail ? `detail: ${result.detail}` : undefined,
      result.hint ? `hint: ${result.hint}` : undefined,
      result.position ? `position: ${result.position}` : undefined,
      result.where ? `where: ${result.where}` : undefined,
      `sql: ${result.sql}`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  return [
    "TOOL FAILURE",
    `stage: ${result.stage}`,
    `message: ${result.message}`,
    result.detail ? `detail: ${result.detail}` : undefined,
    `database_url: ${result.databaseUrl}`,
    `sql: ${result.sql}`,
    `bug_report: ${BUG_REPORTING_URL}`,
    ISSUE_REPORTING_HINT,
  ]
    .filter(Boolean)
    .join("\n");
}

export const postgresMemoryTesting = {
  BUG_REPORTING_URL,
  CLI_PATH: POSTGRES_MEMORY_CLI_PATH,
  buildPassphrase,
  formatQueryResult,
  redactDatabaseUrl,
  resolveDatabaseUrl,
  runBootstrap,
  runDoctor,
  runPostgresQuery,
};

export const PostgresMemoryPlugin: Plugin = async ({ project }) => {
  const projectName = project.id;

  return {
    tool: {
      query_memories: tool({
        description: withPassphrase(
          withPluginVersion(`Use when you need to run SQL against the Postgres memory store.

This plugin is a thin adapter over the standalone CLI at src/postgres_memory_cli.py.
Canonical table: memories (bootstrapped by the CLI when needed).

Example write:
  INSERT INTO memories (scope, session_id, project_name, content, metadata)
  VALUES ('session', 'session-alpha', '${projectName}', '# Deploy notes', '{"topic":"ops"}');

Example semantic search:
  SELECT content, metadata
  FROM memories
  WHERE project_name = '${projectName}' AND scope = 'session' AND session_id = 'session-alpha' AND embedding IS NOT NULL
  ORDER BY embedding <-> '[0.1,0.2,0.3]'::vector
  LIMIT 5;`),
          "query_memories",
          "visible",
        ),
        args: {
          sql: tool.schema.string().describe(
            "The SQL query to execute against the configured PostgreSQL memory database.",
          ),
        },
        async execute(args, context) {
          await context.ask({
            permission: "query_memories",
            patterns: [args.sql],
            always: ["*"],
            metadata: { sql: args.sql },
          });

          let databaseUrl = "";
          try {
            databaseUrl = resolveDatabaseUrl(process.env);
          } catch (error) {
            return withPassphrase(
              formatQueryResult(
                buildToolFailure(
                  "configuration",
                  error instanceof Error ? error.message : String(error),
                  args.sql,
                  "",
                ),
              ),
              "query_memories",
              "execute",
            );
          }

          const result = await runPostgresQuery(args.sql, databaseUrl);
          context.metadata({
            title: "Postgres memory query",
            metadata: {
              cliPath: POSTGRES_MEMORY_CLI_PATH,
              databaseUrl: redactDatabaseUrl(databaseUrl),
              projectName,
              resultKind: result.ok ? result.kind : result.failureKind,
            },
          });

          return withPassphrase(
            formatQueryResult(result),
            "query_memories",
            "execute",
          );
        },
      }),
    },
  };
};
