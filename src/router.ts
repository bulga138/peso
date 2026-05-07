/**
 * Smart Router
 *
 * Orchestrates the full PESO flow:
 * 1. Classify the prompt
 * 2. Decide routing: passthrough | clarify | enhance | search | rewrite
 * 3. Return appropriate response
 */

import {
  classify,
  generateClarifyingQuestions,
  type ClassificationResult,
} from "./classifier.js";
import { runPipeline, type EnhancementResult } from "./enhancer.js";
import { formatScoreSummary } from "./scorer.js";
import type { Domain } from "./classifier.js";

export type Mode = "auto" | "code" | "general" | "creative" | "research";

export interface RouterInput {
  prompt: string;
  mode: Mode;
  cwd?: string;
  injectContext?: boolean;
  selectedTechniqueIds?: string[];
}

export type RouterOutputKind =
  | "passthrough"
  | "clarify"
  | "enhance"
  | "search"
  | "rewrite";

export interface RouterOutput {
  kind: RouterOutputKind;
  classification: ClassificationResult;
  // For passthrough: original prompt unchanged
  // For clarify: questions to ask
  // For enhance/rewrite/search: enhanced prompt + metadata
  result?: string;
  clarifyingQuestions?: string[];
  enhancementResult?: EnhancementResult;
  scoreSummary?: string;
  searchHint?: string;
}

// ---------------------------------------------------------------------------
// Main router
// ---------------------------------------------------------------------------
export function route(input: RouterInput): RouterOutput {
  const { prompt, mode, cwd, injectContext = true, selectedTechniqueIds } = input;

  // Step 1: Classify
  const classification = classify(prompt, mode);

  // Step 2: Route
  switch (classification.suggestedRouting) {
    case "passthrough": {
      return {
        kind: "passthrough",
        classification,
        result: prompt,
      };
    }

    case "clarify": {
      const questions = generateClarifyingQuestions(classification);
      return {
        kind: "clarify",
        classification,
        clarifyingQuestions: questions,
        result: formatClarifyMessage(prompt, questions, classification),
      };
    }

    case "search": {
      const searchHint = buildSearchHint(prompt, classification);
      // Still enhance but flag that fresh info is needed
      const enhancementResult = runPipeline(prompt, classification, {
        domain: classification.domain,
        injectContext,
        cwd,
        selectedTechniqueIds,
      });
      return {
        kind: "search",
        classification,
        enhancementResult,
        result: enhancementResult.enhanced,
        searchHint,
        scoreSummary: formatScoreSummary(
          enhancementResult.scoreBefore,
          enhancementResult.scoreAfter
        ),
      };
    }

    case "rewrite":
    case "enhance": {
      const domain: Domain =
        mode === "auto" ? classification.domain : (mode as Domain);

      const enhancementResult = runPipeline(prompt, classification, {
        domain,
        injectContext,
        cwd,
        selectedTechniqueIds,
        // For rewrite mode, run all stages (no skips); enhance also runs all
        skipStages: [],
      });

      return {
        kind: classification.suggestedRouting,
        classification,
        enhancementResult,
        result: enhancementResult.enhanced,
        scoreSummary: formatScoreSummary(
          enhancementResult.scoreBefore,
          enhancementResult.scoreAfter
        ),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function formatClarifyMessage(
  prompt: string,
  questions: string[],
  classification: ClassificationResult
): string {
  const lines = [
    `Your prompt needs clarification before it can be optimally enhanced.`,
    ``,
    `**Detected issues:** ${classification.ambiguousDimensions.join(", ")}`,
    ``,
    `**Please answer the following before proceeding:**`,
    ...questions.map((q, i) => `${i + 1}. ${q}`),
    ``,
    `**Original prompt:**`,
    `> ${prompt}`,
    ``,
    `Once you've answered, re-run with \`/peso [mode]\` or call \`peso-enhance\` with the updated prompt.`,
  ];
  return lines.join("\n");
}

function buildSearchHint(
  prompt: string,
  classification: ClassificationResult
): string {
  const lines = [
    `This prompt references potentially stale information.`,
    ``,
    `**Recommended actions before using this enhanced prompt:**`,
  ];

  if (/\b(latest|current|newest)\b/i.test(prompt)) {
    lines.push("- Search for the current version/status of any referenced library, API, or technology");
  }
  if (/\b(today|this week|this month|this year)\b/i.test(prompt)) {
    lines.push("- Use a web search tool to retrieve today's date-relevant information");
  }
  if (/\bv\d+\.\d+/.test(prompt)) {
    lines.push("- Verify the version number referenced is still current");
  }
  if (classification.slots.references.length > 0) {
    lines.push(`- Check these references are still valid: ${classification.slots.references.join(", ")}`);
  }

  return lines.join("\n");
}
