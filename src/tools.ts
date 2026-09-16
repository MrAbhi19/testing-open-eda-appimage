import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";

export const ROOT = process.cwd();

export function safe(p: string): string {
  const abs = path.resolve(ROOT, p);
  if (!abs.startsWith(ROOT)) throw new Error("Path escapes repo: " + p);
  return abs;
}

export const ToolSchemas = {
  list_files: z.object({
    dir: z.string().default(".").describe("e.g. '.' or 'src'"),
  }),
  read_file: z.object({
    path: z.string().describe("Path to file relative to repo root"),
  }),
  write_file: z.object({
    path: z.string().describe("Path to file relative to repo root"),
    content: z.string().describe("Content to write"),
  }),
  delete_file: z.object({
    path: z.string().describe("Path to file relative to repo root"),
  }),
  done: z.object({
    summary: z.string().describe("Summary of what was accomplished"),
  }),
};

export type ListFilesArgs = z.infer<typeof ToolSchemas.list_files>;
export type ReadFileArgs = z.infer<typeof ToolSchemas.read_file>;
export type WriteFileArgs = z.infer<typeof ToolSchemas.write_file>;
export type DeleteFileArgs = z.infer<typeof ToolSchemas.delete_file>;
export type DoneArgs = z.infer<typeof ToolSchemas.done>;

export type ToolArgs = ListFilesArgs | ReadFileArgs | WriteFileArgs | DeleteFileArgs | DoneArgs;

export interface ToolResult {
  success: boolean;
  content: string;
  isDone?: boolean;
  summary?: string;
}

export async function runTool(name: string, args: unknown): Promise<ToolResult> {
  try {
    switch (name) {
      case "list_files": {
        const parsed = ToolSchemas.list_files.parse(args);
        const dir = safe(parsed.dir || ".");
        const entries = await fs.readdir(dir, { withFileTypes: true });
        const filtered = entries.filter(
          (e) => e.name !== "node_modules" && e.name !== ".git"
        );
        return {
          success: true,
          content: filtered.length > 0
            ? filtered.map((e) => (e.isDirectory() ? e.name + "/" : e.name)).join("\n")
            : "(empty)",
        };
      }
      case "read_file": {
        const parsed = ToolSchemas.read_file.parse(args);
        const content = await fs.readFile(safe(parsed.path), "utf8");
        return { success: true, content };
      }
      case "write_file": {
        const parsed = ToolSchemas.write_file.parse(args);
        const abs = safe(parsed.path);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, parsed.content, "utf8");
        return { success: true, content: `Wrote ${parsed.path} (${parsed.content.length} bytes)` };
      }
      case "delete_file": {
        const parsed = ToolSchemas.delete_file.parse(args);
        await fs.unlink(safe(parsed.path));
        return { success: true, content: `Deleted ${parsed.path}` };
      }
      case "done": {
        const parsed = ToolSchemas.done.parse(args);
        return { success: true, content: "__DONE__", isDone: true, summary: parsed.summary };
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
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
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