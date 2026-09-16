import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export const ROOT = process.cwd();

export function safe(p: string): string {
  const abs = path.resolve(ROOT, p);
  if (!abs.startsWith(ROOT)) throw new Error("Path escapes repo: " + p);
  return abs;
}

// Whitelist — command must match at least one of these patterns.
const ALLOWED: RegExp[] = [
  /^npm (install|ci|test|ls|run [\w:-]+)( .*)?$/,
  /^npx (tsc|tsx|vitest|jest|eslint|prettier)( .*)?$/,
  /^node --version$/,
  /^git (status|diff|log|branch|show)( .*)?$/,
  /^ls( [\w./*-]+)*$/,
  /^cat [\w./-]+$/,
  /^pwd$/,
];

function isAllowed(cmd: string): boolean {
  const trimmed = cmd.trim();
  return ALLOWED.some((re) => re.test(trimmed));
}

export const ToolSchemas = {
  list_files: z.object({ dir: z.string().default(".") }),
  read_file: z.object({ path: z.string() }),
  write_file: z.object({ path: z.string(), content: z.string() }),
  delete_file: z.object({ path: z.string() }),
  run_command: z.object({
    command: z.string().describe("Shell command (whitelisted, e.g. 'npm run typecheck')"),
  }),
  done: z.object({ summary: z.string() }),
};

export type ToolResult = {
  success: boolean;
  content: string;
  isDone?: boolean;
  summary?: string;
};

export async function runTool(
  name: string,
  args: unknown,
  timeoutMs = 30000
): Promise<ToolResult> {
  try {
    switch (name) {
      case "list_files": {
        const { dir } = ToolSchemas.list_files.parse(args);
        const entries = await fs.readdir(safe(dir || "."), { withFileTypes: true });
        const filtered = entries.filter(
          (e) => e.name !== "node_modules" && e.name !== ".git"
        );
        return {
          success: true,
          content:
            filtered.length > 0
              ? filtered
                  .map((e) => (e.isDirectory() ? e.name + "/" : e.name))
                  .join("\n")
              : "(empty)",
        };
      }
      case "read_file": {
        const { path: p } = ToolSchemas.read_file.parse(args);
        const content = await fs.readFile(safe(p), "utf8");
        return { success: true, content };
      }
      case "write_file": {
        const { path: p, content } = ToolSchemas.write_file.parse(args);
        const abs = safe(p);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, content, "utf8");
        return { success: true, content: `Wrote ${p} (${content.length} bytes)` };
      }
      case "delete_file": {
        const { path: p } = ToolSchemas.delete_file.parse(args);
        await fs.unlink(safe(p));
        return { success: true, content: `Deleted ${p}` };
      }
      case "run_command": {
        const { command } = ToolSchemas.run_command.parse(args);
        if (!isAllowed(command)) {
          return {
            success: false,
            content: `Command not allowed by whitelist: ${command}`,
          };
        }
        try {
          const { stdout, stderr } = await execAsync(command, {
            cwd: ROOT,
            timeout: timeoutMs,
            maxBuffer: 4 * 1024 * 1024,
          });
          const out = (stdout + (stderr ? "\n[stderr]\n" + stderr : "")).slice(0, 8000);
          return { success: true, content: out || "(no output)" };
        } catch (e: any) {
          const out = `${e.stdout || ""}\n${e.stderr || ""}\n${e.message || ""}`.slice(0, 8000);
          return { success: false, content: `Command failed:\n${out}` };
        }
      }
      case "done": {
        const { summary } = ToolSchemas.done.parse(args);
        return { success: true, content: "__DONE__", isDone: true, summary };
      }
      default:
        return { success: false, content: `Unknown tool: ${name}` };
    }
  } catch (error: any) {
    return { success: false, content: `ERROR: ${error.message}` };
  }
}

export const toolDefinitions = [
  {
    type: "function" as const,
    function: {
      name: "list_files",
      description: "List files in a directory (relative to repo root).",
      parameters: {
        type: "object",
        properties: { dir: { type: "string", description: "e.g. '.' or 'src'" } },
        required: ["dir"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "read_file",
      description: "Read the full contents of a file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "write_file",
      description: "Create or overwrite a file with the given content.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "delete_file",
      description: "Delete a file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "run_command",
      description:
        "Run a whitelisted shell command to verify your changes. Allowed: npm install/ci/test/ls/run, npx tsc/tsx/vitest/eslint/prettier, git status/diff/log/branch/show, ls, cat, pwd. Use this to run typecheck/tests after editing.",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "done",
      description: "Call when the task is complete. Provide a short summary.",
      parameters: {
        type: "object",
        properties: { summary: { type: "string" } },
        required: ["summary"],
      },
    },
  },
];
