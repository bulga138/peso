/**
 * Research-backed prompt optimization rules.
 *
 * Sources:
 *  - Stanford/Anthropic: position sensitivity (critical info in first 15%)
 *  - meta-introspector pipeline: nesting depth, instruction ratio, priority system
 *  - OPRO (DeepMind): step-by-step breathing
 *  - Microsoft research: emotional stimuli
 */

export interface RuleViolation {
  rule: string;
  severity: "low" | "medium" | "high";
  description: string;
  suggestion: string;
}

export interface RuleCheckResult {
  violations: RuleViolation[];
  score: number; // 0-10
}

// ---------------------------------------------------------------------------
// Rule 1: Position Sensitivity
// Critical instructions must appear in the first ~15% of the prompt.
// ---------------------------------------------------------------------------
export function checkPositionSensitivity(prompt: string): RuleViolation | null {
  const lines = prompt.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 4) return null; // too short to apply

  const criticalKeywords = [
    /\bdo not\b/i,
    /\bnever\b/i,
    /\bmust\b/i,
    /\brequired\b/i,
    /\bcritical\b/i,
    /\bimportant\b/i,
    /\bonly\b/i,
  ];

  const threshold = Math.max(1, Math.floor(lines.length * 0.15));
  const lateLines = lines.slice(threshold);

  const lateViolations = lateLines.filter((line) =>
    criticalKeywords.some((re) => re.test(line))
  );

  if (lateViolations.length > 0) {
    return {
      rule: "position-sensitivity",
      severity: "high",
      description: `${lateViolations.length} critical instruction(s) found after the first 15% of the prompt.`,
      suggestion:
        "Move critical rules (do not, never, must, required) to the first paragraph of your prompt.",
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rule 2: Nesting Depth
// XML/structured nesting should not exceed 4 levels.
// ---------------------------------------------------------------------------
export function checkNestingDepth(prompt: string): RuleViolation | null {
  let maxDepth = 0;
  let depth = 0;
  const tagPattern = /<(\/?)[a-zA-Z][^>]*>/g;
  let match: RegExpExecArray | null;

  while ((match = tagPattern.exec(prompt)) !== null) {
    if (match[1] === "/") {
      depth = Math.max(0, depth - 1);
    } else {
      depth++;
      maxDepth = Math.max(maxDepth, depth);
    }
  }

  if (maxDepth > 4) {
    return {
      rule: "nesting-depth",
      severity: "medium",
      description: `XML/structured nesting depth is ${maxDepth} (max recommended: 4).`,
      suggestion:
        "Flatten nested structures. Use attributes instead of child elements where possible.",
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rule 3: Instruction Ratio
// Instructions should be 40-50% of total content.
// ---------------------------------------------------------------------------
export function checkInstructionRatio(prompt: string): RuleViolation | null {
  const words = prompt.split(/\s+/).filter(Boolean);
  if (words.length < 20) return null;

  const instructionVerbs =
    /\b(do|don't|avoid|ensure|make sure|always|never|use|output|return|write|create|generate|list|explain|describe|analyze|check|verify|format|include|exclude)\b/gi;
  const instructionWords = (prompt.match(instructionVerbs) || []).length;
  const ratio = instructionWords / words.length;

  if (ratio < 0.1) {
    return {
      rule: "instruction-ratio",
      severity: "low",
      description: `Instruction density is low (~${Math.round(ratio * 100)}%). Aim for 40-50%.`,
      suggestion:
        "Add explicit directives: what to do, what to avoid, how to format the output.",
    };
  }
  if (ratio > 0.7) {
    return {
      rule: "instruction-ratio",
      severity: "low",
      description: `Instruction density is very high (~${Math.round(ratio * 100)}%). Add more context and examples.`,
      suggestion:
        "Balance instructions with context, examples, and role definition.",
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rule 4: Single Source of Truth
// Duplicate rule definitions increase cognitive load and risk contradiction.
// ---------------------------------------------------------------------------
export function checkDuplicateRules(prompt: string): RuleViolation | null {
  const sentences = prompt
    .split(/[.!?\n]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 15);

  const seen = new Map<string, number>();
  for (const sentence of sentences) {
    // Use first 40 chars as a rough fingerprint
    const key = sentence.slice(0, 40);
    seen.set(key, (seen.get(key) || 0) + 1);
  }

  const dupes = [...seen.entries()].filter(([, count]) => count > 1);
  if (dupes.length > 0) {
    return {
      rule: "single-source-of-truth",
      severity: "low",
      description: `${dupes.length} potentially duplicated instruction(s) detected.`,
      suggestion:
        "Define each rule once. Reference it with a short label instead of repeating.",
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rule 5: Priority Clarity
// Prompts should signal what matters most (safety > workflow > optimization).
// ---------------------------------------------------------------------------
export function checkPriorityClarity(prompt: string): RuleViolation | null {
  const hasPriority =
    /\b(first|most important|priority|critical|above all|before anything)\b/i.test(
      prompt
    );
  const wordCount = prompt.split(/\s+/).filter(Boolean).length;

  if (!hasPriority && wordCount > 60) {
    return {
      rule: "priority-clarity",
      severity: "low",
      description: "No explicit priority ordering found in prompt.",
      suggestion:
        "Add a priority statement: e.g. 'Most importantly, …' or structure as Safety > Workflow > Optimization.",
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rule 6: Step-by-step breathing (DeepMind OPRO)
// Long complex tasks benefit from explicit step-by-step invitation.
// ---------------------------------------------------------------------------
export function checkStepByStep(prompt: string): RuleViolation | null {
  const wordCount = prompt.split(/\s+/).filter(Boolean).length;
  const hasStepInvite =
    /\b(step.?by.?step|think through|break.?down|one step at a time|work through)\b/i.test(
      prompt
    );

  if (wordCount > 80 && !hasStepInvite) {
    return {
      rule: "step-by-step",
      severity: "low",
      description:
        "Complex prompt without a step-by-step invitation. Models perform better with explicit reasoning guidance.",
      suggestion:
        "Append: 'Take a deep breath and work through this step-by-step.'",
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Composite checker — run all rules
// ---------------------------------------------------------------------------
export function checkAllRules(prompt: string): RuleCheckResult {
  const checks = [
    checkPositionSensitivity(prompt),
    checkNestingDepth(prompt),
    checkInstructionRatio(prompt),
    checkDuplicateRules(prompt),
    checkPriorityClarity(prompt),
    checkStepByStep(prompt),
  ];

  const violations = checks.filter(Boolean) as RuleViolation[];

  const penaltyMap: Record<RuleViolation["severity"], number> = {
    high: 2.5,
    medium: 1.5,
    low: 0.5,
  };

  const totalPenalty = violations.reduce(
    (acc, v) => acc + penaltyMap[v.severity],
    0
  );
  const score = Math.max(0, Math.min(10, 10 - totalPenalty));

  return { violations, score };
}
