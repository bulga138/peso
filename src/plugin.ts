/**
 * PESO — OpenCode Plugin Entry Point
 *
 * Transparent prompt enhancement via two hooks:
 *  1. chat.message              — intercepts user prompt, runs pipeline, mutates parts
 *  2. experimental.chat.system.transform — injects PESO system prompt
 *
 * Agent classification:
 *  - Fetches real agent permissions from SDK (client.app.agents())
 *  - Permission-based compass: edit/bash deny→read-only→light; allow→write→full
 *  - Description text used as secondary specificity signal
 *
 * LLM rewrite:
 *  - Uses SDK client.session.prompt() with small model override — no raw HTTP
 *  - Ephemeral session created+deleted per call
 *
 * Opt-out: PESO_AUTO=0
 */

import type { Plugin } from '@opencode-ai/plugin';
import { tool } from '@opencode-ai/plugin';
import type { Agent } from '@opencode-ai/sdk';
import { classify, generateClarifyingQuestions } from './classifier.js';
import { runPipeline } from './enhancer.js';
import type { AgentPermissions } from './enhancer.js';
import { scorePrompt, formatScoreSummary } from './scorer.js';
import { gatherContext, formatContextBlock } from './context-gatherer.js';
import {
  callSmallModel,
  callSmallModelViaSdk,
  resolveConfig,
  resolveModelNameFromSdk,
  describeConfig,
  type SdkClient,
} from './llm-client.js';
import { autoSelectTechniques } from './techniques.js';
import type { Domain } from './classifier.js';
import type { EnhancementResult } from './enhancer.js';

// ---------------------------------------------------------------------------
// Session-scoped cache: chat.message → experimental.chat.system.transform
// ---------------------------------------------------------------------------
const sessionPipelineCache = new Map<string, EnhancementResult>();

// ---------------------------------------------------------------------------
// Agent cache: fetched once on init, refreshed lazily
// ---------------------------------------------------------------------------
let agentCache: Agent[] | null = null;

// Model-aware tool ID cache: keyed by "providerID/modelID" (or "" for unknown)
const toolIdsCacheByModel = new Map<string, string[]>();

import { loadPesoConfig, type PesoConfig } from './config.js';

type PesoMode = 'on' | 'passive' | 'off';
let pesoMode: PesoMode;
let pesoConfig: PesoConfig;

/**
 * Resolve the provider/model to use for tool.list() queries.
 *
 * Priority (per approved plan):
 *  1. config.small_model  — explicit cheap/fast model for tooling queries
 *  2. config.model        — top-level model override
 *  3. activeModel         — the actual session model passed from the hook
 *
 * Returns undefined if no model can be determined.
 */
async function resolveToolListModel(
  client: SdkClient,
  activeModel?: { providerID: string; modelID: string },
): Promise<{ providerID: string; modelID: string } | undefined> {
  try {
    const cfg = await client.config.get();
    const cfgData = cfg.data as any;

    // Priority 1: small_model
    const smallModelStr: string | undefined =
      typeof cfgData?.small_model === 'string' ? cfgData.small_model : undefined;
    if (smallModelStr && smallModelStr.includes('/')) {
      const slash = smallModelStr.indexOf('/');
      return { providerID: smallModelStr.substring(0, slash), modelID: smallModelStr.substring(slash + 1) };
    }

    // Priority 2: top-level model
    const modelStr: string | undefined = typeof cfgData?.model === 'string' ? cfgData.model : undefined;
    if (modelStr && modelStr.includes('/')) {
      const slash = modelStr.indexOf('/');
      return { providerID: modelStr.substring(0, slash), modelID: modelStr.substring(slash + 1) };
    }
  } catch {
    /* config.get may fail */
  }

  // Priority 3: active session model from hook context
  if (activeModel) return activeModel;

  return undefined;
}

async function getToolIds(
  client: SdkClient,
  directory?: string,
  activeModel?: { providerID: string; modelID: string },
): Promise<string[]> {
  // Early cache hit: if we already have a result keyed by the incoming model
  const earlyKey = activeModel ? `${activeModel.providerID}/${activeModel.modelID}` : '';
  const earlyCached = toolIdsCacheByModel.get(earlyKey);
  if (earlyCached) return earlyCached;

  try {
    // 1. Built-in + plugin tools
    const idsResult = await client.tool.ids({ query: { directory } });
    const ids = new Set<string>(idsResult.data ?? []);

    // 2. MCP server tools — try tool.list() with the resolved model
    let finalKey = earlyKey;
    try {
      const toolModel = await resolveToolListModel(client, activeModel);
      if (toolModel) {
        finalKey = `${toolModel.providerID}/${toolModel.modelID}`;

        // Check if this resolved key already has a cached result
        const resolvedCached = toolIdsCacheByModel.get(finalKey);
        if (resolvedCached) {
          // Alias the early key too so future calls skip resolution
          if (earlyKey !== finalKey) toolIdsCacheByModel.set(earlyKey, resolvedCached);
          return resolvedCached;
        }

        const listResult = await client.tool.list({
          query: { provider: toolModel.providerID, model: toolModel.modelID, directory },
        });
        if (listResult.data) {
          for (const t of listResult.data) ids.add(t.id);
        }
      }
    } catch {
      /* tool.list may fail */
    }

    // 3. Fallback: get MCP server names from status
    try {
      const mcpResult = await client.mcp.status();
      if (mcpResult.data) {
        for (const [name, status] of Object.entries(mcpResult.data)) {
          if ((status as any)?.status === 'connected') {
            ids.add(`[mcp:${name}]`); // marker so user knows which MCP servers are active
          }
        }
      }
    } catch {
      /* mcp.status may fail */
    }

    const result = [...ids].sort();
    // Store under the final resolved key; alias the early key if different
    toolIdsCacheByModel.set(finalKey, result);
    if (earlyKey !== finalKey) toolIdsCacheByModel.set(earlyKey, result);
    return result;
  } catch {
    const empty: string[] = [];
    toolIdsCacheByModel.set(earlyKey, empty);
    return empty;
  }
}

async function getAgents(client: SdkClient): Promise<Agent[]> {
  if (agentCache) return agentCache;
  try {
    const result = await client.app.agents();
    agentCache = result.data ?? [];
  } catch {
    agentCache = [];
  }
  return agentCache;
}

/**
 * Extract effective permission for a given type from the permission rules array.
 * Rules are pattern-matched; we look for the wildcard ("*") rule as the baseline.
 * Last matching rule wins (OpenCode evaluates top-to-bottom, last match takes precedence).
 * Returns "deny" as safe default if no matching rule found.
 */
function extractPermission(rules: any[], permissionType: string): "ask" | "allow" | "deny" {
  if (!Array.isArray(rules)) return "deny";
  let result: "ask" | "allow" | "deny" = "deny";
  for (const rule of rules) {
    if (rule.permission === permissionType && rule.pattern === '*') {
      result = rule.action as "ask" | "allow" | "deny";
    }
  }
  return result;
}

function toAgentPermissions(agent: Agent): AgentPermissions {
  const rules = agent.permission as any;
  if (Array.isArray(rules)) {
    return {
      edit: extractPermission(rules, 'edit'),
      bash: extractPermission(rules, 'bash'),
      webfetch: extractPermission(rules, 'webfetch'),
      description: agent.description,
      mode: agent.mode,
    };
  }
  // Fallback: old format (shouldn't happen but just in case)
  const perm = rules ?? ({} as any);
  return {
    edit: perm.edit,
    bash: perm.bash,
    webfetch: perm.webfetch,
    description: agent.description,
    mode: agent.mode,
  };
}

// ---------------------------------------------------------------------------
// Enhancement system prompt (fallback when pipeline produces none)
// ---------------------------------------------------------------------------
const ENHANCE_SYSTEM_PROMPT = `You are PESO, a prompt enhancement engine. Rewrite the user's prompt to be clearer, more specific, and better structured for an AI coding assistant.

Rules:
- Preserve original intent exactly
- Use short, direct words (fix not resolve, show not demonstrate, add not incorporate)
- Never make prompts longer than necessary — concise beats comprehensive
- Add explicit constraints, output format, and quality criteria where missing
- Move critical instructions to the beginning
- Remove politeness padding and filler phrases
- Add step-by-step invitation for complex tasks
- If the workspace has a CLAUDE.md or similar, do not repeat instructions it already covers
- Output ONLY the enhanced prompt, no meta-commentary`;

// ---------------------------------------------------------------------------
// LLM rewrite via SDK (plugin) or HTTP fallback (tools/CLI)
// ---------------------------------------------------------------------------
async function enhanceWithSdk(
  client: SdkClient,
  prompt: string,
  domain: Domain,
  contextBlock: string,
  systemPrompt: string,
): Promise<string> {
  const userMessage = `<context>\n${contextBlock}\n</context>\n\n<domain>${domain}</domain>\n\n<original-prompt>\n${prompt}\n</original-prompt>\n\nRewrite this prompt for an AI ${domain === 'code' ? 'coding' : domain} assistant.`;
  try {
    const result = await callSmallModelViaSdk(client, systemPrompt, userMessage);
    return result.text.trim() || prompt;
  } catch (err) {
    console.error(`[PESO] SDK LLM failed: ${err}`);
    return prompt;
  }
}

async function enhanceWithHttp(
  prompt: string,
  domain: Domain,
  contextBlock: string,
  systemPrompt: string,
): Promise<string> {
  const userMessage = `<context>\n${contextBlock}\n</context>\n\n<domain>${domain}</domain>\n\n<original-prompt>\n${prompt}\n</original-prompt>\n\nRewrite this prompt for an AI ${domain === 'code' ? 'coding' : domain} assistant.`;
  try {
    const result = await callSmallModel(systemPrompt, userMessage);
    return result.text.trim() || prompt;
  } catch (err) {
    console.error(`[PESO] HTTP LLM failed: ${err}`);
    return prompt;
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------
export const PesoPlugin: Plugin = async ({ directory, worktree, client }) => {
  const cwd = worktree || directory;

  // Load config (global → project → env)
  pesoConfig = loadPesoConfig(cwd);
  pesoMode = pesoConfig.mode;

  // Warm caches on init (silent, non-blocking)
  getAgents(client).catch(() => {});
  getToolIds(client, cwd).catch(() => {});
  gatherContext(cwd); // pre-fill context cache (CLI tools + git state)

  return {
    // -----------------------------------------------------------------------
    // Hook 1: Intercept user prompt — enhance and mutate output.parts
    // -----------------------------------------------------------------------
    'chat.message': async (input, output) => {
      if (pesoMode !== 'on') return;

      const agentName = input.agent;

      const textParts = output.parts.filter((p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text');
      if (textParts.length === 0) return;

      const originalText = textParts.map(p => p.text).join('\n');
      if (originalText.trim().length < pesoConfig.shortPromptThreshold) return;

      const classification = classify(originalText, 'auto');
      if (classification.suggestedRouting === 'clarify') return;

      // Resolve agent permissions from SDK
      let agentPermissions: AgentPermissions | undefined;
      if (agentName) {
        const agents = await getAgents(client);
        const match = agents.find(a => a.name === agentName);
        if (match) agentPermissions = toAgentPermissions(match);
      }

      // Pass the active session model so tool.list() uses the right provider/model
      const activeModel = input.model ?? undefined;
      const mcpTools = await getToolIds(client, cwd, activeModel);
      const pipelineResult = runPipeline(originalText, classification, {
        domain: classification.domain,
        injectContext: true,
        cwd,
        mcpTools,
        toolPriorities: pesoConfig.toolPriorities,
        contextConfig: pesoConfig.context,
        agent: agentName ?? undefined,
        agentPermissions,
        modelId: activeModel?.modelID,
      });

      if (pipelineResult.enhanced === originalText) return;

      // Mark all original text parts as ignored (hidden from LLM, still visible in UI)
      // then push a single synthetic part with the enhanced text for the LLM.
      const firstTextPart = output.parts.find((p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text');
      for (const part of output.parts) {
        if (part.type === 'text') {
          (part as any).ignored = true;
        }
      }
      if (firstTextPart) {
        output.parts.push({
          ...firstTextPart,
          id: `${firstTextPart.id}-peso`,
          text: pipelineResult.enhanced,
          synthetic: true,
          ignored: false,
        } as any);
      }

      if (input.sessionID) sessionPipelineCache.set(input.sessionID, pipelineResult);
    },

    // -----------------------------------------------------------------------
    // Hook 2: Inject PESO system prompt into the model system prompt array
    // -----------------------------------------------------------------------
    'experimental.chat.system.transform': async (input, output) => {
      if (pesoMode !== 'on') return;
      if (!input.sessionID) return;

      const cached = sessionPipelineCache.get(input.sessionID);
      if (!cached?.systemPrompt) return;

      output.system.push(cached.systemPrompt);
      sessionPipelineCache.delete(input.sessionID);
    },

    // -----------------------------------------------------------------------
    // Tools
    // -----------------------------------------------------------------------
    tool: {
      peso: tool({
        description:
          "Enhance a prompt using PESO's research-backed pipeline + small model rewrite. " +
          'Classifies the prompt, applies 26 VILA-Lab techniques, injects workspace context, ' +
          'and uses a small LLM to rewrite it optimally. ' +
          'Modes: auto (classify+route), code, general, creative, research.',
        args: {
          prompt: tool.schema.string('The prompt to enhance'),
          mode: tool.schema.optional(tool.schema.enum(['auto', 'code', 'general', 'creative', 'research'])),
          use_llm: tool.schema.optional(tool.schema.boolean('Whether to call the small model (default: true)')),
        },
        async execute(args) {
          const prompt = args.prompt;
          const mode = args.mode || 'auto';
          const useLlm = args.use_llm !== false;

          const classification = classify(prompt, mode as any);

          if (classification.suggestedRouting === 'clarify') {
            const questions = generateClarifyingQuestions(classification);
            return [
              `## Clarification Needed`,
              ``,
              `**Ambiguity:** ${classification.ambiguousDimensions.join(', ')}`,
              ``,
              `**Questions:**`,
              ...questions.map((q, i) => `${i + 1}. ${q}`),
              ``,
              `Please refine your prompt and run again.`,
            ].join('\n');
          }

          const ctx = gatherContext(cwd);
          const contextBlock = formatContextBlock(ctx, prompt);

          const pipelineResult = runPipeline(prompt, classification, {
            domain: classification.domain,
            injectContext: true,
            cwd,
          });

          let enhanced = pipelineResult.enhanced;

          if (useLlm) {
            const sys = pipelineResult.systemPrompt || ENHANCE_SYSTEM_PROMPT;
            enhanced = await enhanceWithSdk(client, prompt, classification.domain, contextBlock, sys);
            if (enhanced === prompt) {
              // SDK failed — try HTTP fallback
              enhanced = await enhanceWithHttp(prompt, classification.domain, contextBlock, sys);
            }
          }

          const scoreAfter = useLlm ? scorePrompt(enhanced) : pipelineResult.scoreAfter;

          const lines = [
            `## PESO Enhancement`,
            ``,
            `**Model:** ${describeConfig()}`,
            `**Domain:** \`${classification.domain}\` | **Complexity:** \`${classification.complexity}\``,
            ``,
            `### Score`,
            `\`\`\``,
            formatScoreSummary(pipelineResult.scoreBefore, scoreAfter),
            `\`\`\``,
          ];

          if (pipelineResult.needsFreshInfo)
            lines.push(``, `### Freshness Warning`, `Prompt references potentially outdated info — use search tools.`);

          if (pipelineResult.systemPrompt)
            lines.push(``, `### System Prompt (injected)`, `\`\`\``, pipelineResult.systemPrompt, `\`\`\``);

          lines.push(``, `### Enhanced Prompt`, `\`\`\``, enhanced, `\`\`\``);

          return lines.join('\n');
        },
      }),

      'peso-score': tool({
        description: "Score a prompt against PESO's quality criteria (0-10) without modifying it.",
        args: { prompt: tool.schema.string('The prompt to score') },
        async execute(args) {
          const score = scorePrompt(args.prompt);
          const lines = [
            `**Score:** ${score.total}/10  **Grade:** ${score.grade}`,
            ``,
            `| Dimension | Score |`,
            `|---|---|`,
            `| Rule Compliance | ${score.rules.score.toFixed(1)}/10 |`,
            `| Length | ${score.lengthScore.toFixed(1)}/2 |`,
            `| Clarity | ${score.clarityScore.toFixed(1)}/2 |`,
            `| Specificity | ${score.specificityScore.toFixed(1)}/2 |`,
          ];
          if (score.rules.violations.length > 0) {
            lines.push(``, `**Violations:**`);
            for (const v of score.rules.violations) lines.push(`- [${v.severity}] ${v.rule}: ${v.suggestion}`);
          }
          return lines.join('\n');
        },
      }),

      'peso-debug': tool({
        description:
          'Run PESO with full pipeline trace: classification, techniques, context, LLM call, before/after scores.',
        args: {
          prompt: tool.schema.string('The prompt to debug-enhance'),
          mode: tool.schema.optional(tool.schema.enum(['auto', 'code', 'general', 'creative', 'research'])),
          use_llm: tool.schema.optional(tool.schema.boolean('Whether to call the small model (default: true)')),
        },
        async execute(args) {
          const prompt = args.prompt;
          const mode = (args.mode || 'auto') as any;
          const useLlm = args.use_llm !== false;
          const lines: string[] = [];

          lines.push(`## PESO Debug Trace`, ``);

          // Config
          lines.push(`### Configuration`);
          try {
            const cfg = resolveConfig();
            lines.push(`- Provider: \`${cfg.provider}\``);
            lines.push(`- Model: \`${cfg.model}\``);
            lines.push(`- API Key: ${cfg.apiKey ? '✓' : '✗ missing'}`);
            lines.push(`- Source: ${process.env.PESO_MODEL ? 'PESO_MODEL env' : 'opencode.json'}`);
          } catch (e) {
            lines.push(`- Error: ${e}`);
          }

          // Agents
          lines.push(``, `### Agents (from SDK)`);
          const agents = await getAgents(client);
          if (agents.length > 0) {
            lines.push(`\`\`\`json`, JSON.stringify(agents[0], null, 2), `\`\`\``);
          }
          for (const a of agents) {
            const perm = (a as any).permission ?? (a as any).permissions;
            const edit = perm?.edit ?? 'n/a';
            const bash = !perm?.bash ? 'n/a' : typeof perm.bash === 'string' ? perm.bash : JSON.stringify(perm.bash);
            lines.push(`- \`${a.name}\` mode=${a.mode} edit=${edit} bash=${bash}`);
          }

          // Classification
          lines.push(``, `### Classification`);
          const t0 = Date.now();
          const classification = classify(prompt, mode);
          lines.push(`- Domain: \`${classification.domain}\``);
          lines.push(`- Complexity: \`${classification.complexity}\``);
          lines.push(`- Routing: \`${classification.suggestedRouting}\``);
          lines.push(`- Ambiguity: ${(classification.ambiguityScore * 100).toFixed(0)}%`);
          lines.push(`- Needs fresh info: ${classification.needsFreshInfo}`);
          lines.push(`- Time: ${Date.now() - t0}ms`);

          // Score before
          lines.push(``, `### Score (Before)`);
          const scoreBefore = scorePrompt(prompt);
          lines.push(`- Total: ${scoreBefore.total}/10 (${scoreBefore.grade})`);
          lines.push(
            `- Rules: ${scoreBefore.rules.score.toFixed(1)}/10 | Length: ${scoreBefore.lengthScore.toFixed(1)}/2 | Clarity: ${scoreBefore.clarityScore.toFixed(1)}/2 | Specificity: ${scoreBefore.specificityScore.toFixed(1)}/2`,
          );

          // Context
          lines.push(``, `### Context`);
          const ctx = gatherContext(cwd);
          const contextBlock = formatContextBlock(ctx, prompt);
          lines.push(`- CWD: ${ctx.cwd}`);
          lines.push(`- Git branch: ${ctx.gitBranch || '(none)'}`);
          lines.push(`- Changed files: ${ctx.gitChangedFiles.length}`);

          // Techniques
          lines.push(``, `### Techniques`);
          const techs = autoSelectTechniques(prompt, classification.domain);
          for (const t of techs) lines.push(`- ✓ \`${t.id}\`: ${t.name}`);
          if (techs.length === 0) lines.push(`- (none)`);

          // Pipeline
          lines.push(``, `### Pipeline Stages`);
          const t1 = Date.now();
          const pipelineResult = runPipeline(prompt, classification, {
            domain: classification.domain,
            injectContext: true,
            cwd,
          });
          lines.push(`- Time: ${Date.now() - t1}ms`);
          for (const s of pipelineResult.stages) lines.push(`- ${s.applied ? '✓' : '–'} **${s.stage}**: ${s.change}`);

          let enhanced = pipelineResult.enhanced;

          // LLM
          lines.push(``, `### LLM Rewrite`);
          if (!useLlm) {
            lines.push(`- Skipped (use_llm=false)`);
          } else {
            const sys = pipelineResult.systemPrompt || ENHANCE_SYSTEM_PROMPT;
            const cfg = resolveConfig();
            lines.push(`- Calling SDK → ${cfg.provider}/${cfg.model}`);
            const t2 = Date.now();
            const llmResult = await enhanceWithSdk(client, prompt, classification.domain, contextBlock, sys);
            if (llmResult !== prompt) {
              enhanced = llmResult;
              lines.push(`- Time: ${Date.now() - t2}ms | Length: ${enhanced.length}ch | ✓ Success`);
            } else {
              lines.push(`- SDK failed, trying HTTP fallback`);
              const httpResult = await enhanceWithHttp(prompt, classification.domain, contextBlock, sys);
              if (httpResult !== prompt) {
                enhanced = httpResult;
                lines.push(`- HTTP fallback: ✓ Success`);
              } else {
                lines.push(`- Both paths failed — keeping rule-based result`);
              }
            }
          }

          // Score after
          lines.push(``, `### Score (After)`);
          const scoreAfter = scorePrompt(enhanced);
          const delta = scoreAfter.total - scoreBefore.total;
          lines.push(`- Total: ${scoreAfter.total}/10 (${scoreAfter.grade})`);
          lines.push(`- Delta: ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}`);

          lines.push(``, `### Enhanced Prompt`, `\`\`\``, enhanced, `\`\`\``);

          return lines.join('\n');
        },
      }),

      'peso-toggle': tool({
        description:
          "Switch PESO mode. 'on' = transparent (all prompts enhanced automatically), " +
          "'passive' = only enhances when agent calls the peso tool explicitly, " +
          "'off' = fully disabled. No args = show current mode.",
        args: {
          mode: tool.schema.optional(tool.schema.enum(['on', 'passive', 'off'])),
        },
        async execute(args) {
          if (args.mode) {
            pesoMode = args.mode;
            const desc: Record<PesoMode, string> = {
              on: 'All prompts enhanced transparently.',
              passive: 'Enhancement only when you call the `peso` tool.',
              off: 'Fully disabled.',
            };
            return `PESO mode: **${pesoMode}** — ${desc[pesoMode]}`;
          }
          return `PESO mode: **${pesoMode}**`;
        },
      }),

      'peso-config': tool({
        description: 'Show PESO configuration: model, API key status, loaded agents, compass classification.',
        args: {},
        async execute() {
          const cfg = resolveConfig();
          const sdkModel = await resolveModelNameFromSdk(client);
          const agents = await getAgents(client);
          const lines = [
            `## PESO Configuration`,
            ``,
            `| Setting | Value |`,
            `|---|---|`,
            `| Provider | \`${cfg.provider}\` |`,
            `| Model (SDK-resolved) | \`${sdkModel}\` |`,
            `| Model (local fallback) | \`${cfg.model}\` |`,
            `| API Key  | ${cfg.apiKey ? '✓ configured' : '✗ missing'} |`,
            `| Base URL | \`${cfg.baseUrl}\` |`,
            ``,
            `### Agent Compass`,
            `| Agent | edit | bash | Vector | Intensity |`,
            `|---|---|---|---|---|`,
          ];

          // Import inline to show compass output per agent
          const { runPipeline: rp } = await import('./enhancer.js');
          for (const a of agents) {
            const perms: AgentPermissions = {
              edit: a.permission.edit,
              bash: a.permission.bash,
              description: a.description,
              mode: a.mode,
            };
            // Probe intensity with a medium-complexity prompt
            const probe = runPipeline(
              'implement a feature with tests',
              classify('implement a feature with tests', 'auto'),
              {
                domain: 'code',
                injectContext: false,
                agent: a.name,
                agentPermissions: perms,
              },
            );
            const editStr = a.permission?.edit ?? 'n/a';
            const bashStr = !a.permission?.bash
              ? 'n/a'
              : typeof a.permission.bash === 'string'
                ? a.permission.bash
                : JSON.stringify(a.permission.bash);
            lines.push(
              `| \`${a.name}\` | ${editStr} | ${bashStr} | mode=${a.mode} | **${probe.stages[0]?.change?.match(/intensity: (\w+)/)?.[1] ?? '?'}** |`,
            );
          }

          // Tool discovery diagnostics
          lines.push(``, `### Tool Discovery`);
          try {
            const cfgRaw = await client.config.get();
            const cfgData = cfgRaw.data as any;
            const modelStr: string | undefined = typeof cfgData?.model === 'string' ? cfgData.model : undefined;
            const smallModelStr: string | undefined =
              typeof cfgData?.small_model === 'string' ? cfgData.small_model : undefined;
            lines.push(`- config.model: \`${modelStr ?? '(not set)'}\``);
            lines.push(`- config.small_model: \`${smallModelStr ?? '(not set)'}\``);

            // Resolved model used for tool.list() — same priority as resolveToolListModel()
            const resolvedModel = smallModelStr ?? modelStr;
            lines.push(
              `- tool.list() model (small_model → model): \`${resolvedModel ?? '(none — session model used)'}\``,
            );

            const idsResult = await client.tool.ids({ query: { directory: cwd } });
            lines.push(`- tool.ids(): ${idsResult.data?.length ?? 0} tools`);

            if (resolvedModel && resolvedModel.includes('/')) {
              const slashIdx = resolvedModel.indexOf('/');
              const p = resolvedModel.substring(0, slashIdx);
              const m = resolvedModel.substring(slashIdx + 1);
              lines.push(`- tool.list() query: provider=\`${p}\` model=\`${m}\``);
              try {
                const listResult = await client.tool.list({ query: { provider: p, model: m, directory: cwd } });
                lines.push(`- tool.list(): ${listResult.data?.length ?? 0} tools`);
              } catch (e: any) {
                lines.push(`- tool.list(): FAILED — ${e?.message || e}`);
              }
            } else {
              lines.push(`- tool.list(): skipped — no config model (session model fallback active)`);
            }

            // MCP status
            try {
              const mcpResult = await client.mcp.status();
              const servers = Object.entries(mcpResult.data ?? {});
              lines.push(`- mcp.status(): ${servers.length} servers`);
              for (const [name, status] of servers) {
                lines.push(`  - \`${name}\`: ${(status as any)?.status}`);
              }
            } catch (e: any) {
              lines.push(`- mcp.status(): FAILED — ${e?.message || e}`);
            }
          } catch (e: any) {
            lines.push(`- config.get(): FAILED — ${e?.message || e}`);
          }

          // Available tools (for peso.json toolPriorities setup)
          const allTools = await getToolIds(client, cwd);
          lines.push(
            ``,
            `### Available Tools (${allTools.length})`,
            `\`\`\``,
            allTools.join(', '),
            `\`\`\``,
            ``,
            `### Tool Priorities (from peso.json)`,
            `- Mode: \`${pesoConfig.toolPriorities.mode || 'manual'}\``,
            `- Prefer: ${pesoConfig.toolPriorities.prefer.join(', ') || '(none)'}`,
            `- Avoid: ${pesoConfig.toolPriorities.avoid.join(', ') || '(none)'}`,
          );

          lines.push(
            ``,
            `### Model Resolution (LLM rewrite target)`,
            `1. \`PESO_MODEL\` env: ${process.env.PESO_MODEL || '(not set)'}`,
            `2. \`opencode.json\` small_model → model → fallback: \`${cfg.provider}/${cfg.model}\``,
            `3. Fallback: opencode/zen`,
          );

          return lines.join('\n');
        },
      }),
    },
  };
};
