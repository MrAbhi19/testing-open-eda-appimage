import OpenAI from "openai";
import fs from "node:fs/promises";
import path from "node:path";

const client = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY!,
});

const MODEL = process.env.MODEL || "nvidia/nemotron-nano-9b-v2:free";
const PROMPT = process.env.PROMPT || "";
const MAX_ITER = 20;
const API_DELAY_MS = Number(process.env.API_DELAY_MS || 90000);
const RETRY_DELAY_MS = Number(process.env.RETRY_DELAY_MS || 180000);
const MAX_RETRIES = 5;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
      return (
        entries
          .filter((e) => e.name !== "node_modules" && e.name !== ".git")
          .map((e) => (e.isDirectory() ? e.name + "/" : e.name))
          .join("\n") || "(empty)"
      );
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
    console.log(`Sleeping ${API_DELAY_MS / 1000}s before API call...`);
    await sleep(API_DELAY_MS);

    let res: any = null;
    let attempt = 0;

    while (attempt < MAX_RETRIES) {
      attempt++;
      try {
        res = await client.chat.completions.create({
          model: MODEL,
          messages,
          tools,
          tool_choice: "auto",
        });

        if (!res?.choices?.length) {
          console.error(
            `No choices (attempt ${attempt}):`,
            JSON.stringify(res).slice(0, 400)
          );
          if (attempt < MAX_RETRIES) {
            console.log(`Retrying in ${RETRY_DELAY_MS / 1000}s...`);
            await sleep(RETRY_DELAY_MS);
            continue;
          }
          console.log("Giving up on this iteration.");
          return;
        }

        break; // success
      } catch (e: any) {
        const status = e?.status;
        console.error(`API error (attempt ${attempt}):`, status, e?.message);

        if (
          (status === 429 || status === 502 || status === 503) &&
          attempt < MAX_RETRIES
        ) {
          console.log(
            `Rate/availability error, retrying in ${RETRY_DELAY_MS / 1000}s...`
          );
          await sleep(RETRY_DELAY_MS);
          continue;
        }

        throw e;
      }
    }

    if (!res?.choices?.length) {
      console.log("No usable response. Stopping.");
      return;
    }

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
        content: result.slice(0, 8000),
      });
    }
  }

  console.log("⚠️ Hit max iterations, stopping.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});