/**
 * Classifier + Argument Intelligence
 *
 * Classifies an incoming prompt into:
 *  - domain: code | general | creative | research
 *  - intent: the primary goal
 *  - complexity: simple | medium | complex
 *  - slots: goal, constraints, references, validation criteria
 *  - ambiguity: boolean + list of unclear dimensions
 *
 * Inspired by diegohb gist: auto-classifying inputs into
 * goal/reference/validation slots.
 */

export type Domain = "code" | "general" | "creative" | "research";
export type Complexity = "simple" | "medium" | "complex";
export type RoutingDecision = "passthrough" | "clarify" | "enhance" | "search" | "rewrite";

export interface ArgumentSlots {
  goal: string | null;         // What is the primary objective?
  constraints: string[];       // Explicit limitations or requirements
  references: string[];        // Referenced artifacts, files, APIs, concepts
  validation: string[];        // How should the output be judged/tested?
}

export interface ClassificationResult {
  domain: Domain;
  complexity: Complexity;
  ambiguityScore: number;      // 0-1 (0 = crystal clear, 1 = totally ambiguous)
  ambiguousDimensions: string[]; // Which dimensions are unclear
  slots: ArgumentSlots;
  suggestedRouting: RoutingDecision;
  needsFreshInfo: boolean;
}

// ---------------------------------------------------------------------------
// Domain detection
// ---------------------------------------------------------------------------
const DOMAIN_PATTERNS: Record<Domain, RegExp[]> = {
  code: [
    /\b(code|function|class|method|bug|error|implement|refactor|test|debug|typescript|javascript|python|java|sql|api|endpoint|component|module|package|library)\b/i,
  ],
  research: [
    /\b(research|analyze|explain|what is|how does|why does|compare|difference|study|literature|paper|document|fact|data|statistic)\b/i,
  ],
  creative: [
    /\b(write|story|poem|creative|fiction|narrative|character|dialogue|blog post|essay|copywriting|marketing)\b/i,
  ],
  general: [], // fallback
};

export function detectDomain(prompt: string): Domain {
  const scores: Record<Domain, number> = { code: 0, research: 0, creative: 0, general: 0 };

  for (const [domain, patterns] of Object.entries(DOMAIN_PATTERNS) as [Domain, RegExp[]][]) {
    for (const pattern of patterns) {
      const matches = prompt.match(new RegExp(pattern.source, "gi"));
      if (matches) scores[domain] += matches.length;
    }
  }

  const best = (Object.entries(scores) as [Domain, number][]).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : "general";
}

// ---------------------------------------------------------------------------
// Complexity detection
// ---------------------------------------------------------------------------
export function detectComplexity(prompt: string): Complexity {
  const wordCount = prompt.split(/\s+/).filter(Boolean).length;
  const hasList = /(\n\s*[-*\d]|\band\b.*\band\b)/i.test(prompt);
  const hasMultiGoal = (prompt.match(/\b(also|additionally|furthermore|and then|as well as)\b/gi) || []).length > 1;

  if (wordCount > 100 || (hasList && hasMultiGoal)) return "complex";
  if (wordCount > 30 || hasList || hasMultiGoal) return "medium";
  return "simple";
}

// ---------------------------------------------------------------------------
// Ambiguity detection
// ---------------------------------------------------------------------------
const AMBIGUITY_INDICATORS: Array<{ pattern: RegExp; dimension: string }> = [
  { pattern: /\b(something|somehow|kind of|sort of|maybe|perhaps|probably)\b/i, dimension: "vague intent" },
  { pattern: /^(do|make|create|fix|update|change)\s+\w+\s*$/i, dimension: "underspecified action" },
  { pattern: /\b(it|this|that|these|those|them)\b/i, dimension: "ambiguous pronoun reference" },
  { pattern: /\b(best|good|nice|better|proper)\b/i, dimension: "undefined quality criterion" },
  { pattern: /\?.*\?/s, dimension: "multiple questions bundled" },
];

export function detectAmbiguity(prompt: string): { score: number; dimensions: string[] } {
  const dimensions: string[] = [];
  let score = 0;

  for (const { pattern, dimension } of AMBIGUITY_INDICATORS) {
    if (pattern.test(prompt)) {
      dimensions.push(dimension);
      score += 0.2;
    }
  }

  // Very short prompts are inherently ambiguous
  if (prompt.trim().split(/\s+/).length < 8) {
    dimensions.push("very short / underspecified");
    score += 0.3;
  }

  return { score: Math.min(1, score), dimensions };
}

// ---------------------------------------------------------------------------
// Argument slot extraction
// ---------------------------------------------------------------------------
export function extractSlots(prompt: string): ArgumentSlots {
  // Goal: first imperative sentence or the main verb phrase
  const goalMatch = prompt.match(/^([A-Z][^.!?\n]{5,80}[.!?]?)/m);
  const goal = goalMatch ? goalMatch[1].trim() : null;

  // Constraints: sentences with limiting language
  const constraintMatches = prompt.match(
    /[^.!?\n]*\b(must|should|only|never|always|no more than|at least|within|limit|avoid|exclude)[^.!?\n]*/gi
  ) || [];
  const constraints = constraintMatches.map((s) => s.trim());

  // References: file paths, URLs, version numbers, quoted identifiers
  const refMatches = prompt.match(
    /(?:https?:\/\/\S+|\/[\w/.-]+\.\w+|`[^`]+`|"[^"]+"|\bv\d+\.\d+[\.\d]*\b)/g
  ) || [];
  const references = [...new Set(refMatches)];

  // Validation: sentences with testing/checking language
  const validationMatches = prompt.match(
    /[^.!?\n]*\b(test|verify|check|confirm|ensure|validate|assert|expect|should return|should output)[^.!?\n]*/gi
  ) || [];
  const validation = validationMatches.map((s) => s.trim());

  return { goal, constraints, references, validation };
}

// ---------------------------------------------------------------------------
// Routing decision
// ---------------------------------------------------------------------------
export function decideRouting(
  complexity: Complexity,
  ambiguityScore: number,
  needsFreshInfo: boolean,
  mode: "auto" | "code" | "general" | "creative" | "research"
): RoutingDecision {
  // Explicit domain modes always rewrite
  if (mode !== "auto") return "rewrite";

  // Auto mode logic
  if (ambiguityScore >= 0.5) return "clarify";
  if (needsFreshInfo) return "search";
  if (complexity === "simple" && ambiguityScore < 0.2) return "passthrough";
  return "enhance";
}

// ---------------------------------------------------------------------------
// Main classifier
// ---------------------------------------------------------------------------
export function classify(
  prompt: string,
  mode: "auto" | "code" | "general" | "creative" | "research" = "auto"
): ClassificationResult {
  const domain = mode === "auto" ? detectDomain(prompt) : (mode as Domain);
  const complexity = detectComplexity(prompt);
  const { score: ambiguityScore, dimensions: ambiguousDimensions } = detectAmbiguity(prompt);
  const slots = extractSlots(prompt);

  // Fresh info detection (imported pattern from context-gatherer)
  const stalePatterns = [
    /\b(latest|current|newest|recent|up.?to.?date)\b/i,
    /\b(202[5-9]|203\d)\b/,
    /\b(today|this week|this month|this year)\b/i,
  ];
  const needsFreshInfo = stalePatterns.some((p) => p.test(prompt));

  const suggestedRouting = decideRouting(complexity, ambiguityScore, needsFreshInfo, mode);

  return {
    domain,
    complexity,
    ambiguityScore,
    ambiguousDimensions,
    slots,
    suggestedRouting,
    needsFreshInfo,
  };
}

// ---------------------------------------------------------------------------
// Generate clarifying questions for ambiguous prompts
// ---------------------------------------------------------------------------
export function generateClarifyingQuestions(
  classification: ClassificationResult
): string[] {
  const questions: string[] = [];
  const { ambiguousDimensions, slots, domain } = classification;

  if (ambiguousDimensions.includes("vague intent")) {
    questions.push("What is the specific outcome you're looking for? What does success look like?");
  }
  if (ambiguousDimensions.includes("underspecified action")) {
    questions.push("Can you describe in more detail what you want changed or created?");
  }
  if (ambiguousDimensions.includes("ambiguous pronoun reference")) {
    questions.push("Can you replace pronouns (it, this, that) with explicit names or descriptions?");
  }
  if (ambiguousDimensions.includes("undefined quality criterion")) {
    questions.push("How will you judge whether the result is 'good' or 'correct'?");
  }
  if (ambiguousDimensions.includes("very short / underspecified")) {
    questions.push("Could you expand on your request? The more context you provide, the better the result.");
  }
  if (slots.constraints.length === 0 && domain === "code") {
    questions.push("Are there any constraints — performance, language, framework, code style?");
  }
  if (slots.validation.length === 0 && domain === "code") {
    questions.push("How should the output be tested or validated?");
  }

  return questions.slice(0, 3); // max 3 questions to avoid overwhelming
}
