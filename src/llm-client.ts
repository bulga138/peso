/**
 * LLM Client — calls the small model to enhance prompts.
 *
 * PRIMARY PATH (plugin): uses the OpenCode SDK client directly.
 *   - client.session.create() → ephemeral session
 *   - client.session.prompt()  → sends prompt with model override + tools disabled
 *   - client.session.delete()  → cleanup
 *   No HTTP plumbing, no key/URL management — OpenCode handles it.
 *
 * FALLBACK PATH (CLI / no client): direct HTTP to the provider API.
 *   - Reads small_model + provider config from opencode.json
 *   - Resolves {env:VAR} templates for key and baseURL
 *   - Supports OpenAI-compatible and Anthropic Messages API
 *
 * Model resolution order:
 *   1. PESO_MODEL env var
 *   2. small_model in opencode.json
 *   3. Fallback: opencode/zen (free, always available)
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { createOpencodeClient } from "@opencode-ai/sdk";
import { loadPesoConfig } from "./config.js";

export type SdkClient = ReturnType<typeof createOpencodeClient>;

export interface LlmConfig {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
}

export interface LlmResponse {
  text: string;
  usage?: { promptTokens: number; completionTokens: number };
}

// ---------------------------------------------------------------------------
// Config helpers (shared by both paths)
// ---------------------------------------------------------------------------
function readOpencodeConfig(): Record<string, unknown> | null {
  const locations = [
    join(process.cwd(), "opencode.json"),
    join(process.cwd(), "opencode.jsonc"),
    join(homedir(), ".config", "opencode", "opencode.json"),
    join(homedir(), ".config", "opencode", "opencode.jsonc"),
  ];
  for (const loc of locations) {
    if (existsSync(loc)) {
      try {
        const raw = readFileSync(loc, "utf8");
        // Try plain JSON first (avoids mangling URLs that contain // inside string values)
        try {
          return JSON.parse(raw);
        } catch {
          // Fallback: strip JSONC comments then retry
          const clean = raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
          return JSON.parse(clean);
        }
      } catch {
        continue;
      }
    }
  }
  return null;
}

function resolveEnvTemplate(value: string): string {
  return value.replace(/\{env:([^}]+)\}/g, (_, name) => process.env[name] || "");
}

function parseModelString(modelStr: string): { provider: string; model: string } {
  const parts = modelStr.split("/");
  return parts.length >= 2
    ? { provider: parts[0], model: parts.slice(1).join("/") }
    : { provider: "openai", model: modelStr };
}

export function resolveModelName(): string {
  if (process.env.PESO_MODEL) return process.env.PESO_MODEL;
  const cfg = readOpencodeConfig();
  if (cfg?.small_model) return cfg.small_model as string;
  // No explicit config — caller should use resolveModelNameFromSdk() via the SDK client
  // This fallback is only used by the CLI path
  return (cfg?.model as string | undefined) || "opencode/zen";
}

/**
 * Resolve the small model via the OpenCode SDK config.
 * Uses OpenCode's own resolution: small_model → provider's cheap model → main model.
 * Example: if provider is anthropic, OpenCode picks claude-haiku automatically.
 */
export async function resolveModelNameFromSdk(client: SdkClient): Promise<string> {
  if (process.env.PESO_MODEL) return process.env.PESO_MODEL;
  try {
    const result = await client.config.get();
    const cfg = result.data;
    if (cfg?.small_model) return cfg.small_model;
    if (cfg?.model)       return cfg.model;
  } catch {
    // fall through
  }
  return resolveModelName();
}

export function resolveConfig(): LlmConfig {
  const modelStr = resolveModelName();
  const { provider, model } = parseModelString(modelStr);

  const cfg = readOpencodeConfig();
  const providerEntry = (cfg?.provider as Record<string, any> | undefined)?.[provider];

  // Resolution: PESO env → peso.json options → opencode.json provider → provider env var
  const pesoConfig = loadPesoConfig();

  let apiKey = process.env.PESO_API_KEY || "";
  if (!apiKey && pesoConfig.options?.apiKey) apiKey = pesoConfig.options.apiKey;
  if (!apiKey && providerEntry?.options?.apiKey)
    apiKey = resolveEnvTemplate(providerEntry.options.apiKey);
  if (!apiKey)
    apiKey = process.env[PROVIDER_ENV_KEYS[provider] || ""] || "";

  let baseUrl = process.env.PESO_BASE_URL || "";
  if (!baseUrl && pesoConfig.options?.baseURL) baseUrl = pesoConfig.options.baseURL;
  if (!baseUrl && providerEntry?.options?.baseURL)
    baseUrl = resolveEnvTemplate(providerEntry.options.baseURL);
  if (!baseUrl)
    baseUrl = PROVIDER_BASE_URLS[provider] || "https://api.openai.com/v1";

  return { provider, model, apiKey, baseUrl };
}

const PROVIDER_BASE_URLS: Record<string, string> = {
  openai:      "https://api.openai.com/v1",
  anthropic:   "https://api.anthropic.com",
  google:      "https://generativelanguage.googleapis.com/v1beta",
  groq:        "https://api.groq.com/openai/v1",
  together:    "https://api.together.xyz/v1",
  deepseek:    "https://api.deepseek.com",
  mistral:     "https://api.mistral.ai/v1",
  openrouter:  "https://openrouter.ai/api/v1",
};

const PROVIDER_ENV_KEYS: Record<string, string> = {
  openai:      "OPENAI_API_KEY",
  anthropic:   "ANTHROPIC_API_KEY",
  google:      "GOOGLE_API_KEY",
  groq:        "GROQ_API_KEY",
  together:    "TOGETHER_API_KEY",
  deepseek:    "DEEPSEEK_API_KEY",
  mistral:     "MISTRAL_API_KEY",
  openrouter:  "OPENROUTER_API_KEY",
};

// ---------------------------------------------------------------------------
// PRIMARY PATH — SDK client
// ---------------------------------------------------------------------------
export async function callSmallModelViaSdk(
  client: SdkClient,
  systemPrompt: string,
  userMessage: string
): Promise<LlmResponse> {
  const modelStr = await resolveModelNameFromSdk(client);
  const { provider: providerID, model: modelID } = parseModelString(modelStr);

  // Create an ephemeral session for the enhancement call
  const createResult = await client.session.create({ body: { title: "peso-enhance" } });
  if (createResult.error) throw new Error(`PESO: session.create failed: ${JSON.stringify(createResult.error)}`);
  const sessionId = createResult.data!.id;

  try {
    const promptResult = await client.session.prompt({
      path: { id: sessionId },
      body: {
        model: { providerID, modelID },
        system: systemPrompt,
        tools: {},         // disable all tools — raw completion only
        parts: [{ type: "text", text: userMessage }],
      },
    });

    if (promptResult.error) throw new Error(`PESO: session.prompt failed: ${JSON.stringify(promptResult.error)}`);

    const parts = promptResult.data!.parts;
    const text = parts
      .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
      .map((p) => p.text)
      .join("");

    return { text: text.trim() };
  } finally {
    // Always clean up the ephemeral session
    client.session.delete({ path: { id: sessionId } }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// FALLBACK PATH — direct HTTP (used by CLI and when no SDK client)
// ---------------------------------------------------------------------------
async function callOpenAICompatible(cfg: LlmConfig, sys: string, user: string): Promise<LlmResponse> {
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: "system", content: sys }, { role: "user", content: user }],
      temperature: 0.3,
      max_tokens: 2048,
    }),
  });
  if (!res.ok) throw new Error(`LLM API error (${res.status}): ${await res.text()}`);
  const data = await res.json() as {
    choices: Array<{ message: { content: string } }>;
    usage?: { prompt_tokens: number; completion_tokens: number };
  };
  return {
    text: data.choices[0]?.message?.content || "",
    usage: data.usage
      ? { promptTokens: data.usage.prompt_tokens, completionTokens: data.usage.completion_tokens }
      : undefined,
  };
}

async function callAnthropic(cfg: LlmConfig, sys: string, user: string): Promise<LlmResponse> {
  const base = cfg.baseUrl.replace(/\/+$/, "");
  const url = base.endsWith("/v1") ? `${base}/messages` : `${base}/v1/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": cfg.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: cfg.model,
      system: sys,
      messages: [{ role: "user", content: user }],
      max_tokens: 2048,
      temperature: 0.3,
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API error (${res.status}): ${await res.text()}`);
  const data = await res.json() as {
    content: Array<{ text: string }>;
    usage?: { input_tokens: number; output_tokens: number };
  };
  return {
    text: data.content[0]?.text || "",
    usage: data.usage
      ? { promptTokens: data.usage.input_tokens, completionTokens: data.usage.output_tokens }
      : undefined,
  };
}

export async function callSmallModel(
  systemPrompt: string,
  userMessage: string,
  config?: LlmConfig
): Promise<LlmResponse> {
  const cfg = config || resolveConfig();
  if (!cfg.apiKey) {
    throw new Error(
      `No API key for "${cfg.provider}". Set PESO_API_KEY or ${PROVIDER_ENV_KEYS[cfg.provider] || "PROVIDER_API_KEY"}.`
    );
  }
  return cfg.provider === "anthropic"
    ? callAnthropic(cfg, systemPrompt, userMessage)
    : callOpenAICompatible(cfg, systemPrompt, userMessage);
}

export function describeConfig(): string {
  const cfg = resolveConfig();
  return `PESO model: ${cfg.provider}/${cfg.model} (key: ${cfg.apiKey ? "set" : "missing"})`;
}
