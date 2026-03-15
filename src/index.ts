import { type Plugin, tool } from "@opencode-ai/plugin";
import { $ } from "bun";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pkg from "../package.json" assert { type: "json" };

const PLUGIN_VERSION = pkg.version;
const BUG_REPORTING_URL =
  "https://github.com/dzackgarza/opencode-memory-plugin/issues/new?labels=bug";
const MEMORY_ROOT_ENV = "OPENCODE_MEMORY_ROOT";
const MEMORY_SEED_ENV = "OPENCODE_MEMORY_TEST_SEED";
const ISSUE_REPORTING_HINT = `If this looks like a plugin/runtime bug, file a GitHub issue tagged \`bug\`: ${BUG_REPORTING_URL}`;

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

type RememberSuccess = {
  ok: true;
  kind: "remember";
  id: string;
  path: string;
  project: string;
  git_error?: string | null;
};

type ListSuccess = {
  ok: true;
  kind: "list";
  results: Record<string, unknown>[];
  count: number;
};

type ForgetSuccess = {
  ok: true;
  kind: "forget";
  id: string;
  message: string;
  git_error?: string | null;
};

type CliFailure = {
  ok: false;
  stage: string;
  message: string;
  detail?: string;
};

type CliResult =
  | RememberSuccess
  | ListSuccess
  | ForgetSuccess
  | CliFailure;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function resolveMemoryRoot(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = env[MEMORY_ROOT_ENV]?.trim();
  if (explicit) return explicit;
  // Default mirrors the Python CLI logic: ~/.local/share/opencode-memory
  // (shared across all projects; project slug is a subdirectory within the repo)
  const xdgData =
    env.XDG_DATA_HOME?.trim() ||
    join(env.HOME?.trim() || homedir(), ".local", "share");
  return join(xdgData, "opencode-memory");
}

function cliPath(): string {
  const dir = fileURLToPath(new URL(".", import.meta.url));
  return join(dir, "cli.py");
}

async function runCliCommand(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<CliResult> {
  const cli = cliPath();
  // uv reads PEP 723 inline deps from cli.py — no --with flags needed.
  const output = await $`uv run ${cli} ${args}`.env(env).quiet().nothrow();
  const text = output.stdout.toString().trim();
  if (!text) {
    return {
      ok: false,
      stage: "runner_output",
      message: "CLI returned empty output.",
      detail: output.stderr.toString().trim() || undefined,
    };
  }
  try {
    return JSON.parse(text) as CliResult;
  } catch {
    return {
      ok: false,
      stage: "runner_output",
      message: "CLI returned non-JSON output.",
      detail: text.slice(0, 500),
    };
  }
}

const GIT_FAILURE_HINT = [
  "Memory was written successfully but the git commit failed.",
  "Version control is essential — without it, accumulated knowledge has no protection against overwrites or data loss.",
  `Please investigate and file an issue if this is a plugin bug: ${BUG_REPORTING_URL}`,
].join("\n");

function formatGitError(error: string): string {
  return `\n\nGIT COMMIT FAILURE\nerror: ${error}\n${GIT_FAILURE_HINT}`;
}

function formatCliResult(result: CliResult): string {
  if (!result.ok) {
    return [
      "TOOL FAILURE",
      `stage: ${result.stage}`,
      `message: ${result.message}`,
      result.detail ? `detail: ${result.detail}` : undefined,
      `bug_report: ${BUG_REPORTING_URL}`,
      ISSUE_REPORTING_HINT,
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (result.kind === "remember") {
    const base = `Saved: ${result.id} → ${result.path}`;
    return result.git_error ? base + formatGitError(result.git_error) : base;
  }

  if (result.kind === "list") {
    if (result.count === 0) return "No memories found.";
    return result.results
      .map((row, i) =>
        [`[${i + 1}]`, ...Object.entries(row).map(([k, v]) => `  ${k}: ${v}`)].join("\n"),
      )
      .join("\n\n");
  }

  if (result.kind === "forget") {
    return result.git_error
      ? result.message + formatGitError(result.git_error)
      : result.message;
  }

  return JSON.stringify(result, null, 2);
}

// ---------------------------------------------------------------------------
// Testing exports
// ---------------------------------------------------------------------------

export const fileMemoryTesting = {
  BUG_REPORTING_URL,
  buildPassphrase,
  formatCliResult,
  resolveMemoryRoot,
  runCliCommand,
};

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

async function reportGitFailure(
  client: Parameters<Plugin>[0]["client"],
  operation: string,
  error: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const message = `git commit failed after ${operation}: ${error}`;
  await Promise.allSettled([
    client.app.log({
      body: {
        service: "opencode-memory-plugin",
        level: "error",
        message,
        extra: { operation, error, ...extra },
      },
    }),
    client.tui.showToast({
      body: {
        title: "Memory git error",
        message: `${operation}: git commit failed — ${error}`,
        variant: "error",
        duration: 10_000,
      },
    }),
  ]);
}

export const FileMemoryPlugin: Plugin = async ({ client }) => {
  return {
    tool: {
      remember: tool({
        description: withPassphrase(
          withPluginVersion(
            `Write a new memory to the git-backed file store.

## Store layout

Root: $OPENCODE_MEMORY_ROOT (default: ~/.local/share/opencode-memory)

  {root}/{project}/
    {id}-{timestamp}.md

"global" is the default project when the agent is not inside a git repo.
Each git repo gets its own project directory, named from the git root slug.

## File format

Each memory is a YAML-headered markdown file:

  ---
  id: mem_8k2j9x
  project: my-project-slug
  session_id: ses_abc123
  tags: [deploy, ops]
  ---
  Production deploy requires manual approval from @ops

## Reading memories

Memories are plain files — search them directly with:

  Semantic search (recommended):
    npx -y -p @llamaindex/semtools semtools search "deploy steps" {root}/**/*.md

  Keyword search:
    grep -rl "nginx" {root}/

  Read a file:
    cat {path}

## Project

Memories are filed under the git-root slug of the current working directory.
Pass project: "global" to force global storage regardless of git repo context.

## Session tracking

Omit session_id to use the current OpenCode session ID automatically.

Example:
  content: "Production deploy requires manual approval from @ops"
  tags: ["deploy", "ops"]`,
          ),
          "remember",
          "visible",
        ),
        args: {
          content: tool.schema
            .string()
            .describe("Memory content (markdown text, any length)"),
          project: tool.schema
            .string()
            .optional()
            .describe("'global' to force global storage. Omit to auto-detect from working directory."),
          session_id: tool.schema
            .string()
            .optional()
            .describe(
              "Session ID stored as provenance metadata. Defaults to the current OpenCode session.",
            ),
          tags: tool.schema
            .array(tool.schema.string())
            .optional()
            .describe("Tags for filtering, e.g. [\"deploy\", \"ops\"]"),
        },
        async execute(args, context) {
          const project = args.project;
          const sessionId = args.session_id ?? context.sessionID;

          await context.ask({
            permission: "remember",
            patterns: [args.content.slice(0, 120)],
            always: ["*"],
            metadata: { project, sessionId },
          });

          const cliArgs = [
            "remember",
            "--content",
            args.content,
            "--cwd",
            process.cwd(),
          ];
          if (project) cliArgs.push("--project", project);
          if (sessionId) cliArgs.push("--session-id", sessionId);
          if (args.tags?.length) {
            for (const t of args.tags) cliArgs.push("--tag", t);
          }

          const memoryRoot = resolveMemoryRoot();
          const result = await runCliCommand(cliArgs, {
            ...process.env,
            OPENCODE_MEMORY_ROOT: memoryRoot,
          });

          if (result.ok && result.kind === "remember") {
            if (result.git_error) {
              await reportGitFailure(client, "remember", result.git_error, {
                id: result.id,
                path: result.path,
              });
            }
            context.metadata({
              title: "Saved memory",
              metadata: { id: result.id, project: result.project },
            });
          }

          return withPassphrase(formatCliResult(result), "remember", "execute");
        },
      }),

      list_memories: tool({
        description: withPassphrase(
          withPluginVersion(
            `Query memory metadata using SQL. Accepts standard SQL SELECT queries.

All memory frontmatter is loaded into an in-memory SQLite table. Results include
the absolute file path so you can read memory content directly.

Schema:

  CREATE TABLE memories (
    id         TEXT,
    path       TEXT,    -- absolute path to the .md file
    project    TEXT,    -- "global" or a git-root slug
    session_id TEXT,
    tags       TEXT,    -- JSON array, e.g. '["deploy","ops"]'
    mtime      TEXT     -- ISO 8601 from filesystem mtime
  )`,
          ),
          "list_memories",
          "visible",
        ),
        args: {
          sql: tool.schema
            .string()
            .describe("SQL SELECT query against the memories table"),
        },
        async execute(args, context) {
          await context.ask({
            permission: "list_memories",
            patterns: [],
            always: ["*"],
            metadata: { sql: args.sql },
          });

          const memoryRoot = resolveMemoryRoot();
          const result = await runCliCommand(["list", "--sql", args.sql], {
            ...process.env,
            OPENCODE_MEMORY_ROOT: memoryRoot,
          });

          if (result.ok && result.kind === "list") {
            context.metadata({
              title: "Listed memories",
              metadata: { count: result.count },
            });
          }

          return withPassphrase(formatCliResult(result), "list_memories", "execute");
        },
      }),

      forget: tool({
        description: withPassphrase(
          withPluginVersion(
            `Delete a memory permanently by ID. Use this instead of direct file deletion to keep the git history intact.

The deletion is committed to the memory git repo for auditability.
Obtain the ID from list_memories or by reading a memory file's frontmatter.

Example:
  id: "mem_abc123"`,
          ),
          "forget",
          "visible",
        ),
        args: {
          id: tool.schema
            .string()
            .describe("Memory ID to delete (e.g. mem_abc123). Obtain from list_memories or memory file frontmatter."),
        },
        async execute(args, context) {
          await context.ask({
            permission: "forget",
            patterns: [args.id],
            always: ["*"],
            metadata: { id: args.id },
          });

          const cliArgs = ["forget", "--id", args.id];
          const memoryRoot = resolveMemoryRoot();
          const result = await runCliCommand(cliArgs, {
            ...process.env,
            OPENCODE_MEMORY_ROOT: memoryRoot,
          });

          if (result.ok && result.kind === "forget") {
            if (result.git_error) {
              await reportGitFailure(client, "forget", result.git_error, {
                id: args.id,
              });
            }
            context.metadata({
              title: "Deleted memory",
              metadata: { id: args.id },
            });
          }

          return withPassphrase(formatCliResult(result), "forget", "execute");
        },
      }),
    },
  };
};
