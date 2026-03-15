import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { postgresMemoryTesting } from "../../src/index.ts";

const OPENCODE = process.env.OPENCODE_BIN || "opencode";
const TOOL_DIR = process.cwd();
const OPENCODE_CONFIG_PATH = join(TOOL_DIR, ".config", "opencode.json");
const HOST = "127.0.0.1";
const MANAGER_PACKAGE =
  "git+https://github.com/dzackgarza/opencode-manager.git";
const MAX_BUFFER = 8 * 1024 * 1024;
const SERVER_START_TIMEOUT_MS = 60_000;
const SESSION_TIMEOUT_MS = 240_000;
const PRIMARY_AGENT_NAME = "plugin-proof";
const SEED = "POSTGRES-MEM-99";
const TEST_ADMIN_DATABASE_URL_ENV = "POSTGRES_MEMORY_TEST_ADMIN_URL";

type QueryExecutionResult = Awaited<
  ReturnType<typeof postgresMemoryTesting.runPostgresQuery>
>;

type ToolUseEvent = {
  tool: string;
  inputText?: string;
  outputText?: string;
  status?: string;
};

type TranscriptAssistantMessage = {
  steps?: ToolUseEvent[];
};

type TranscriptTurn = {
  assistantMessages?: TranscriptAssistantMessage[];
};

type TranscriptDocument = {
  turns?: TranscriptTurn[];
};

type ServerHarness = {
  baseUrl: string;
  configPath: string;
  databaseName: string;
  databaseUrl: string;
  logs: () => string;
  process: ChildProcess;
  xdgRoot: string;
};

type DatabaseTarget = {
  adminUrl: string;
  databaseName: string;
  databaseUrl: string;
};

const tempPaths = new Set<string>();
const tempDatabaseTargets: DatabaseTarget[] = [];
let normalHarness: ServerHarness | undefined;
let brokenHarness: ServerHarness | undefined;

function registerTempPath(path: string): string {
  tempPaths.add(path);
  return path;
}

function randomSuffix(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function buildVectorLiteral(first: number, second: number): string {
  const values = Array.from({ length: 1536 }, (_, index) => {
    if (index === 0) return first;
    if (index === 1) return second;
    return 0;
  });
  return `'[${values.join(",")}]'::vector`;
}

function expectRows(
  result: QueryExecutionResult,
  expectedRows: Array<Record<string, unknown>>,
) {
  if (!result.ok || result.kind !== "rows") {
    throw new Error(`Expected row result, received ${JSON.stringify(result)}`);
  }
  expect(result.rowCount).toBe(expectedRows.length);
  expect(result.rows).toEqual(expectedRows);
}

function expectCommand(result: QueryExecutionResult, expectedTag: string) {
  if (!result.ok || result.kind !== "command") {
    throw new Error(`Expected command result, received ${JSON.stringify(result)}`);
  }
  expect(result.commandTag).toBe(expectedTag);
}

function expectFailure(result: QueryExecutionResult) {
  if (result.ok) {
    throw new Error(`Expected failure result, received ${JSON.stringify(result)}`);
  }
  return result;
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate a TCP port."));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

function buildDatabaseUrl(baseUrl: string, databaseName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function resolveAdminDatabaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = env[TEST_ADMIN_DATABASE_URL_ENV]?.trim();
  if (explicit) return explicit;

  const base = env.POSTGRES_MEMORY_DATABASE_URL?.trim() || env.DATABASE_URL?.trim();
  if (base) {
    return buildDatabaseUrl(base, "postgres");
  }

  return buildDatabaseUrl(
    postgresMemoryTesting.resolveDatabaseUrl({
      ...env,
      PGDATABASE: env.PGDATABASE?.trim() || "postgres",
    } as NodeJS.ProcessEnv),
    "postgres",
  );
}

function parseDatabaseUrl(databaseUrl: string) {
  const url = new URL(databaseUrl);
  return {
    host: url.hostname,
    port: url.port || "5432",
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ""),
  };
}

function runAdminCommand(
  adminUrl: string,
  sql: string,
  database = "postgres",
): string {
  const target = parseDatabaseUrl(adminUrl);
  const result = spawnSync(
    "psql",
    [
      "-h",
      target.host,
      "-p",
      target.port,
      "-U",
      target.user,
      "-d",
      database,
      "-v",
      "ON_ERROR_STOP=1",
      "-Atqc",
      sql,
    ],
    {
      cwd: TOOL_DIR,
      env: {
        ...process.env,
        PGPASSWORD: target.password,
      },
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: MAX_BUFFER,
    },
  );

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `psql failed.\nSQL:\n${sql}\nSTDOUT:\n${result.stdout ?? ""}\nSTDERR:\n${result.stderr ?? ""}`,
    );
  }
  return result.stdout ?? "";
}

function createDatabase(prefix: string): DatabaseTarget {
  const adminUrl = resolveAdminDatabaseUrl();
  const databaseName = `${prefix}_${randomSuffix()}`.replace(/[^a-zA-Z0-9_]/g, "_");
  runAdminCommand(adminUrl, `CREATE DATABASE "${databaseName}"`);
  const target = {
    adminUrl,
    databaseName,
    databaseUrl: buildDatabaseUrl(adminUrl, databaseName),
  };
  tempDatabaseTargets.push(target);
  return target;
}

function createBrokenDatabaseUrl(): string {
  const adminUrl = resolveAdminDatabaseUrl();
  return buildDatabaseUrl(adminUrl, `missing_${randomSuffix()}`);
}

function createConfigFile(): string {
  const configPath = registerTempPath(
    join(
      TOOL_DIR,
      ".config",
      `temp.opencode.${Math.random().toString(36).slice(2)}.json`,
    ),
  );
  const baseConfig = JSON.parse(readFileSync(OPENCODE_CONFIG_PATH, "utf8")) as Record<
    string,
    unknown
  >;
  const pluginUrl = pathToFileURL(join(TOOL_DIR, "src/index.ts")).toString();

  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        ...baseConfig,
        plugin: [pluginUrl],
      },
      null,
      2,
    )}\n`,
  );

  return configPath;
}

async function startServer(databaseUrl: string): Promise<ServerHarness> {
  spawnSync("direnv", ["allow", TOOL_DIR], { cwd: TOOL_DIR, timeout: 30_000 });

  const configPath = createConfigFile();
  const port = await findFreePort();
  const baseUrl = `http://${HOST}:${port}`;
  let serverLogs = "";
  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, "");

  const xdgRoot = mkdtempSync(join(tmpdir(), "opencode-postgres-memory-xdg-"));
  const configHome = join(xdgRoot, "config");
  const cacheHome = join(xdgRoot, "cache");
  const stateHome = join(xdgRoot, "state");
  const testHome = join(xdgRoot, "home");
  mkdirSync(configHome, { recursive: true });
  mkdirSync(cacheHome, { recursive: true });
  mkdirSync(stateHome, { recursive: true });
  mkdirSync(testHome, { recursive: true });

  const serverProcess = spawn(
    "direnv",
    [
      "exec",
      TOOL_DIR,
      "env",
      `OPENCODE_CONFIG=${configPath}`,
      `POSTGRES_MEMORY_DATABASE_URL=${databaseUrl}`,
      `POSTGRES_MEMORY_TEST_SEED=${SEED}`,
      OPENCODE,
      "serve",
      "--hostname",
      HOST,
      "--port",
      String(port),
      "--print-logs",
      "--log-level",
      "INFO",
    ],
    {
      cwd: TOOL_DIR,
      env: {
        ...process.env,
        XDG_CONFIG_HOME: configHome,
        XDG_CACHE_HOME: cacheHome,
        XDG_STATE_HOME: stateHome,
        OPENCODE_TEST_HOME: testHome,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const readyLine = `opencode server listening on ${baseUrl}`;
  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
  const capture = (chunk: Buffer | string) => {
    serverLogs += chunk.toString();
  };

  serverProcess.stdout.on("data", capture);
  serverProcess.stderr.on("data", capture);

  while (Date.now() < deadline) {
    if (serverLogs.includes(readyLine)) {
      return {
        baseUrl,
        configPath,
        databaseName,
        databaseUrl,
        logs: () => serverLogs,
        process: serverProcess,
        xdgRoot,
      };
    }
    if (serverProcess.exitCode !== null) {
      throw new Error(
        `Custom OpenCode server exited early (${serverProcess.exitCode}).\n${serverLogs}`,
      );
    }
    await wait(200);
  }

  throw new Error(
    `Timed out waiting for custom OpenCode server at ${baseUrl}.\n${serverLogs}`,
  );
}

async function stopServer(harness: ServerHarness | undefined) {
  if (!harness) return;

  if (harness.process.exitCode === null) {
    harness.process.kill("SIGKILL");
    await wait(100);
  }

  rmSync(harness.xdgRoot, { recursive: true, force: true });
}

function runManager(baseUrl: string, args: string[]) {
  const result = spawnSync(
    "npx",
    ["--yes", `--package=${MANAGER_PACKAGE}`, "opx", ...args],
    {
      cwd: TOOL_DIR,
      env: {
        ...process.env,
        OPENCODE_BASE_URL: baseUrl,
      },
      encoding: "utf8",
      timeout: SESSION_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    },
  );

  if (result.error) throw result.error;

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (result.status !== 0) {
    throw new Error(
      `Manager command failed: opx ${args.join(" ")}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
    );
  }

  return { stdout, stderr };
}

function beginPrompt(baseUrl: string, prompt: string) {
  const { stdout } = runManager(baseUrl, [
    "begin-session",
    prompt,
    "--agent",
    PRIMARY_AGENT_NAME,
    "--json",
  ]);
  const parsed = JSON.parse(stdout) as { sessionID?: string };
  if (!parsed.sessionID) {
    throw new Error(`Could not parse session handle.\n${stdout}`);
  }
  runManager(baseUrl, ["wait", "--session", parsed.sessionID, "--json"]);
  return parsed.sessionID;
}

function readTranscript(baseUrl: string, sessionID: string): TranscriptDocument {
  const { stdout } = runManager(baseUrl, [
    "transcript",
    "--session",
    sessionID,
    "--json",
  ]);
  return JSON.parse(stdout) as TranscriptDocument;
}

function findCompletedToolUse(
  transcript: TranscriptDocument,
  toolName: string,
): ToolUseEvent {
  const toolSteps = (transcript.turns ?? [])
    .flatMap((turn) => turn.assistantMessages ?? [])
    .flatMap((message) => message.steps ?? [])
    .filter(
      (step) =>
        step.tool === toolName &&
        step.status === "completed",
    );

  const match = toolSteps.at(-1);
  if (!match) {
    throw new Error(
      `No completed tool use for ${toolName}.\n${JSON.stringify(transcript, null, 2)}`,
    );
  }
  return match;
}

function normalizeSql(sql: string) {
  return sql.replace(/\s+/g, " ").trim();
}

function toolInputSql(toolUse: ToolUseEvent): string {
  const parsed = JSON.parse(toolUse.inputText ?? "{}") as { sql?: unknown };
  const sql = parsed.sql;
  if (typeof sql !== "string") {
    throw new Error(`Tool input did not include sql: ${JSON.stringify(toolUse)}`);
  }
  return sql;
}

afterAll(async () => {
  await stopServer(normalHarness);
  await stopServer(brokenHarness);

  for (const target of [...tempDatabaseTargets].reverse()) {
    try {
      runAdminCommand(
        target.adminUrl,
        `DROP DATABASE IF EXISTS "${target.databaseName}" WITH (FORCE)`,
      );
    } catch {
      // Preserve the first meaningful test failure; cleanup failures can be examined manually.
    }
  }

  for (const path of tempPaths) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("postgres-memory runtime integration", () => {
  it("resolves PostgreSQL connection details from explicit URLs and standard PG env vars", () => {
    expect(
      postgresMemoryTesting.resolveDatabaseUrl({
        POSTGRES_MEMORY_DATABASE_URL:
          "postgresql://user:secret@127.0.0.1:5432/memory_db",
      } as NodeJS.ProcessEnv),
    ).toBe("postgresql://user:secret@127.0.0.1:5432/memory_db");

    expect(
      postgresMemoryTesting.resolveDatabaseUrl({
        DATABASE_URL: "postgresql://fallback:secret@127.0.0.1:5432/fallback_db",
      } as NodeJS.ProcessEnv),
    ).toBe("postgresql://fallback:secret@127.0.0.1:5432/fallback_db");

    expect(
      postgresMemoryTesting.resolveDatabaseUrl({
        PGHOST: "127.0.0.1",
        PGPORT: "5432",
        PGUSER: "postgres",
        PGPASSWORD: "secret",
        PGDATABASE: "memory_db",
      } as NodeJS.ProcessEnv),
    ).toBe("postgresql://postgres:secret@127.0.0.1:5432/memory_db");

    expect(
      postgresMemoryTesting.redactDatabaseUrl(
        "postgresql://postgres:secret@127.0.0.1:5432/memory_db",
      ),
    ).toBe("postgresql://postgres:***@127.0.0.1:5432/memory_db");
  });

  it("persists writes across independent query invocations, global scope, and session scope", async () => {
    const target = createDatabase("opencode_runtime");

    expectCommand(
      await postgresMemoryTesting.runPostgresQuery(
        `INSERT INTO memories (scope, session_id, project_name, metadata, content)
         VALUES
           ('session', 'session-a', 'runtime-project', '{"topic":"persistence"}', 'alpha memory'),
           ('global', NULL, 'runtime-project', '{"topic":"shared"}', 'global memory')`,
        target.databaseUrl,
      ),
      "INSERT 0 2",
    );

    expectRows(
      await postgresMemoryTesting.runPostgresQuery(
        `SELECT scope, session_id, content
         FROM memories
         WHERE project_name = 'runtime-project'
         ORDER BY scope, session_id NULLS FIRST`,
        target.databaseUrl,
      ),
      [
        { scope: "global", session_id: null, content: "global memory" },
        { scope: "session", session_id: "session-a", content: "alpha memory" },
      ],
    );
  }, 60_000);

  it("orders vector-nearest memories correctly with pgvector distance and creates the hnsw index", async () => {
    const target = createDatabase("opencode_vectors");

    expectCommand(
      await postgresMemoryTesting.runPostgresQuery(
        `INSERT INTO memories (scope, session_id, project_name, content, embedding)
         VALUES
           ('session', 'session-v', 'vector-project', 'alpha vector', ${buildVectorLiteral(1, 0)}),
           ('session', 'session-v', 'vector-project', 'balanced vector', ${buildVectorLiteral(0.7, 0.3)}),
           ('session', 'session-v', 'vector-project', 'beta vector', ${buildVectorLiteral(0, 1)})`,
        target.databaseUrl,
      ),
      "INSERT 0 3",
    );

    expectRows(
      await postgresMemoryTesting.runPostgresQuery(
        `SELECT content
         FROM memories
         WHERE project_name = 'vector-project'
         ORDER BY embedding <-> ${buildVectorLiteral(0.9, 0.1)}
         LIMIT 2`,
        target.databaseUrl,
      ),
      [{ content: "alpha vector" }, { content: "balanced vector" }],
    );

    expectRows(
      await postgresMemoryTesting.runPostgresQuery(
        `SELECT indexname
         FROM pg_indexes
         WHERE tablename = 'memories'
           AND indexname = 'idx_memories_embedding_hnsw'`,
        target.databaseUrl,
      ),
      [{ indexname: "idx_memories_embedding_hnsw" }],
    );
  }, 60_000);

  it("handles several hundred memories across a few dozen session IDs", async () => {
    const target = createDatabase("opencode_load");
    const values: string[] = [];
    const expectedCounts: Array<Record<string, unknown>> = [];

    for (let sessionIndex = 0; sessionIndex < 24; sessionIndex += 1) {
      const sessionID = `session-${String(sessionIndex).padStart(2, "0")}`;
      expectedCounts.push({ session_id: sessionID, total: 20 });

      for (let memoryIndex = 0; memoryIndex < 20; memoryIndex += 1) {
        values.push(
          `('session', '${sessionID}', 'load-project', 'memory ${sessionID} #${memoryIndex}', '{"session":${sessionIndex},"memory":${memoryIndex}}')`,
        );
      }
    }

    expectCommand(
      await postgresMemoryTesting.runPostgresQuery(
        `INSERT INTO memories (scope, session_id, project_name, content, metadata)
         VALUES ${values.join(",\n")}`,
        target.databaseUrl,
      ),
      "INSERT 0 480",
    );

    expectRows(
      await postgresMemoryTesting.runPostgresQuery(
        `SELECT count(*)::int AS total, count(DISTINCT session_id)::int AS session_total
         FROM memories
         WHERE project_name = 'load-project'`,
        target.databaseUrl,
      ),
      [{ total: 480, session_total: 24 }],
    );

    expectRows(
      await postgresMemoryTesting.runPostgresQuery(
        `SELECT session_id, count(*)::int AS total
         FROM memories
         WHERE project_name = 'load-project'
         GROUP BY session_id
         ORDER BY session_id`,
        target.databaseUrl,
      ),
      expectedCounts,
    );
  }, 60_000);

  it("classifies SQL mistakes separately from tool/runtime failures", async () => {
    const target = createDatabase("opencode_failures");

    const queryFailure = expectFailure(
      await postgresMemoryTesting.runPostgresQuery("SELEC 1", target.databaseUrl),
    );
    expect(queryFailure.failureKind).toBe("query_failure");
    if (queryFailure.failureKind !== "query_failure") {
      throw new Error(`Expected query failure, received ${JSON.stringify(queryFailure)}`);
    }
    expect(queryFailure.code).toBe("42601");
    expect(postgresMemoryTesting.formatQueryResult(queryFailure)).toContain(
      "QUERY FAILURE",
    );

    const toolFailure = expectFailure(
      await postgresMemoryTesting.runPostgresQuery(
        "SELECT 1",
        createBrokenDatabaseUrl(),
      ),
    );
    expect(toolFailure.failureKind).toBe("tool_failure");
    if (toolFailure.failureKind !== "tool_failure") {
      throw new Error(`Expected tool failure, received ${JSON.stringify(toolFailure)}`);
    }
    const formatted = postgresMemoryTesting.formatQueryResult(toolFailure);
    expect(formatted).toContain("TOOL FAILURE");
    expect(formatted).toContain(postgresMemoryTesting.BUG_REPORTING_URL);
  }, 60_000);
});

describe("postgres-memory live opencode sessions", () => {
  beforeAll(async () => {
    const target = createDatabase("opencode_live");
    normalHarness = await startServer(target.databaseUrl);
  });

  it("reads the same database from independent OpenCode sessions", async () => {
    if (!normalHarness) throw new Error("Live server was not initialized.");

    const secret = `GOLDEN-TICKET-${randomUUID()}`;
    const insertSql = `INSERT INTO memories (scope, session_id, project_name, metadata, content)
      VALUES ('session', 'session-alpha', 'live-project', '{"topic":"cross-session"}', '${secret}')`;
    beginPrompt(
      normalHarness.baseUrl,
      `Call query_memories exactly once with this SQL and no changes:\n${insertSql}\nReply with ONLY WRITTEN after the tool finishes.`,
    );
    expect(normalHarness.databaseName.startsWith("opencode_live_")).toBe(true);

    expectRows(
      await postgresMemoryTesting.runPostgresQuery(
        `SELECT content
         FROM memories
         WHERE project_name = 'live-project'
           AND session_id = 'session-alpha'`,
        normalHarness.databaseUrl,
      ),
      [{ content: secret }],
    );

    const selectSql = `SELECT content
      FROM memories
      WHERE project_name = 'live-project' AND session_id = 'session-alpha'
      LIMIT 1`;
    const readSessionID = beginPrompt(
      normalHarness.baseUrl,
      `Call query_memories exactly once with this SQL and no changes:\n${selectSql}\nThe correct value is a random token, so do not guess and do not answer from prior context.\nReply with ONLY the exact content value and nothing else.`,
    );
    const readTool = findCompletedToolUse(
      readTranscript(normalHarness.baseUrl, readSessionID),
      "query_memories",
    );
    expect(normalizeSql(toolInputSql(readTool))).toBe(normalizeSql(selectSql));
    expect(String(readTool.outputText ?? "")).toContain(secret);
  }, 220_000);

  it("surfaces SQL mistakes to the agent as query failures", () => {
    if (!normalHarness) throw new Error("Live server was not initialized.");

    const invalidSql = "SELEC count(*) FROM memories";
    const sessionID = beginPrompt(
      normalHarness.baseUrl,
      `Call query_memories exactly once with this SQL and no changes:\n${invalidSql}\nReply with ONLY FAILED after the tool finishes.`,
    );

    const toolUse = findCompletedToolUse(
      readTranscript(normalHarness.baseUrl, sessionID),
      "query_memories",
    );
    const output = String(toolUse.outputText ?? "");
    expect(output).toContain("QUERY FAILURE");
    expect(output).toContain("sqlstate: 42601");
    expect(output).not.toContain("TOOL FAILURE");
  }, 180_000);
});

describe("postgres-memory live tool failures", () => {
  beforeAll(async () => {
    brokenHarness = await startServer(createBrokenDatabaseUrl());
  });

  it("surfaces database connection problems to the agent as tool failures", () => {
    if (!brokenHarness) throw new Error("Broken live server was not initialized.");

    const sessionID = beginPrompt(
      brokenHarness.baseUrl,
      "Call query_memories exactly once with this SQL and no changes:\nSELECT 1\nReply with ONLY FAILED after the tool finishes.",
    );

    const toolUse = findCompletedToolUse(
      readTranscript(brokenHarness.baseUrl, sessionID),
      "query_memories",
    );
    const output = String(toolUse.outputText ?? "");
    expect(output).toContain("TOOL FAILURE");
    expect(output).toContain("stage: database_connection");
    expect(output).toContain(postgresMemoryTesting.BUG_REPORTING_URL);
    expect(output).not.toContain("QUERY FAILURE");
  }, 180_000);
});
