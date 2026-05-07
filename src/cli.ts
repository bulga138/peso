#!/usr/bin/env bun
/**
 * PESO CLI — Standalone test runner for debugging.
 *
 * Usage:
 *   bun run src/cli.ts "your prompt here"
 *   bun run src/cli.ts --mode code "implement a retry mechanism"
 *   bun run src/cli.ts --no-llm "fix the bug"
 *   bun run src/cli.ts --debug "explain how auth works"
 *   bun run src/cli.ts --score "write a function"
 *   bun run src/cli.ts --config
 *
 * Env vars:
 *   PESO_DEBUG=1        Verbose pipeline trace
 *   PESO_MODEL=...      Override model
 *   PESO_API_KEY=...    Override API key
 */

import { classify, generateClarifyingQuestions } from "./classifier.js";
import { runPipeline } from "./enhancer.js";
import { scorePrompt, formatScoreSummary } from "./scorer.js";
import { gatherContext, formatContextBlock, detectStaleInfo } from "./context-gatherer.js";
import { callSmallModel, resolveConfig, describeConfig } from "./llm-client.js";
import { autoSelectTechniques, TECHNIQUES } from "./techniques.js";
import type { Domain } from "./classifier.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RED = "\x1b[31m";
const MAGENTA = "\x1b[35m";

function log(msg: string) {
  console.log(msg);
}

function header(title: string) {
  log(`\n${BOLD}${CYAN}━━━ ${title} ━━━${RESET}`);
}

function kvLine(key: string, value: string) {
  log(`  ${DIM}${key}:${RESET} ${value}`);
}

function debug(msg: string) {
  if (process.env.PESO_DEBUG === "1" || args.debug) {
    log(`  ${DIM}[debug]${RESET} ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------
interface CliArgs {
  prompt: string;
  mode: "auto" | "code" | "general" | "creative" | "research";
  useLlm: boolean;
  debug: boolean;
  scoreOnly: boolean;
  configOnly: boolean;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const result: CliArgs = {
    prompt: "",
    mode: "auto",
    useLlm: true,
    debug: false,
    scoreOnly: false,
    configOnly: false,
  };

  const promptParts: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--mode" && argv[i + 1]) {
      result.mode = argv[++i] as CliArgs["mode"];
    } else if (arg === "--no-llm") {
      result.useLlm = false;
    } else if (arg === "--debug" || arg === "-d") {
      result.debug = true;
      process.env.PESO_DEBUG = "1";
    } else if (arg === "--score") {
      result.scoreOnly = true;
    } else if (arg === "--config") {
      result.configOnly = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      promptParts.push(arg);
    }
  }

  result.prompt = promptParts.join(" ");
  return result;
}

function printHelp() {
  log(`
${BOLD}PESO CLI — Prompt Engineering Smart Optimizer${RESET}

${BOLD}Usage:${RESET}
  bun run src/cli.ts [options] "your prompt here"

${BOLD}Options:${RESET}
  --mode <mode>    Enhancement mode: auto, code, general, creative, research
  --no-llm         Skip the small-model LLM call (rule-based only)
  --debug, -d      Show full pipeline trace with timing
  --score          Score the prompt without enhancing it
  --config         Show current PESO configuration and exit
  --help, -h       Show this help

${BOLD}Env vars:${RESET}
  PESO_DEBUG=1          Always show debug output
  PESO_MODEL=provider/model   Override the small model
  PESO_API_KEY=sk-...         Override the API key
  PESO_BASE_URL=https://...   Override the API base URL

${BOLD}Examples:${RESET}
  bun run src/cli.ts "fix the login bug"
  bun run src/cli.ts --mode code --debug "implement retry with exponential backoff"
  bun run src/cli.ts --no-llm "explain how authentication works"
  bun run src/cli.ts --score "write a function that processes data"
  bun run src/cli.ts --config
`);
}

// ---------------------------------------------------------------------------
// Enhancement system prompt (same as plugin.ts)
// ---------------------------------------------------------------------------
const ENHANCE_SYSTEM_PROMPT = `You are PESO, a prompt enhancement engine. Your job is to rewrite the user's prompt to be clearer, more specific, and better structured for an AI coding assistant.

Rules:
- Preserve the original intent exactly — do NOT change what the user wants
- Add explicit constraints, output format, and quality criteria where missing
- Move critical instructions to the beginning
- Remove politeness padding (please, could you, etc.)
- Add step-by-step invitation for complex tasks
- If the prompt references potentially outdated info, note that search tools should be used
- Keep the enhanced prompt concise — do not bloat it
- Output ONLY the enhanced prompt, no meta-commentary

You will receive the original prompt along with a context block and classification data.`;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const args = parseArgs();

async function main() {
  // --config: show config and exit
  if (args.configOnly) {
    header("PESO Configuration");
    try {
      const cfg = resolveConfig();
      kvLine("Provider", cfg.provider);
      kvLine("Model", cfg.model);
      kvLine("API Key", cfg.apiKey ? `${GREEN}✓ configured${RESET}` : `${RED}✗ missing${RESET}`);
      kvLine("Base URL", cfg.baseUrl);
      log("");
      kvLine("PESO_MODEL env", process.env.PESO_MODEL || "(not set)");
      kvLine("PESO_API_KEY env", process.env.PESO_API_KEY ? "set" : "(not set)");
      kvLine("PESO_BASE_URL env", process.env.PESO_BASE_URL || "(not set)");
    } catch (err) {
      log(`  ${RED}Error: ${err}${RESET}`);
    }
    return;
  }

  if (!args.prompt) {
    log(`${RED}Error: No prompt provided.${RESET}`);
    log(`Usage: bun run src/cli.ts "your prompt here"`);
    log(`       bun run src/cli.ts --help`);
    process.exit(1);
  }

  const startTime = Date.now();

  // ── Step 1: Config ──────────────────────────────────────────
  header("Configuration");
  log(`  ${describeConfig()}`);
  kvLine("Mode", args.mode);
  kvLine("LLM rewrite", args.useLlm ? "enabled" : "disabled (rule-based only)");

  // ── Step 2: Original prompt ─────────────────────────────────
  header("Original Prompt");
  log(`${DIM}  "${args.prompt}"${RESET}`);

  // ── Step 3: Classification ──────────────────────────────────
  header("Classification");
  const t0 = Date.now();
  const classification = classify(args.prompt, args.mode);
  debug(`classification took ${Date.now() - t0}ms`);

  kvLine("Domain", `${BOLD}${classification.domain}${RESET}`);
  kvLine("Complexity", classification.complexity);
  kvLine("Routing", `${MAGENTA}${classification.suggestedRouting}${RESET}`);
  kvLine("Ambiguity", `${(classification.ambiguityScore * 100).toFixed(0)}%`);
  kvLine("Needs fresh info", classification.needsFreshInfo ? `${YELLOW}yes${RESET}` : "no");

  if (classification.ambiguousDimensions.length > 0) {
    kvLine("Ambiguous dims", classification.ambiguousDimensions.join(", "));
  }

  if (classification.slots.goal) kvLine("Goal", classification.slots.goal);
  if (classification.slots.constraints.length > 0) kvLine("Constraints", classification.slots.constraints.join("; "));
  if (classification.slots.references.length > 0) kvLine("References", classification.slots.references.join(", "));
  if (classification.slots.validation.length > 0) kvLine("Validation", classification.slots.validation.join("; "));

  // ── Clarify shortcut ────────────────────────────────────────
  if (classification.suggestedRouting === "clarify") {
    header("Clarification Required");
    const questions = generateClarifyingQuestions(classification);
    questions.forEach((q, i) => log(`  ${YELLOW}${i + 1}. ${q}${RESET}`));
    log(`\n  ${DIM}Refine your prompt and run again.${RESET}`);
    return;
  }

  // ── Step 4: Score before ────────────────────────────────────
  header("Score (Before)");
  const scoreBefore = scorePrompt(args.prompt);
  kvLine("Total", `${scoreBefore.total}/10  Grade: ${BOLD}${scoreBefore.grade}${RESET}`);
  kvLine("Rule compliance", `${scoreBefore.rules.score.toFixed(1)}/10`);
  kvLine("Length", `${scoreBefore.lengthScore.toFixed(1)}/2`);
  kvLine("Clarity", `${scoreBefore.clarityScore.toFixed(1)}/2`);
  kvLine("Specificity", `${scoreBefore.specificityScore.toFixed(1)}/2`);

  if (scoreBefore.rules.violations.length > 0) {
    log(`  ${DIM}Violations:${RESET}`);
    for (const v of scoreBefore.rules.violations) {
      log(`    ${YELLOW}[${v.severity}]${RESET} ${v.rule}: ${v.suggestion}`);
    }
  }

  if (args.scoreOnly) {
    return;
  }

  // ── Step 5: Context ─────────────────────────────────────────
  header("Context Gathering");
  const t1 = Date.now();
  const ctx = gatherContext();
  const contextBlock = formatContextBlock(ctx, args.prompt);
  debug(`context gathered in ${Date.now() - t1}ms`);

  kvLine("CWD", ctx.cwd);
  kvLine("Git branch", ctx.gitBranch || "(none)");
  kvLine("Changed files", ctx.gitChangedFiles.length > 0 ? ctx.gitChangedFiles.join(", ") : "(none)");
  kvLine("Tools", ctx.availableTools.join(", "));
  kvLine("Date", ctx.todayDate);

  if (args.debug) {
    log(`\n  ${DIM}Context block:${RESET}`);
    for (const line of contextBlock.split("\n")) {
      log(`  ${DIM}${line}${RESET}`);
    }
  }

  // ── Step 6: Techniques ──────────────────────────────────────
  header("Techniques (Auto-Selected)");
  const applicableTechniques = autoSelectTechniques(args.prompt, classification.domain);
  if (applicableTechniques.length === 0) {
    log(`  ${DIM}(none applicable)${RESET}`);
  } else {
    for (const t of applicableTechniques) {
      log(`  ${GREEN}✓${RESET} ${BOLD}${t.id}${RESET} — ${t.name}`);
      if (args.debug) {
        log(`    ${DIM}${t.description}${RESET}`);
      }
    }
  }

  // ── Step 7: Rule-based pipeline ─────────────────────────────
  header("Pipeline (Rule-Based)");
  const t2 = Date.now();
  const pipelineResult = runPipeline(args.prompt, classification, {
    domain: classification.domain,
    injectContext: true,
    cwd: ctx.cwd,
    skipStages: [],
  });
  debug(`pipeline took ${Date.now() - t2}ms`);

  for (const stage of pipelineResult.stages) {
    const mark = stage.applied ? `${GREEN}✓${RESET}` : `${DIM}–${RESET}`;
    log(`  ${mark} ${BOLD}${stage.stage}${RESET}: ${stage.change}`);
  }

  let enhanced = pipelineResult.enhanced;

  // ── Step 8: LLM rewrite ─────────────────────────────────────
  if (args.useLlm) {
    header("LLM Rewrite");
    try {
      const cfg = resolveConfig();
      if (!cfg.apiKey) {
        log(`  ${YELLOW}Skipped — no API key found${RESET}`);
        log(`  ${DIM}Set PESO_API_KEY or ${cfg.provider.toUpperCase()}_API_KEY${RESET}`);
      } else {
        kvLine("Calling", `${cfg.provider}/${cfg.model}`);
        const t3 = Date.now();
        const systemPromptForLlm = pipelineResult.systemPrompt || ENHANCE_SYSTEM_PROMPT;
        const userMessage = `<context>\n${contextBlock}\n</context>\n\n<domain>${classification.domain}</domain>\n\n<original-prompt>\n${args.prompt}\n</original-prompt>\n\nRewrite this prompt to be optimally structured for an AI ${classification.domain === "code" ? "coding" : classification.domain} assistant.`;

        if (args.debug) {
          log(`\n  ${DIM}System prompt:${RESET}`);
          for (const line of systemPromptForLlm.split("\n").slice(0, 5)) {
            log(`  ${DIM}  ${line}${RESET}`);
          }
          log(`  ${DIM}  ...${RESET}`);
          log(`\n  ${DIM}User message (${userMessage.length} chars)${RESET}`);
        }

        const response = await callSmallModel(systemPromptForLlm, userMessage);
        const elapsed = Date.now() - t3;
        enhanced = response.text.trim();

        kvLine("Time", `${elapsed}ms`);
        if (response.usage) {
          kvLine("Tokens", `${response.usage.promptTokens} in → ${response.usage.completionTokens} out`);
        }
        log(`  ${GREEN}✓ LLM rewrite complete${RESET}`);
      }
    } catch (err) {
      log(`  ${RED}✗ LLM error: ${err}${RESET}`);
      log(`  ${DIM}Keeping rule-based result${RESET}`);
    }
  } else {
    header("LLM Rewrite");
    log(`  ${DIM}Skipped (--no-llm)${RESET}`);
  }

  // ── Step 9: Score after ─────────────────────────────────────
  header("Score (After)");
  const scoreAfter = scorePrompt(enhanced);
  kvLine("Total", `${scoreAfter.total}/10  Grade: ${BOLD}${scoreAfter.grade}${RESET}`);

  const delta = scoreAfter.total - scoreBefore.total;
  const deltaColor = delta > 0 ? GREEN : delta < 0 ? RED : DIM;
  kvLine("Delta", `${deltaColor}${delta >= 0 ? "+" : ""}${delta.toFixed(1)}${RESET}`);

  // ── Step 10: Enhanced prompt ────────────────────────────────
  header("Enhanced Prompt");
  log("");
  log(enhanced);
  log("");

  if (args.debug && pipelineResult.systemPrompt) {
    header("System Prompt (for model)");
    log("");
    log(pipelineResult.systemPrompt);
    log("");
  }

  // ── Summary ─────────────────────────────────────────────────
  const totalTime = Date.now() - startTime;
  header("Summary");
  kvLine("Score", `${scoreBefore.total}/10 (${scoreBefore.grade}) → ${scoreAfter.total}/10 (${scoreAfter.grade})`);
  kvLine("Techniques", `${applicableTechniques.length} applied`);
  kvLine("LLM used", args.useLlm ? "yes" : "no");
  kvLine("Total time", `${totalTime}ms`);
  log("");
}

main().catch((err) => {
  console.error(`${RED}Fatal: ${err}${RESET}`);
  process.exit(1);
});
