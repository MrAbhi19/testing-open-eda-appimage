import OpenAI from "openai";
import fs from "node:fs/promises";
import path from "node:path";

const client = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.STARK!,
});

const MODEL = process.env.MODEL || "anthropic/claude-3.5-sonnet";
const PROMPT = process.env.PROMPT || "";
const MAX_ITER = 20;

// ---------- tools ----------
const tools = [
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

// ---------- tool executors ----------
const ROOT = process.cwd();

function safe(p: string) {
  const abs = path.resolve(ROOT, p);
  if (!abs.startsWith(ROOT)) throw new Error("Path escapes repo: " + p);
  return abs;
}

async function runTool(name: string, args: any): Promise<string> {
  try {
    if (name === "list_files") {
      const dir = safe(args.dir || ".");
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return entries
        .filter((e) => e.name !== "node_modules" && e.name !== ".git")
        .map((e) => (e.isDirectory() ? e.name + "/" : e.name))
        .join("\n");
    }
    if (name === "read_file") {
      return await fs.readFile(safe(args.path), "utf8");
    }
    if (name === "write_file") {
      const abs = safe(args.path);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, args.content, "utf8");
      return `Wrote ${args.path} (${args.content.length} bytes)`;
    }
    if (name === "delete_file") {
      await fs.unlink(safe(args.path));
      return `Deleted ${args.path}`;
    }
    if (name === "done") {
      return "__DONE__ " + (args.summary || "");
    }
    return "Unknown tool: " + name;
  } catch (e: any) {
    return "ERROR: " + e.message;
  }
}

// ---------- agent loop ----------
async function main() {
  if (!PROMPT) throw new Error("PROMPT is empty");

  const messages: any[] = [
    {
      role: "system",
      content:
        "You are an autonomous coding agent working inside a git repo. " +
        "You can read, write, and delete files using tools. " +
        "Work step by step. Prefer small, focused changes. " +
        "When finished, call the `done` tool with a summary. " +
        "Do not ask the user questions — make reasonable assumptions and proceed.",
    },
    { role: "user", content: PROMPT },
  ];

  for (let i = 0; i < MAX_ITER; i++) {
    console.log(`\n--- iteration ${i + 1} ---`);

    const res = await client.chat.completions.create({
      model: MODEL,
      messages,
      tools,
      tool_choice: "auto",
    });

    const res = await client.chat.completions.create({ ... });
    console.log("RAW RESPONSE:", JSON.stringify(res, null, 2));
    const msg = res.choices?.[0]?.message;
    if (!msg) { console.error("No choices in response"); process.exit(1); }

    const msg = res.choices[0].message;
    messages.push(msg);

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      console.log("Agent stopped without calling done. Content:", msg.content);
      return;
    }

    for (const call of msg.tool_calls) {
      const args = JSON.parse(call.function.arguments || "{}");
      console.log(`→ ${call.function.name}`, args);

      const result = await runTool(call.function.name, args);

      if (call.function.name === "done") {
        console.log("\n✅ Agent finished:", result.replace("__DONE__ ", ""));
        return;
      }

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: result.slice(0, 8000), // avoid blowing context
      });
    }
  }

  console.log("⚠️ Hit max iterations, stopping.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
