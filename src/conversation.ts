import fs from "node:fs/promises";
import path from "node:path";
import { ROOT } from "./tools.js";

export interface ConversationMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: any[];
  tool_call_id?: string;
  name?: string;
  timestamp: string;
  iteration?: number;
}

export interface ConversationMetadata {
  id: string;
  prompt: string;
  model: string;
  startedAt: string;
  updatedAt: string;
  iterations: number;
  status: "running" | "completed" | "failed" | "max_iterations";
  totalTokens?: number;
  estimatedCost?: number;
}

export interface Conversation {
  metadata: ConversationMetadata;
  messages: ConversationMessage[];
}

function getConversationDir(conversationDir: string): string {
  return path.resolve(ROOT, conversationDir);
}

export async function saveConversation(
  conversation: Conversation,
  conversationDir: string
): Promise<void> {
  const dir = getConversationDir(conversationDir);
  await fs.mkdir(dir, { recursive: true });
  
  const filePath = path.join(dir, `${conversation.metadata.id}.json`);
  await fs.writeFile(filePath, JSON.stringify(conversation, null, 2), "utf8");
}

export async function loadConversation(
  id: string,
  conversationDir: string
): Promise<Conversation | null> {
  const dir = getConversationDir(conversationDir);
  const filePath = path.join(dir, `${id}.json`);
  
  try {
    const content = await fs.readFile(filePath, "utf8");
    return JSON.parse(content) as Conversation;
  } catch {
    return null;
  }
}

export async function listConversations(conversationDir: string): Promise<ConversationMetadata[]> {
  const dir = getConversationDir(conversationDir);
  
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const conversations: ConversationMetadata[] = [];
    
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".json")) {
        try {
          const content = await fs.readFile(path.join(dir, entry.name), "utf8");
          const conv = JSON.parse(content) as Conversation;
          conversations.push(conv.metadata);
        } catch {
          // Skip invalid files
        }
      }
    }
    
    return conversations.sort((a, b) => 
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  } catch {
    return [];
  }
}

export function createConversation(prompt: string, model: string): Conversation {
  const id = `conv_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const now = new Date().toISOString();
  
  return {
    metadata: {
      id,
      prompt,
      model,
      startedAt: now,
      updatedAt: now,
      iterations: 0,
      status: "running",
    },
    messages: [],
  };
}

export function addMessage(
  conversation: Conversation,
  message: Omit<ConversationMessage, "timestamp">,
  iteration?: number
): void {
  conversation.messages.push({
    ...message,
    timestamp: new Date().toISOString(),
    iteration,
  });
  conversation.metadata.updatedAt = new Date().toISOString();
  if (iteration !== undefined) {
    conversation.metadata.iterations = iteration;
  }
}

export function updateConversationStatus(
  conversation: Conversation,
  status: ConversationMetadata["status"],
  totalTokens?: number,
  estimatedCost?: number
): void {
  conversation.metadata.status = status;
  conversation.metadata.updatedAt = new Date().toISOString();
  if (totalTokens !== undefined) conversation.metadata.totalTokens = totalTokens;
  if (estimatedCost !== undefined) conversation.metadata.estimatedCost = estimatedCost;
}