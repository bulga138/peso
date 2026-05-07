/**
 * Scorer — before/after prompt quality scoring.
 *
 * Inspired by meta-introspector's 10-point compliance scoring.
 * Evaluates a prompt against all research-backed dimensions and
 * returns a score from 0-10 with a breakdown.
 */

import { checkAllRules, type RuleCheckResult } from "./rules/research-backed.js";

export interface ScoreBreakdown {
  rules: RuleCheckResult;
  lengthScore: number;       // 0-2: penalise too-short or too-long
  clarityScore: number;      // 0-2: clear goal statement
  specificityScore: number;  // 0-2: specific vs vague
  total: number;             // 0-10
  grade: "A" | "B" | "C" | "D" | "F";
}

function gradeFromScore(score: number): ScoreBreakdown["grade"] {
  if (score >= 9) return "A";
  if (score >= 7.5) return "B";
  if (score >= 6) return "C";
  if (score >= 4.5) return "D";
  return "F";
}

// ---------------------------------------------------------------------------
// Length scoring (0-2 points)
// Sweet spot: 30-200 words
// ---------------------------------------------------------------------------
function scoreLengthDimension(prompt: string): number {
  const wordCount = prompt.split(/\s+/).filter(Boolean).length;
  if (wordCount >= 30 && wordCount <= 200) return 2;
  if (wordCount >= 15 && wordCount < 30) return 1.5;
  if (wordCount >= 200 && wordCount <= 400) return 1.5;
  if (wordCount > 400) return 1;
  return 0.5; // very short
}

// ---------------------------------------------------------------------------
// Clarity scoring (0-2 points)
// Does the prompt have a clear goal/objective?
// ---------------------------------------------------------------------------
function scoreClarityDimension(prompt: string): number {
  const hasVerb = /\b(create|write|explain|analyze|implement|fix|build|list|summarize|compare|find|help|show|tell|make)\b/i.test(prompt);
  const hasObject = prompt.trim().split(/\s+/).length > 5;
  const hasQuestionOrGoal = /[?]|^(what|how|why|when|where|who|create|write|build|explain)/im.test(prompt);

  let score = 0;
  if (hasVerb) score += 0.8;
  if (hasObject) score += 0.8;
  if (hasQuestionOrGoal) score += 0.4;
  return Math.min(2, score);
}

// ---------------------------------------------------------------------------
// Specificity scoring (0-2 points)
// Specific > vague
// ---------------------------------------------------------------------------
function scoreSpecificityDimension(prompt: string): number {
  const vagueTerms = (prompt.match(/\b(something|somehow|kind of|sort of|maybe|perhaps|it|this|that)\b/gi) || []).length;
  const specificTerms = (prompt.match(/\b(specifically|exactly|precisely|in particular|defined as|must be|should be)\b/gi) || []).length;
  const hasNumbers = /\b\d+\b/.test(prompt);
  const hasCodeOrPaths = /(`[^`]+`|\/[\w/.-]+|\bv\d+)/.test(prompt);

  let score = 2;
  score -= Math.min(1, vagueTerms * 0.2);
  score += Math.min(0.5, specificTerms * 0.2);
  if (hasNumbers) score = Math.min(2, score + 0.3);
  if (hasCodeOrPaths) score = Math.min(2, score + 0.3);
  return Math.max(0, score);
}

// ---------------------------------------------------------------------------
// Main scorer
// ---------------------------------------------------------------------------
export function scorePrompt(prompt: string): ScoreBreakdown {
  const rules = checkAllRules(prompt);
  const lengthScore = scoreLengthDimension(prompt);
  const clarityScore = scoreClarityDimension(prompt);
  const specificityScore = scoreSpecificityDimension(prompt);

  // rules.score is already 0-10 based on violations
  // We blend: 60% from rule compliance + 40% from dimensions
  const dimensionScore = ((lengthScore + clarityScore + specificityScore) / 6) * 10;
  const total = Math.round((rules.score * 0.6 + dimensionScore * 0.4) * 10) / 10;

  return {
    rules,
    lengthScore,
    clarityScore,
    specificityScore,
    total,
    grade: gradeFromScore(total),
  };
}

// ---------------------------------------------------------------------------
// Format score as human-readable summary
// ---------------------------------------------------------------------------
export function formatScoreSummary(before: ScoreBreakdown, after: ScoreBreakdown): string {
  const delta = after.total - before.total;
  const deltaStr = delta >= 0 ? `+${delta.toFixed(1)}` : delta.toFixed(1);
  const lines = [
    `Score: ${before.total}/10 (${before.grade}) → ${after.total}/10 (${after.grade})  [${deltaStr}]`,
  ];

  if (after.rules.violations.length > 0) {
    lines.push("\nRemaining suggestions:");
    for (const v of after.rules.violations) {
      lines.push(`  • [${v.severity}] ${v.suggestion}`);
    }
  }

  return lines.join("\n");
}
