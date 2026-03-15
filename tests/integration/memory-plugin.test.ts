import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
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

const OPENCODE = process.env.OPENCODE_BIN || "opencode";
const TOOL_DIR = process.cwd();
const OPENCODE_CONFIG_PATH = join(TOOL_DIR, ".config", "opencode.json");
const MAX_BUFFER = 8 * 1024 * 1024;
const SESSION_TIMEOUT_MS = 240_000;
const PRIMARY_AGENT_NAME = "plugin-proof";
const SEED = "FMEM-99";

type CliResult = Awaited<ReturnType<typeof fileMemoryTesting.runCliCommand>>;

// JSON event emitted by `opencode run --format json`
type ToolUseEvent = {
  type: "tool_use";
  part: {
    type: "tool";
    tool: string;
    state: {
      status?: string;
      input?: unknown;
      output?: string;
    };
  };
};

const tempPaths = new Set<string>();
let sharedConfig: string;
let sharedMemRoot: string;

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

function parseJsonEvents(output: string): unknown[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function runJson(
  prompt: string,
  config: string,
  extraEnv: Record<string, string> = {},
): unknown[] {
  const result = spawnSync(
    OPENCODE,
    ["run", "--agent", PRIMARY_AGENT_NAME, "--format", "json", prompt],
    {
      cwd: TOOL_DIR,
      encoding: "utf8",
      timeout: SESSION_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      env: {
        ...process.env,
        OPENCODE_CONFIG: config,
        OPENCODE_MEMORY_TEST_SEED: SEED,
        ...extraEnv,
      },
    },
  );
  if (result.error) throw result.error;
  return parseJsonEvents((result.stdout ?? "") + (result.stderr ?? ""));
}

function findCompletedToolUse(events: unknown[], toolName: string): ToolUseEvent {
  const match = (events as unknown[]).find(
    (event): event is ToolUseEvent =>
      typeof event === "object" &&
      event !== null &&
      "type" in event &&
      (event as Record<string, unknown>).type === "tool_use" &&
      "part" in event &&
      typeof (event as Record<string, unknown>).part === "object" &&
      (event as Record<string, unknown>).part !== null &&
      "tool" in ((event as Record<string, unknown>).part as Record<string, unknown>) &&
      ((event as Record<string, unknown>).part as Record<string, unknown>).tool === toolName &&
      "state" in ((event as Record<string, unknown>).part as Record<string, unknown>) &&
      typeof ((event as Record<string, unknown>).part as Record<string, unknown>).state === "object" &&
      ((event as Record<string, unknown>).part as Record<string, unknown>).state !== null &&
      "status" in (((event as Record<string, unknown>).part as Record<string, unknown>).state as Record<string, unknown>) &&
      (((event as Record<string, unknown>).part as Record<string, unknown>).state as Record<string, unknown>).status === "completed",
  );
  if (!match) {
    throw new Error(
      `No completed tool use for ${toolName}.\n${JSON.stringify(events.slice(-10), null, 2)}`,
    );
  }
  return match;
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
// Live OpenCode session tests (opencode run --format json)
// ---------------------------------------------------------------------------

describe("file-memory live opencode sessions", () => {
  beforeAll(() => {
    sharedMemRoot = makeTempMemoryRoot();
    sharedConfig = createConfigFile();
  });

  it("agent can remember a fact and it appears in the memory root as a file", () => {
    const secret = `GOLDEN-TICKET-${randomUUID()}`;
    const events = runJson(
      `Call remember exactly once with content="${secret}" and scope="global". Reply with ONLY WRITTEN after the tool finishes.`,
      sharedConfig,
      { OPENCODE_MEMORY_ROOT: sharedMemRoot },
    );
    const toolUse = findCompletedToolUse(events, "remember");
    expect(toolUse.part.state.status).toBe("completed");

    // Verify the file was written to disk
    const globalDir = join(sharedMemRoot, "global");
    const files = readdirSync(globalDir);
    const found = files.some((f) =>
      readFileSync(join(globalDir, f), "utf8").includes(secret),
    );
    expect(found).toBe(true);
  }, SESSION_TIMEOUT_MS);

  it("agent can recall a memory written in a prior run", () => {
    // Write in first session
    const secret = `RECALL-TOKEN-${randomUUID()}`;
    runJson(
      `Call remember exactly once with content="${secret}" and scope="global". Reply ONLY WRITTEN.`,
      sharedConfig,
      { OPENCODE_MEMORY_ROOT: sharedMemRoot },
    );

    // Recall in second independent session
    const readEvents = runJson(
      `Call recall exactly once with query="${secret}" and scope="global". Reply with ONLY the exact content value from the first result, nothing else.`,
      sharedConfig,
      { OPENCODE_MEMORY_ROOT: sharedMemRoot },
    );
    const recallToolUse = findCompletedToolUse(readEvents, "recall");
    expect(recallToolUse.part.state.output).toContain(secret);
  }, SESSION_TIMEOUT_MS);

  it("forget surfaces a TOOL FAILURE when the memory ID does not exist", () => {
    const events = runJson(
      'Call forget exactly once with id="mem_definitelynotavalidid_xyzzy". Reply with ONLY FAILED after the tool finishes.',
      sharedConfig,
      { OPENCODE_MEMORY_ROOT: sharedMemRoot },
    );
    const forgetToolUse = findCompletedToolUse(events, "forget");
    expect(forgetToolUse.part.state.output).toContain("TOOL FAILURE");
    expect(forgetToolUse.part.state.output).not.toContain("Deleted");
  }, SESSION_TIMEOUT_MS);
});
