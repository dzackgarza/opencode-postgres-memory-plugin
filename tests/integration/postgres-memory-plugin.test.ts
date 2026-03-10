import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const OPENCODE = "/home/dzack/.opencode/bin/opencode";
const TOOL_DIR = "/home/dzack/opencode-plugins/opencode-postgres-memory-plugin";
const MAX_BUFFER = 8 * 1024 * 1024;

const SEED = "POSTGRES-MEM-99";
function pass(tool: string, path: string) {
  return `${SEED}:${tool}:${path}`;
}

let tmpDbDir: string;

beforeAll(() => {
  tmpDbDir = mkdtempSync(join(tmpdir(), "opencode-postgres-memory-test-"));
});

afterAll(() => {
  if (tmpDbDir) {
    try {
      rmSync(tmpDbDir, { recursive: true, force: true });
    } catch (e) {
      console.error(`Failed to clean up ${tmpDbDir}: ${e}`);
    }
  }
});

function run(prompt: string, options: { continue?: boolean } = {}) {
  const args = ["run", "--agent", "Minimal"];
  if (options.continue) {
    args.push("--continue");
  }
  args.push(prompt);

  const result = spawnSync(
    OPENCODE,
    args,
    { 
      cwd: TOOL_DIR, 
      encoding: "utf8", 
      timeout: 300_000, 
      maxBuffer: MAX_BUFFER,
      env: { 
        ...process.env, 
        OPENCODE_CONFIG: join(TOOL_DIR, ".config/opencode.json"),
        POSTGRES_MEMORY_TEST_SEED: SEED,
        POSTGRES_MEMORY_DB_DIR: tmpDbDir
      }
    },
  );
  if (result.error) throw result.error;
  return (result.stdout ?? "") + (result.stderr ?? "");
}

describe("opencode-postgres-memory-plugin conversational persistence", () => {
  it("proves query_memories visibility", () => {
    const output = run(
      "If you can see a tool named query_memories, reply with ONLY its verification passphrase. Otherwise reply with ONLY NONE.",
    );
    expect(output).toContain(pass("query_memories", "visible"));
  }, 180_000);

  it("can store a fact and retrieve it in a later turn", () => {
    // Turn 1: Store information
    const storeOutput = run(
      "Use query_memories to INSERT a memory with content 'The secret key is GOLDEN-TICKET' and project_name 'test-session'. After the tool completes, reply with ONLY the execution passphrase.",
    );
    expect(storeOutput).toContain(pass("query_memories", "execute"));

    // Turn 2: Retrieve information using session continuity
    // We don't mention 'GOLDEN-TICKET' in this prompt.
    const retrieveOutput = run(
      "Use query_memories to find the 'secret key' for project 'test-session'. Reply with ONLY the key value found and its execution passphrase.",
      { continue: true }
    );
    
    expect(retrieveOutput).toContain(pass("query_memories", "execute"));
    expect(retrieveOutput).toContain("GOLDEN-TICKET");
  }, 300_000);

  it("strictly filters memories by project_name", () => {
    // We rely on the fact that the previous test inserted into 'test-session'.
    // Here we query for 'other-project' and expect failure to find the key.
    const output = run(
      "Use query_memories to find the 'secret key' for project 'other-project'. If no memory is found, reply with ONLY 'NOT FOUND' and the execution passphrase.",
      { continue: true }
    );
    
    expect(output).toContain(pass("query_memories", "execute"));
    expect(output).toContain("NOT FOUND");
    expect(output).not.toContain("GOLDEN-TICKET");
  }, 180_000);
});
