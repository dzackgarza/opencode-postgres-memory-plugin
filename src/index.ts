import { type Plugin, tool } from "@opencode-ai/plugin";
import { $ } from "bun";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pkg from "../package.json" assert { type: "json" };

const PLUGIN_VERSION = pkg.version;
const BUG_REPORTING_URL =
  "https://github.com/dzackgarza/opencode-postgres-memory-plugin/issues/new?labels=bug";
const MEMORY_ROOT_ENV = "OPENCODE_MEMORY_ROOT";
const MEMORY_SEED_ENV = "OPENCODE_MEMORY_TEST_SEED";
const ISSUE_REPORTING_HINT = `If this looks like a plugin/runtime bug, file a GitHub issue tagged \`bug\`: ${BUG_REPORTING_URL}`;

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

type MemoryRecord = {
  id?: string;
  scope?: string;
  session_id?: string | null;
  project?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  content?: string;
  path?: string;
  created_at?: string;
  distance?: number;
};

type RememberSuccess = {
  ok: true;
  kind: "remember";
  id: string;
  path: string;
  scope: string;
  project: string;
};

type RecallSuccess = {
  ok: true;
  kind: "recall";
  results: MemoryRecord[];
  count: number;
};

type ListSuccess = {
  ok: true;
  kind: "list";
  results: MemoryRecord[];
  count: number;
};

type ForgetSuccess = {
  ok: true;
  kind: "forget";
  id: string;
  message: string;
};

type CliFailure = {
  ok: false;
  stage: string;
  message: string;
  detail?: string;
};

type CliResult =
  | RememberSuccess
  | RecallSuccess
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
    join(env.HOME ?? "~", ".local", "share");
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
    return `Saved: ${result.id} (${result.scope}) → ${result.path}`;
  }

  if (result.kind === "recall" || result.kind === "list") {
    if (result.count === 0) return "No memories found.";
    return result.results
      .map((m, i) => {
        const header = `[${i + 1}] ${m.id ?? "?"}${m.distance !== undefined ? ` (distance: ${m.distance.toFixed(3)})` : ""}`;
        const tags = m.tags?.length ? `tags: ${m.tags.join(", ")}` : undefined;
        return [header, tags, m.content].filter(Boolean).join("\n");
      })
      .join("\n\n---\n\n");
  }

  if (result.kind === "forget") {
    return result.message;
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

export const FileMemoryPlugin: Plugin = async () => {
  return {
    tool: {
      remember: tool({
        description: withPassphrase(
          withPluginVersion(
            `Use when you need to save a fact, note, or context for future recall.

Stores the content as a YAML-headered markdown file in a git-backed memory store.

Project scoping (automatic):
  - Memories are filed under the git-root of the current working directory.
  - If the agent is not in a git repo, memories go to the global scope automatically.

Scope override:
  - scope: "global" — force global storage regardless of git repo context.

Session tracking:
  - Pass session_id to tag the memory with a session for later filtering.

Example: save a deploy note for later recall
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
          scope: tool.schema
            .string()
            .optional()
            .describe("'global' to force global scope. Omit to auto-detect project from working directory."),
          session_id: tool.schema
            .string()
            .optional()
            .describe(
              "Session ID stored as metadata for later filtering. Defaults to the current OpenCode session.",
            ),
          tags: tool.schema
            .array(tool.schema.string())
            .optional()
            .describe("Tags for filtering, e.g. [\"deploy\", \"ops\"]"),
          metadata: tool.schema
            .string()
            .optional()
            .describe("JSON object for arbitrary key-value metadata, e.g. '{\"topic\":\"infra\"}'"),
        },
        async execute(args, context) {
          const scope = args.scope;
          const sessionId = args.session_id ?? context.sessionID;

          await context.ask({
            permission: "remember",
            patterns: [args.content.slice(0, 120)],
            always: ["*"],
            metadata: { scope, sessionId },
          });

          const cliArgs = [
            "remember",
            "--content",
            args.content,
            "--cwd",
            process.cwd(),
          ];
          if (scope) cliArgs.push("--scope", scope);
          if (sessionId) cliArgs.push("--session-id", sessionId);
          if (args.tags?.length) {
            for (const t of args.tags) cliArgs.push("--tag", t);
          }
          if (args.metadata) cliArgs.push("--metadata", args.metadata);

          const memoryRoot = resolveMemoryRoot();
          const result = await runCliCommand(cliArgs, {
            ...process.env,
            OPENCODE_MEMORY_ROOT: memoryRoot,
          });

          if (result.ok && result.kind === "remember") {
            context.metadata({
              title: "Saved memory",
              metadata: { id: result.id, scope: result.scope, project: result.project },
            });
          }

          return withPassphrase(formatCliResult(result), "remember", "execute");
        },
      }),

      recall: tool({
        description: withPassphrase(
          withPluginVersion(
            `Use when you need to find previously stored memories about a topic.

Performs semantic search over memories using semtools. Returns the closest matches by meaning.

Scope:
  - Omit scope to search all memories for the current project (auto-detected from working directory).
  - scope: "global" searches only global memories.

Example: find notes about deployment
  query: "production deployment steps"`,
          ),
          "recall",
          "visible",
        ),
        args: {
          query: tool.schema
            .string()
            .describe("Natural language search query"),
          scope: tool.schema
            .string()
            .optional()
            .describe("'global' to restrict to global memories. Omit to search current project."),
          session_id: tool.schema
            .string()
            .optional()
            .describe("Filter to memories from a specific session."),
          limit: tool.schema
            .number()
            .optional()
            .describe("Maximum number of results (default: 5)"),
        },
        async execute(args, context) {
          const scope = args.scope;
          const sessionId = args.session_id;

          await context.ask({
            permission: "recall",
            patterns: [args.query],
            always: ["*"],
            metadata: { scope, sessionId },
          });

          const cliArgs = [
            "recall",
            args.query,
            "--cwd",
            process.cwd(),
          ];
          if (scope) cliArgs.push("--scope", scope);
          if (sessionId) cliArgs.push("--session-id", sessionId);
          if (args.limit != null) cliArgs.push("--limit", String(args.limit));

          const memoryRoot = resolveMemoryRoot();
          const result = await runCliCommand(cliArgs, {
            ...process.env,
            OPENCODE_MEMORY_ROOT: memoryRoot,
          });

          if (result.ok && result.kind === "recall") {
            context.metadata({
              title: "Recalled memories",
              metadata: { query: args.query, count: result.count },
            });
          }

          return withPassphrase(formatCliResult(result), "recall", "execute");
        },
      }),

      list_memories: tool({
        description: withPassphrase(
          withPluginVersion(
            `Use when you need to browse or filter stored memories by scope, session, or tag.

Returns a list of memories in reverse chronological order (most recent first).

Example: list all global memories tagged "deploy"
  scope: "global"
  tag: "deploy"`,
          ),
          "list_memories",
          "visible",
        ),
        args: {
          scope: tool.schema
            .string()
            .optional()
            .describe("'global' to list only global memories. Omit to list current project or all."),
          session_id: tool.schema
            .string()
            .optional()
            .describe("Filter to memories from a specific session."),
          tag: tool.schema
            .string()
            .optional()
            .describe("Filter by tag name"),
          limit: tool.schema
            .number()
            .optional()
            .describe("Maximum number of results (default: 50)"),
        },
        async execute(args, context) {
          const scope = args.scope;
          const sessionId = args.session_id;

          await context.ask({
            permission: "list_memories",
            patterns: [],
            always: ["*"],
            metadata: { scope, sessionId, tag: args.tag },
          });

          const cliArgs = ["list", "--cwd", process.cwd()];
          if (scope) cliArgs.push("--scope", scope);
          if (sessionId) cliArgs.push("--session-id", sessionId);
          if (args.tag) cliArgs.push("--tag", args.tag);
          if (args.limit != null) cliArgs.push("--limit", String(args.limit));

          const memoryRoot = resolveMemoryRoot();
          const result = await runCliCommand(cliArgs, {
            ...process.env,
            OPENCODE_MEMORY_ROOT: memoryRoot,
          });

          if (result.ok && result.kind === "list") {
            context.metadata({
              title: "Listed memories",
              metadata: { scope, count: result.count },
            });
          }

          return withPassphrase(formatCliResult(result), "list_memories", "execute");
        },
      }),

      forget: tool({
        description: withPassphrase(
          withPluginVersion(
            `Use when a stored memory is outdated, incorrect, or no longer needed.

Deletes the memory permanently by its ID. Obtain the ID from recall or list_memories.
The deletion is committed to the memory git repo for auditability.

Example: delete a memory with id "mem_abc123"
  id: "mem_abc123"`,
          ),
          "forget",
          "visible",
        ),
        args: {
          id: tool.schema
            .string()
            .describe("Memory ID to delete (e.g. mem_abc123). Obtain from recall or list_memories."),
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
