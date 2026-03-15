import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fileMemoryTesting } from "../../src/index.ts";

const TOOL_DIR = process.cwd();
const OPENCODE_CONFIG_PATH = join(TOOL_DIR, ".config", "opencode.json");
const MAX_BUFFER = 8 * 1024 * 1024;
const SESSION_TIMEOUT_MS = 240_000;
const PRIMARY_AGENT_NAME = "plugin-proof";
const SEED = "FMEM-99";
const SERVER_PORT = 4399;
const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`;
const MANAGER = "npx --yes --package=git+https://github.com/dzackgarza/opencode-manager.git opx";

type CliResult = Awaited<ReturnType<typeof fileMemoryTesting.runCliCommand>>;

// Tool step shape from `opx transcript --json`
type TranscriptToolStep = {
  type: "tool";
  tool: string;
  status: string;
  inputText: string;
  outputText: string;
};

type TranscriptData = {
  sessionID: string;
  turns: Array<{
    userPrompt: string;
    assistantMessages: Array<{
      steps: Array<{ type: string; [key: string]: unknown }>;
    }>;
  }>;
};

const tempPaths = new Set<string>();
let sharedConfig: string;
let sharedMemRoot: string;
let serverProcess: ChildProcess | null = null;

function registerTempPath(path: string): string {
  tempPaths.add(path);
  return path;
}

function randomSuffix(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function makeTempMemoryRoot(): string {
  return registerTempPath(mkdtempSync(join(tmpdir(), "opencode-file-memory-")));
}

function createConfigFile(): string {
  const configPath = registerTempPath(
    join(
      TOOL_DIR,
      ".config",
      `temp.opencode.${Math.random().toString(36).slice(2)}.json`,
    ),
  );
  const baseConfig = JSON.parse(
    readFileSync(OPENCODE_CONFIG_PATH, "utf8"),
  ) as Record<string, unknown>;
  const pluginUrl = pathToFileURL(join(TOOL_DIR, "src/index.ts")).toString();
  writeFileSync(
    configPath,
    `${JSON.stringify({ ...baseConfig, plugin: [pluginUrl] }, null, 2)}\n`,
  );
  return configPath;
}

/** Start a repo-local opencode server; keeps it alive as a child of this process. */
function startServer(config: string, extraEnv: Record<string, string> = {}): void {
  serverProcess = spawn(
    "direnv",
    ["exec", TOOL_DIR, "opencode", "serve", "--hostname", "127.0.0.1", "--port", String(SERVER_PORT)],
    {
      cwd: TOOL_DIR,
      env: { ...process.env, OPENCODE_CONFIG: config, ...extraEnv },
      stdio: "ignore",
      detached: false,
    },
  );
  // Give the server time to bind
  spawnSync("sleep", ["5"]);
}

/** Run a prompt against the live server via opencode-manager; return the transcript. */
function runSession(
  prompt: string,
  extraEnv: Record<string, string> = {},
): TranscriptData {
  const env = {
    ...process.env,
    OPENCODE_BASE_URL: SERVER_URL,
    OPENCODE_MEMORY_TEST_SEED: SEED,
    ...extraEnv,
  };

  const beginResult = spawnSync(
    "bash",
    ["-c", `${MANAGER} begin-session "${prompt.replace(/"/g, '\\"')}" --agent ${PRIMARY_AGENT_NAME} --json`],
    { cwd: TOOL_DIR, encoding: "utf8", timeout: SESSION_TIMEOUT_MS, maxBuffer: MAX_BUFFER, env },
  );
  if (beginResult.error) throw beginResult.error;
  const beginStdout = beginResult.stdout.trim();
  if (!beginStdout) {
    throw new Error(
      `begin-session returned empty stdout (exit ${beginResult.status}).\nstderr: ${beginResult.stderr}`,
    );
  }
  const { sessionID } = JSON.parse(beginStdout) as { sessionID: string };

  // Wait for completion
  spawnSync(
    "bash",
    ["-c", `${MANAGER} wait --session ${sessionID}`],
    { cwd: TOOL_DIR, encoding: "utf8", timeout: SESSION_TIMEOUT_MS, maxBuffer: MAX_BUFFER, env },
  );

  // Read transcript
  const transcriptResult = spawnSync(
    "bash",
    ["-c", `${MANAGER} transcript --session ${sessionID} --json`],
    { cwd: TOOL_DIR, encoding: "utf8", timeout: 30_000, maxBuffer: MAX_BUFFER, env },
  );
  if (transcriptResult.error) throw transcriptResult.error;
  return JSON.parse(transcriptResult.stdout.trim()) as TranscriptData;
}

/** Find a completed tool step in a transcript by tool name. */
function findToolStep(transcript: TranscriptData, toolName: string): TranscriptToolStep {
  for (const turn of transcript.turns) {
    for (const msg of turn.assistantMessages) {
      for (const step of msg.steps) {
        if (step.type === "tool" && (step as TranscriptToolStep).tool === toolName && (step as TranscriptToolStep).status === "completed") {
          return step as TranscriptToolStep;
        }
      }
    }
  }
  throw new Error(
    `No completed tool step for "${toolName}" in transcript ${transcript.sessionID}`,
  );
}

afterAll(() => {
  for (const path of tempPaths) {
    rmSync(path, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Runtime integration tests (direct CLI, no OpenCode)
// ---------------------------------------------------------------------------

describe("file-memory runtime integration", () => {
  it("remember creates a YAML-headered markdown file with correct structure", async () => {
    const memRoot = makeTempMemoryRoot();
    const content = "The production hostname is api.internal.example";

    const result = (await fileMemoryTesting.runCliCommand(
      ["remember", "--content", content, "--project", "global", "--tag", "infra"],
      { ...process.env, OPENCODE_MEMORY_ROOT: memRoot },
    )) as CliResult;

    if (!result.ok) throw new Error(`Expected ok, got ${JSON.stringify(result)}`);
    expect(result.kind).toBe("remember");
    if (!result.ok || result.kind !== "remember") throw new Error(JSON.stringify(result));
    expect(result.id).toMatch(/^mem_/);

    // File must exist on disk under global/ with correct content
    const globalDir = join(memRoot, "global");
    const files = readdirSync(globalDir);
    expect(files.length).toBe(1);
    const fileContent = readFileSync(join(globalDir, files[0]!), "utf8");
    expect(fileContent).toContain("id: mem_");
    expect(fileContent).toContain("project: global");
    expect(fileContent).toContain("- infra");
    expect(fileContent).toContain(content);
  });

  it("memory root is initialized as a git repo on first write", async () => {
    const memRoot = makeTempMemoryRoot();

    await fileMemoryTesting.runCliCommand(
      ["remember", "--content", "first memory", "--project", "global"],
      { ...process.env, OPENCODE_MEMORY_ROOT: memRoot },
    );

    expect(existsSync(join(memRoot, ".git"))).toBe(true);
  });

  it("remember + list_memories round-trip: project vs global scope isolation", async () => {
    const memRoot = makeTempMemoryRoot();
    const project = `test_${randomSuffix()}`;
    const sessionId = `ses_${randomSuffix()}`;

    // Project-scoped memory (tagged with a session_id for later filtering)
    await fileMemoryTesting.runCliCommand(
      [
        "remember",
        "--content",
        "project note",
        "--project",
        project,
        "--session-id",
        sessionId,
      ],
      { ...process.env, OPENCODE_MEMORY_ROOT: memRoot },
    );
    // Global memory
    await fileMemoryTesting.runCliCommand(
      ["remember", "--content", "global note", "--project", "global"],
      { ...process.env, OPENCODE_MEMORY_ROOT: memRoot },
    );

    // List by project + session filter → only the project note
    const projectList = (await fileMemoryTesting.runCliCommand(
      ["list", "--sql", `SELECT * FROM memories WHERE project = '${project}' AND session_id = '${sessionId}'`],
      { ...process.env, OPENCODE_MEMORY_ROOT: memRoot },
    )) as CliResult;
    if (!projectList.ok || projectList.kind !== "list")
      throw new Error(JSON.stringify(projectList));
    expect(projectList.count).toBe(1);
    expect(projectList.results[0]?.["project"]).toBe(project);

    // List global only → only the global note
    const globalList = (await fileMemoryTesting.runCliCommand(
      ["list", "--sql", "SELECT * FROM memories WHERE project = 'global'"],
      { ...process.env, OPENCODE_MEMORY_ROOT: memRoot },
    )) as CliResult;
    if (!globalList.ok || globalList.kind !== "list")
      throw new Error(JSON.stringify(globalList));
    expect(globalList.count).toBe(1);
    expect(globalList.results[0]?.["project"]).toBe("global");

    // List all → both
    const allList = (await fileMemoryTesting.runCliCommand(
      ["list", "--sql", "SELECT * FROM memories"],
      { ...process.env, OPENCODE_MEMORY_ROOT: memRoot },
    )) as CliResult;
    if (!allList.ok || allList.kind !== "list") throw new Error(JSON.stringify(allList));
    expect(allList.count).toBe(2);
  });

  it("forget deletes the target memory and leaves others intact", async () => {
    const memRoot = makeTempMemoryRoot();
    const project = `test_${randomSuffix()}`;

    const r1 = (await fileMemoryTesting.runCliCommand(
      ["remember", "--content", "to delete", "--project", project],
      { ...process.env, OPENCODE_MEMORY_ROOT: memRoot },
    )) as CliResult;
    const r2 = (await fileMemoryTesting.runCliCommand(
      ["remember", "--content", "to keep", "--project", project],
      { ...process.env, OPENCODE_MEMORY_ROOT: memRoot },
    )) as CliResult;

    if (!r1.ok || r1.kind !== "remember") throw new Error(JSON.stringify(r1));
    if (!r2.ok || r2.kind !== "remember") throw new Error(JSON.stringify(r2));

    // forget no longer needs --project: IDs are globally unique
    const forgetResult = (await fileMemoryTesting.runCliCommand(
      ["forget", "--id", r1.id],
      { ...process.env, OPENCODE_MEMORY_ROOT: memRoot },
    )) as CliResult;
    if (!forgetResult.ok) throw new Error(`forget failed: ${JSON.stringify(forgetResult)}`);
    expect(forgetResult.kind).toBe("forget");

    const remaining = (await fileMemoryTesting.runCliCommand(
      ["list", "--sql", `SELECT id FROM memories WHERE project = '${project}'`],
      { ...process.env, OPENCODE_MEMORY_ROOT: memRoot },
    )) as CliResult;
    if (!remaining.ok || remaining.kind !== "list") throw new Error(JSON.stringify(remaining));
    expect(remaining.count).toBe(1);
    expect(remaining.results[0]?.["id"]).toBe(r2.id);
  });

  it("forget returns a not_found failure for an unknown ID", async () => {
    const memRoot = makeTempMemoryRoot();

    const result = (await fileMemoryTesting.runCliCommand(
      ["forget", "--id", "mem_doesnotexist"],
      { ...process.env, OPENCODE_MEMORY_ROOT: memRoot },
    )) as CliResult;

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected failure");
    expect(result.stage).toBe("not_found");
  });

  it("concurrent writes produce distinct non-colliding files", async () => {
    const memRoot = makeTempMemoryRoot();
    const project = `test_${randomSuffix()}`;

    const writes = Array.from({ length: 10 }, (_, i) =>
      fileMemoryTesting.runCliCommand(
        [
          "remember",
          "--content",
          `memory ${i}`,
          "--project",
          project,
        ],
        { ...process.env, OPENCODE_MEMORY_ROOT: memRoot },
      ),
    );
    const results = await Promise.all(writes);

    const ids = new Set<string>();
    for (const r of results) {
      if (!r.ok || r.kind !== "remember")
        throw new Error(`Write failed: ${JSON.stringify(r)}`);
      ids.add(r.id);
    }
    expect(ids.size).toBe(10);

    const listed = (await fileMemoryTesting.runCliCommand(
      ["list", "--sql", `SELECT id FROM memories WHERE project = '${project}'`],
      { ...process.env, OPENCODE_MEMORY_ROOT: memRoot },
    )) as CliResult;
    if (!listed.ok || listed.kind !== "list") throw new Error(JSON.stringify(listed));
    expect(listed.count).toBe(10);
  });

  it("list-files outputs one path per line for piping", async () => {
    const memRoot = makeTempMemoryRoot();
    const project = `test_${randomSuffix()}`;

    for (let i = 0; i < 3; i++) {
      await fileMemoryTesting.runCliCommand(
        ["remember", "--content", `note ${i}`, "--project", project],
        { ...process.env, OPENCODE_MEMORY_ROOT: memRoot },
      );
    }

    // list-files outputs raw paths, not JSON — use the CLI directly
    const { execFileSync } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const { join: pathJoin } = await import("node:path");
    const cliPath = pathJoin(
      fileURLToPath(new URL("../../src/", import.meta.url)),
      "cli.py",
    );
    const output = execFileSync(
      "uv",
      ["run", cliPath, "list-files", "--project", project],
      { env: { ...process.env, OPENCODE_MEMORY_ROOT: memRoot }, encoding: "utf8" },
    );
    const paths = output
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    expect(paths.length).toBe(3);
    for (const p of paths) {
      expect(p).toMatch(/\.md$/);
      expect(existsSync(p)).toBe(true);
    }
  });

  it("list --sql returns results matching SQL filter", async () => {
    const memRoot = makeTempMemoryRoot();
    const project = `test_${randomSuffix()}`;

    await fileMemoryTesting.runCliCommand(
      ["remember", "--content", "nginx SSL termination", "--project", project, "--tag", "infra"],
      { ...process.env, OPENCODE_MEMORY_ROOT: memRoot },
    );
    await fileMemoryTesting.runCliCommand(
      ["remember", "--content", "database rotation policy", "--project", project, "--tag", "security"],
      { ...process.env, OPENCODE_MEMORY_ROOT: memRoot },
    );
    await fileMemoryTesting.runCliCommand(
      ["remember", "--content", "global note", "--project", "global"],
      { ...process.env, OPENCODE_MEMORY_ROOT: memRoot },
    );

    // SQL filter: only memories in the test project
    const result = (await fileMemoryTesting.runCliCommand(
      ["list", "--sql", `SELECT id, path, project FROM memories WHERE project = '${project}'`],
      { ...process.env, OPENCODE_MEMORY_ROOT: memRoot },
    )) as CliResult;

    if (!result.ok || result.kind !== "list")
      throw new Error(`list failed: ${JSON.stringify(result)}`);
    expect(result.count).toBe(2);
    for (const row of result.results) {
      expect(row["project"]).toBe(project);
      expect(String(row["path"])).toMatch(/\.md$/);
    }

    // SQL filter by tag using json_each
    const tagResult = (await fileMemoryTesting.runCliCommand(
      ["list", "--sql", `SELECT id FROM memories WHERE EXISTS (SELECT 1 FROM json_each(tags) WHERE value = 'infra')`],
      { ...process.env, OPENCODE_MEMORY_ROOT: memRoot },
    )) as CliResult;

    if (!tagResult.ok || tagResult.kind !== "list")
      throw new Error(`tag list failed: ${JSON.stringify(tagResult)}`);
    expect(tagResult.count).toBe(1);
  });

  it("formatCliResult produces TOOL FAILURE text for failed results", async () => {
    // forget on a non-existent memory root → not_found failure
    const failResult = (await fileMemoryTesting.runCliCommand(
      ["forget", "--id", "mem_ghost"],
      { ...process.env, OPENCODE_MEMORY_ROOT: "/tmp/definitely_does_not_exist_xyzzy" },
    )) as CliResult;

    expect(failResult.ok).toBe(false);
    if (failResult.ok) throw new Error("Expected failure");
    const formatted = fileMemoryTesting.formatCliResult(failResult);
    expect(formatted).toContain("TOOL FAILURE");
    expect(formatted).toContain(fileMemoryTesting.BUG_REPORTING_URL);
  });
});

// ---------------------------------------------------------------------------
// Live OpenCode session tests (opencode-manager)
// ---------------------------------------------------------------------------

describe("file-memory live opencode sessions", () => {
  beforeAll(() => {
    sharedMemRoot = makeTempMemoryRoot();
    sharedConfig = createConfigFile();
    startServer(sharedConfig, { OPENCODE_MEMORY_ROOT: sharedMemRoot });
  }, 30_000);

  afterAll(() => {
    serverProcess?.kill();
    serverProcess = null;
  });

  it("agent can remember a fact and it appears in the memory root as a file", () => {
    const secret = `GOLDEN-TICKET-${randomUUID()}`;
    const transcript = runSession(
      `Call remember exactly once with content="${secret}" and project="global". Reply with ONLY WRITTEN after the tool finishes.`,
      { OPENCODE_MEMORY_ROOT: sharedMemRoot },
    );
    const step = findToolStep(transcript, "remember");
    expect(step.status).toBe("completed");

    // Verify the file was written to disk
    const globalDir = join(sharedMemRoot, "global");
    const files = readdirSync(globalDir);
    const found = files.some((f) =>
      readFileSync(join(globalDir, f), "utf8").includes(secret),
    );
    expect(found).toBe(true);
  }, SESSION_TIMEOUT_MS);

  it("agent can find a memory written in a prior run using list_memories", () => {
    // Write in first session
    const secret = `RECALL-TOKEN-${randomUUID()}`;
    runSession(
      `Call remember exactly once with content="${secret}" and project="global". Reply ONLY WRITTEN.`,
      { OPENCODE_MEMORY_ROOT: sharedMemRoot },
    );

    // Find via list_memories SQL in second independent session
    const transcript = runSession(
      `Call list_memories exactly once with sql="SELECT path FROM memories WHERE project='global' ORDER BY mtime DESC LIMIT 1". Reply with ONLY the path value from the result, nothing else.`,
      { OPENCODE_MEMORY_ROOT: sharedMemRoot },
    );
    const step = findToolStep(transcript, "list_memories");
    expect(step.outputText).toContain(sharedMemRoot);
  }, SESSION_TIMEOUT_MS);

  it("forget surfaces a TOOL FAILURE when the memory ID does not exist", () => {
    const transcript = runSession(
      'Call forget exactly once with id="mem_definitelynotavalidid_xyzzy". Reply with ONLY FAILED after the tool finishes.',
      { OPENCODE_MEMORY_ROOT: sharedMemRoot },
    );
    const step = findToolStep(transcript, "forget");
    expect(step.outputText).toContain("TOOL FAILURE");
    expect(step.outputText).not.toContain("Deleted");
  }, SESSION_TIMEOUT_MS);
});
