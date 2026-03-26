import Anthropic from "@anthropic-ai/sdk";

// ─── Concurrency semaphore ────────────────────────────────────

const MAX_CONCURRENT = parseInt(process.env.CLAUDE_CONCURRENCY ?? "4");
let activeProcs = 0;
const waitQueue: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  if (activeProcs < MAX_CONCURRENT) {
    activeProcs++;
    return Promise.resolve();
  }
  return new Promise(resolve => waitQueue.push(resolve));
}

function releaseSlot(): void {
  const next = waitQueue.shift();
  if (next) {
    next();
  } else {
    activeProcs--;
  }
}

let totalCalls = 0;
let totalTokensEstimated = 0;

export function getLLMStats() {
  return { totalCalls, totalTokensEstimated };
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ─── Model resolution ─────────────────────────────────────────

const SDK_MODEL_MAP: Record<string, string> = {
  haiku:  "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-4-6",
  opus:   "claude-opus-4-6",
};

// Short aliases → OpenRouter default model IDs (overridable via env)
function resolveOpenRouterModel(shortOrFull?: string): string {
  const global = process.env.OPENROUTER_MODEL;
  if (!shortOrFull) return global ?? "anthropic/claude-haiku-4-5-20251001";

  if (shortOrFull.includes("/")) return shortOrFull;

  const envKey = `OPENROUTER_MODEL_${shortOrFull.toUpperCase()}`;
  if (process.env[envKey]) return process.env[envKey]!;

  if (global) return global;

  const defaults: Record<string, string> = {
    haiku:  "anthropic/claude-haiku-4-5-20251001",
    sonnet: "anthropic/claude-sonnet-4-6",
    opus:   "anthropic/claude-opus-4-6",
  };
  return defaults[shortOrFull] ?? shortOrFull;
}

// ─── Anthropic SDK backend ───────────────────────────────────

const anthropicClient = new Anthropic({
  apiKey: process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || "",
  baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
});

async function callSDK(
  prompt: string,
  options?: { model?: string; onChunk?: (chunk: string) => void },
): Promise<string> {
  const modelId = options?.model
    ? (SDK_MODEL_MAP[options.model] ?? options.model)
    : SDK_MODEL_MAP.haiku!;

  await acquireSlot();

  try {
    const stream = anthropicClient.messages.stream({
      model: modelId,
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    });

    let fullText = "";

    stream.on("text", (text) => {
      fullText += text;
      options?.onChunk?.(text);
    });

    await stream.finalMessage();

    totalCalls++;
    totalTokensEstimated += estimateTokens(prompt) + estimateTokens(fullText);

    const result = fullText.trim();
    if (!result) throw new Error("Empty response from Anthropic SDK");
    return result;
  } finally {
    releaseSlot();
  }
}

// ─── OpenRouter backend ───────────────────────────────────────

async function callOpenRouter(
  prompt: string,
  options?: { model?: string; onChunk?: (chunk: string) => void },
): Promise<string> {
  const modelId = resolveOpenRouterModel(options?.model);
  await acquireSlot();

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "X-Title": "Brunnfeld Simulation",
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: prompt }],
        stream: true,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OpenRouter ${res.status}: ${err.slice(0, 200)}`);
    }

    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let fullText = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") continue;

        try {
          const event = JSON.parse(data) as Record<string, unknown>;
          const choices = event.choices as Array<Record<string, unknown>>;
          const delta = choices?.[0]?.delta as Record<string, unknown> | undefined;
          const content = delta?.content as string | undefined;
          if (content) {
            fullText += content;
            options?.onChunk?.(content);
          }
        } catch { /* non-JSON line */ }
      }
    }

    totalCalls++;
    totalTokensEstimated += estimateTokens(prompt) + estimateTokens(fullText);

    const result = fullText.trim();
    if (!result) throw new Error("Empty response from OpenRouter");
    return result;
  } finally {
    releaseSlot();
  }
}

// ─── Public API ───────────────────────────────────────────────

export function usingOpenRouter(): boolean {
  return !!process.env.OPENROUTER_API_KEY;
}

export async function callClaude(
  prompt: string,
  options?: { model?: string; onChunk?: (chunk: string) => void },
): Promise<string> {
  return usingOpenRouter()
    ? callOpenRouter(prompt, options)
    : callSDK(prompt, options);
}

// Strip <think>...</think> blocks (MiniMax M2.x, DeepSeek R1, etc.)
function stripThinkTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

export async function callClaudeJSON<T>(
  prompt: string,
  options?: { model?: string; onChunk?: (chunk: string) => void },
): Promise<T> {
  const raw = await callClaude(prompt, options);

  let jsonStr = stripThinkTags(raw).trim();
  if (jsonStr.startsWith("```")) {
    jsonStr = jsonStr.replace(/^```[a-z]*\n?/i, "").replace(/\n?```\s*$/, "");
  }
  const jsonStart = jsonStr.indexOf("{");
  if (jsonStart > 0) jsonStr = jsonStr.substring(jsonStart);
  const lastBrace = jsonStr.lastIndexOf("}");
  if (lastBrace >= 0 && lastBrace < jsonStr.length - 1) jsonStr = jsonStr.substring(0, lastBrace + 1);

  try {
    return JSON.parse(jsonStr) as T;
  } catch {
    const retryPrompt = `The following was supposed to be valid JSON but isn't. Return ONLY the corrected JSON object, no markdown:\n\n${raw}`;
    const retryRaw = await callClaude(retryPrompt, { model: options?.model });

    let retryStr = stripThinkTags(retryRaw).trim();
    if (retryStr.startsWith("```")) {
      retryStr = retryStr.replace(/^```[a-z]*\n?/i, "").replace(/\n?```\s*$/, "");
    }
    const retryStart = retryStr.indexOf("{");
    if (retryStart > 0) retryStr = retryStr.substring(retryStart);
    const retryBrace = retryStr.lastIndexOf("}");
    if (retryBrace >= 0) retryStr = retryStr.substring(0, retryBrace + 1);

    return JSON.parse(retryStr) as T;
  }
}
