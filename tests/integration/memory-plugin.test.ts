import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileMemoryTesting } from "../../src/index.ts";

function requireEnv(name: string, message: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(message);
  return value;
}

const MAX_BUFFER = 8 * 1024 * 1024;
const RUNTIME_TIMEOUT_MS = 20_000;
const SESSION_TIMEOUT_MS = 240_000;
const AGENT_NAME = "plugin-proof";
const MANAGER_PACKAGE = "git+https://github.com/dzackgarza/opencode-manager.git";
const PROJECT_DIR = process.cwd();

// OpenCode must already be running before this file executes.
// `just test` runs the suite, but it does not start or stop the server.
const BASE_URL = requireEnv(
  "OPENCODE_BASE_URL",
  "OPENCODE_BASE_URL must be set (run against a repo-local or CI OpenCode server)",
);
const SHARED_MEM_ROOT = requireEnv(
  "OPENCODE_MEMORY_ROOT",
  "OPENCODE_MEMORY_ROOT must be set (from plugin .envrc or CI env)",
);

type CliResult = Awaited<ReturnType<typeof fileMemoryTesting.runCliCommand>>;

// Tool step shape from `ocm transcript --json`
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

afterAll(() => {
  for (const path of tempPaths) {
    rmSync(path, { recursive: true, force: true });
  }
});

function runOcm(args: string[]): { stdout: string; stderr: string } {
  const result = spawnSync(
    "uvx",
    ["--from", MANAGER_PACKAGE, "ocm", ...args],
    {
      env: { ...process.env, OPENCODE_BASE_URL: BASE_URL, OPENCODE_MEMORY_ROOT: SHARED_MEM_ROOT },
      cwd: PROJECT_DIR,
      encoding: "utf8",
      timeout: SESSION_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    },
  );
  if (result.error) throw result.error;
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (result.status !== 0) {
    throw new Error(`ocm ${args.join(" ")} failed\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
  }
  return { stdout, stderr };
}

function beginSession(prompt: string): string {
  const { stdout } = runOcm(["begin-session", prompt, "--agent", AGENT_NAME, "--json"]);
  const data = JSON.parse(stdout) as { sessionID: string };
  if (!data.sessionID) throw new Error(`begin-session returned no sessionID: ${stdout}`);
  return data.sessionID;
}

function waitIdle(sessionID: string) {
  runOcm(["wait", sessionID, "--timeout-sec=180"]);
}

function readTranscript(sessionID: string): TranscriptData {
  const { stdout } = runOcm(["transcript", sessionID, "--json"]);
  return JSON.parse(stdout) as TranscriptData;
}

/** Find a completed tool step in a transcript by tool name. */
function findToolStep(transcript: TranscriptData, toolName: string): TranscriptToolStep {
  for (const turn of transcript.turns) {
    for (const msg of turn.assistantMessages) {
      for (const step of msg.steps) {
        if (
          step.type === "tool" &&
          (step as TranscriptToolStep).tool === toolName &&
          (step as TranscriptToolStep).status === "completed"
        ) {
          return step as TranscriptToolStep;
        }
      }
    }
  }
  throw new Error(
    `No completed tool step for "${toolName}" in transcript ${transcript.sessionID}`,
  );
}

// ---------------------------------------------------------------------------
// Runtime integration tests (direct CLI, no OpenCode server)
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
  }, RUNTIME_TIMEOUT_MS);

  it("memory root is initialized as a git repo on first write", async () => {
    const memRoot = makeTempMemoryRoot();

    await fileMemoryTesting.runCliCommand(
      ["remember", "--content", "first memory", "--project", "global"],
      { ...process.env, OPENCODE_MEMORY_ROOT: memRoot },
    );

    expect(existsSync(join(memRoot, ".git"))).toBe(true);
  }, RUNTIME_TIMEOUT_MS);

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
  }, RUNTIME_TIMEOUT_MS);

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
  }, RUNTIME_TIMEOUT_MS);

  it("forget returns a not_found failure for an unknown ID", async () => {
    const memRoot = makeTempMemoryRoot();

    const result = (await fileMemoryTesting.runCliCommand(
      ["forget", "--id", "mem_doesnotexist"],
      { ...process.env, OPENCODE_MEMORY_ROOT: memRoot },
    )) as CliResult;

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected failure");
    expect(result.stage).toBe("not_found");
  }, RUNTIME_TIMEOUT_MS);

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
  }, RUNTIME_TIMEOUT_MS);

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
  }, RUNTIME_TIMEOUT_MS);

  it("formatCliResult produces TOOL FAILURE text for failed results", async () => {
    const failResult = (await fileMemoryTesting.runCliCommand(
      ["forget", "--id", "mem_ghost"],
      { ...process.env, OPENCODE_MEMORY_ROOT: "/tmp/definitely_does_not_exist_xyzzy" },
    )) as CliResult;

    expect(failResult.ok).toBe(false);
    if (failResult.ok) throw new Error("Expected failure");
    const formatted = fileMemoryTesting.formatCliResult(failResult);
    expect(formatted).toContain("TOOL FAILURE");
    expect(formatted).toContain(fileMemoryTesting.BUG_REPORTING_URL);
  }, RUNTIME_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// Live OpenCode session tests (opencode-manager, requires running server)
// ---------------------------------------------------------------------------

describe("file-memory live opencode sessions", () => {
  it("agent can remember a fact and it appears in the memory root as a file", () => {
    const secret = `GOLDEN-TICKET-${randomUUID()}`;
    const sessionID = beginSession(
      `Call remember exactly once with content="${secret}" and project="global". Reply with ONLY WRITTEN after the tool finishes.`,
    );
    try {
      waitIdle(sessionID);
      const transcript = readTranscript(sessionID);
      const step = findToolStep(transcript, "remember");
      expect(step.status).toBe("completed");

      // Verify the file was written to disk in the shared memory root
      const globalDir = join(SHARED_MEM_ROOT, "global");
      const files = readdirSync(globalDir);
      const found = files.some((f) =>
        readFileSync(join(globalDir, f), "utf8").includes(secret),
      );
      expect(found).toBe(true);
    } finally {
      try { runOcm(["delete", sessionID]); } catch { /* best-effort */ }
    }
  }, SESSION_TIMEOUT_MS);

  it("agent can find a memory written in a prior run using list_memories", () => {
    const secret = `RECALL-TOKEN-${randomUUID()}`;

    // Write in first session
    const writeID = beginSession(
      `Call remember exactly once with content="${secret}" and project="global". Reply ONLY WRITTEN.`,
    );
    try {
      waitIdle(writeID);
    } finally {
      try { runOcm(["delete", writeID]); } catch { /* best-effort */ }
    }

    // Find via list_memories SQL in second independent session
    const readID = beginSession(
      'Call list_memories exactly once with sql="SELECT path FROM memories ORDER BY mtime DESC LIMIT 1". Reply with ONLY FOUND after the tool finishes.',
    );
    try {
      waitIdle(readID);
      const transcript = readTranscript(readID);
      const step = findToolStep(transcript, "list_memories");
      expect(step.outputText).toContain(SHARED_MEM_ROOT);
      expect(step.outputText).toContain(".md");
    } finally {
      try { runOcm(["delete", readID]); } catch { /* best-effort */ }
    }
  }, SESSION_TIMEOUT_MS);

  it("forget surfaces a TOOL FAILURE when the memory ID does not exist", () => {
    const sessionID = beginSession(
      'Call forget exactly once with id="mem_definitelynotavalidid_xyzzy". Reply with ONLY FAILED after the tool finishes.',
    );
    try {
      waitIdle(sessionID);
      const transcript = readTranscript(sessionID);
      const step = findToolStep(transcript, "forget");
      expect(step.outputText).toContain("TOOL FAILURE");
      expect(step.outputText).not.toContain("Deleted");
    } finally {
      try { runOcm(["delete", sessionID]); } catch { /* best-effort */ }
    }
  }, SESSION_TIMEOUT_MS);
});
