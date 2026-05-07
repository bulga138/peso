/**
 * 26 Principled Instructions for prompt enhancement.
 *
 * Source: VILA-Lab paper "Principled Instructions Are Worth It"
 * (lim-hyo-jeong/Prompt-Enhancer — https://github.com/lim-hyo-jeong/Prompt-Enhancer)
 *
 * Each technique has a short ID, a description, an applicability check,
 * and an injection function that appends or prepends the technique to a prompt.
 */

/**
 * Model capability tier.
 *
 * - frontier: large reasoning models (Opus, GPT-4o, o1/o3, Gemini 2.5 Pro, claude-4)
 * - small:    lightweight models (Haiku, GPT-4o-mini, Gemini Flash, Phi, Llama)
 * - standard: everything else (Sonnet, GPT-4-turbo, etc.)
 */
export type ModelTier = "frontier" | "standard" | "small";

/**
 * Derive a ModelTier from a raw model ID string.
 * Matching is case-insensitive substring; falls back to "standard".
 */
export function resolveModelTier(modelId?: string): ModelTier {
  if (!modelId) return "standard";
  const id = modelId.toLowerCase();

  const frontierPatterns = [
    "opus",
    "gpt-4o",       // but NOT gpt-4o-mini — checked after small below
    "o1-",
    "o3-",
    "/o1",
    "/o3",
    "gemini-2.5-pro",
    "gemini-ultra",
    "claude-4",
  ];
  const smallPatterns = [
    "haiku",
    "gpt-4o-mini",
    "gemini-flash",
    "phi-",
    "/phi",
    "llama",
    "mistral-7b",
    "mistral-8x7b",
  ];

  // Check small first so "gpt-4o-mini" is not caught by "gpt-4o" frontier check
  if (smallPatterns.some((p) => id.includes(p))) return "small";
  if (frontierPatterns.some((p) => id.includes(p))) return "frontier";
  return "standard";
}

export interface Technique {
  id: string;
  name: string;
  description: string;
  domains: ("code" | "general" | "creative" | "research" | "all")[];
  /**
   * Optional list of model tiers for which this technique should be SKIPPED.
   * e.g. `excludeTiers: ["frontier"]` means the technique won't be applied
   * when the active model is a frontier-class model.
   */
  excludeTiers?: ModelTier[];
  applies: (prompt: string) => boolean;
  inject: (prompt: string) => string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function append(prompt: string, suffix: string): string {
  return `${prompt.trimEnd()}\n\n${suffix}`;
}

function prepend(prompt: string, prefix: string): string {
  return `${prefix}\n\n${prompt.trimStart()}`;
}

function hasPattern(prompt: string, ...patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(prompt));
}

// ---------------------------------------------------------------------------
// Techniques
// ---------------------------------------------------------------------------
export const TECHNIQUES: Technique[] = [
  // 1. No politeness padding
  {
    id: "no-politeness",
    name: "Remove Politeness Padding",
    description: "Avoid filler phrases like 'please', 'if possible', 'could you'.",
    domains: ["all"],
    applies: (p) => hasPattern(p, /\bplease\b/i, /\bcould you\b/i, /\bif you could\b/i),
    inject: (p) =>
      p
        .replace(/\bplease\b\s*/gi, "")
        .replace(/\bcould you\b/gi, "")
        .replace(/\bif you could\b/gi, "")
        .replace(/\s{2,}/g, " ")
        .trim(),
  },

  // 2. Audience specification → system prompt (via SYSTEM_TECHNIQUES)
  {
    id: "audience-spec",
    name: "Specify Audience",
    description: "Tell the model who the output is for.",
    domains: ["general", "creative", "research"],
    applies: (p) => !hasPattern(p, /\baudience\b/i, /\bfor a\b/i, /\bfor an\b/i),
    inject: (p) => append(p, "The audience is a technical professional familiar with the domain."),
  },

  // 3. Positive framing
  {
    id: "positive-framing",
    name: "Positive Framing",
    description: "Prefer 'do X' over 'don't do Y' where possible.",
    domains: ["all"],
    applies: (p) => {
      const negCount = (p.match(/\bdon't\b|\bdo not\b|\bnever\b/gi) || []).length;
      return negCount > 3;
    },
    inject: (p) => append(p, "Focus instructions on what TO do rather than what to avoid."),
  },

  // 4. Expert role assignment
  {
    id: "expert-role",
    name: "Expert Role Assignment",
    description: "Assign a relevant expert role to the model.",
    domains: ["code", "research"],
    applies: (p) => !hasPattern(p, /\byou are\b/i, /\bact as\b/i, /\bbehave as\b/i, /\brole\b/i),
    inject: (p) => prepend(p, "You are an expert software engineer and technical architect."),
  },

  // 5. Output format specification
  {
    id: "output-format",
    name: "Output Format Specification",
    description: "Explicitly state the desired output format.",
    domains: ["code", "general", "research"],
    applies: (p) =>
      !hasPattern(
        p,
        /\bformat\b/i,
        /\bjson\b/i,
        /\bmarkdown\b/i,
        /\blist\b/i,
        /\btable\b/i,
        /\bbullet\b/i,
        /\bresponse should be\b/i
      ),
    inject: (p) => append(p, "Format your response clearly with headers and concise bullet points where appropriate."),
  },

  // 6. Example inclusion
  {
    id: "include-examples",
    name: "Include Examples",
    description: "Ask the model to include examples in complex explanations.",
    domains: ["general", "code", "research"],
    applies: (p) =>
      !hasPattern(p, /\bexample\b/i, /\bfor instance\b/i, /\be\.g\b/i) &&
      p.split(" ").length > 30,
    inject: (p) => append(p, "Include concrete examples to illustrate key points."),
  },

  // 7. Step-by-step invitation (DeepMind OPRO)
  // Excluded for frontier models: they reason well without this nudge.
  {
    id: "step-by-step",
    name: "Step-by-Step Invitation",
    description: "Invite the model to reason step-by-step for complex tasks.",
    domains: ["code", "research", "general"],
    excludeTiers: ["frontier", "standard"],
    applies: (p) =>
      !hasPattern(p, /step.?by.?step/i, /think through/i, /break.?down/i) &&
      p.split(" ").length > 60,
    inject: (p) => append(p, "Take a deep breath and work through this step-by-step."),
  },

  // 8. Emotional stimuli (Microsoft research)
  // Excluded for frontier models: flattery/motivation framing adds noise.
  {
    id: "emotional-stimuli",
    name: "Emotional Stimuli",
    description: "Add motivation framing to improve output quality.",
    domains: ["general", "creative"],
    excludeTiers: ["frontier", "standard"],
    applies: (p) =>
      !hasPattern(p, /important to my/i, /matters a lot/i, /high stakes/i),
    inject: (p) => append(p, "This is very important — please be thorough and precise."),
  },

  // 9. Constraint specification → system prompt (via SYSTEM_TECHNIQUES)
  {
    id: "constraints",
    name: "Constraint Specification",
    description: "Make constraints explicit (length, scope, performance).",
    domains: ["code", "general"],
    applies: (p) =>
      !hasPattern(p, /\bmax\b/i, /\blimit\b/i, /\bno more than\b/i, /\bwithin\b/i, /\bconcise\b/i),
    inject: (p) => append(p, "Keep the response concise and focused. Avoid unnecessary elaboration."),
  },

  // 10. Chain-of-thought trigger
  {
    id: "chain-of-thought",
    name: "Chain-of-Thought Trigger",
    description: "Trigger chain-of-thought reasoning for analytical tasks.",
    domains: ["research", "code"],
    excludeTiers: ["frontier", "standard"],
    applies: (p) =>
      hasPattern(p, /\bwhy\b/i, /\banalyze\b/i, /\bexplain\b/i, /\breason\b/i) &&
      !hasPattern(p, /\blet's think\b/i, /\bchain of thought\b/i),
    inject: (p) => append(p, "Let's think about this carefully before answering."),
  },

  // 11. Context window anchoring
  {
    id: "context-anchor",
    name: "Context Window Anchoring",
    description: "Repeat the core objective at the end of long prompts.",
    domains: ["all"],
    applies: (p) => p.split(" ").length > 150,
    inject: (p) => {
      const firstSentence = p.split(/[.!?\n]/)[0]?.trim() || "";
      return append(p, `Reminder of the core objective: ${firstSentence}`);
    },
  },

  // 12. Negative example (what NOT to do)
  {
    id: "negative-example",
    name: "Negative Example",
    description: "Provide an example of what the output should NOT look like.",
    domains: ["code", "general"],
    applies: (p) =>
      hasPattern(p, /\bexample\b/i) &&
      !hasPattern(p, /\bbad example\b/i, /\bnot like\b/i, /\bavoid this\b/i),
    inject: (p) => append(p, "If relevant, briefly note what an incorrect or poor response would look like."),
  },

  // 13. Persona consistency
  {
    id: "persona-consistency",
    name: "Persona Consistency",
    description: "Ensure the model maintains a consistent persona throughout.",
    domains: ["creative", "general"],
    applies: (p) => hasPattern(p, /\bact as\b/i, /\byou are\b/i, /\bpretend\b/i),
    inject: (p) => append(p, "Maintain this persona consistently throughout your entire response."),
  },

  // 14. Structured output request
  {
    id: "structured-output",
    name: "Structured Output Request",
    description: "Request structured/parseable output for programmatic use.",
    domains: ["code"],
    applies: (p) =>
      hasPattern(p, /\bjson\b/i, /\bxml\b/i, /\byaml\b/i, /\bcsv\b/i) &&
      !hasPattern(p, /\bstrict\b/i, /\bvalid\b/i, /\bparseable\b/i),
    inject: (p) => append(p, "Output must be valid and parseable. Do not include explanatory text inside the structured block."),
  },

  // 15. Scope limitation
  {
    id: "scope-limit",
    name: "Scope Limitation",
    description: "Prevent scope creep by bounding the response.",
    domains: ["all"],
    applies: (p) =>
      !hasPattern(p, /\bonly\b/i, /\bjust\b/i, /\bfocus on\b/i, /\bscoped to\b/i) &&
      p.split(" ").length > 40,
    inject: (p) => append(p, "Focus only on what is explicitly asked. Do not add unsolicited suggestions or scope expansions."),
  },

  // 16. Uncertainty acknowledgement
  {
    id: "uncertainty",
    name: "Uncertainty Acknowledgement",
    description: "Ask the model to flag uncertainty rather than hallucinate.",
    domains: ["research", "general"],
    applies: (p) =>
      hasPattern(p, /\bfact\b/i, /\baccurate\b/i, /\blatest\b/i, /\bcurrent\b/i, /\brecent\b/i),
    inject: (p) => append(p, "If you are uncertain about any fact, clearly state your uncertainty rather than guessing."),
  },

  // 17. Language register specification
  {
    id: "language-register",
    name: "Language Register",
    description: "Specify formal, informal, or technical language register.",
    domains: ["general", "creative"],
    applies: (p) =>
      !hasPattern(p, /\bformal\b/i, /\binformal\b/i, /\btechnical\b/i, /\bplain language\b/i, /\blayman\b/i),
    inject: (p) => append(p, "Use clear, professional language appropriate for a technical audience."),
  },

  // 18. Tool/resource reference
  {
    id: "tool-reference",
    name: "Tool Reference",
    description: "Explicitly mention relevant tools or resources the model should use.",
    domains: ["code", "research"],
    applies: (p) =>
      !hasPattern(p, /\btool\b/i, /\bfunction\b/i, /\bapi\b/i, /\bcommand\b/i) &&
      hasPattern(p, /\bsearch\b/i, /\blook up\b/i, /\bfind\b/i),
    inject: (p) => append(p, "Use available tools (search, file read, code execution) to fulfil this task rather than relying solely on training knowledge."),
  },

  // 19. Verification request
  {
    id: "verify",
    name: "Verification Request",
    description: "Ask the model to verify its answer before responding.",
    domains: ["code", "research"],
    applies: (p) =>
      hasPattern(p, /\bwrite\b/i, /\bcreate\b/i, /\bimplement\b/i, /\bbuild\b/i) &&
      !hasPattern(p, /\bverify\b/i, /\bcheck\b/i, /\btest\b/i),
    inject: (p) => append(p, "Verify your solution is correct before presenting it."),
  },

  // 20. Brevity instruction
  {
    id: "brevity",
    name: "Brevity Instruction",
    description: "Explicitly request concise responses when verbosity is not needed.",
    domains: ["general", "code"],
    applies: (p) =>
      !hasPattern(p, /\bbrief\b/i, /\bconcise\b/i, /\bshort\b/i, /\bsummary\b/i) &&
      p.split(" ").length < 40,
    inject: (p) => append(p, "Keep your response brief and to the point."),
  },

  // 21. Language specification (non-English guard)
  {
    id: "language-spec",
    name: "Language Specification",
    description: "Specify response language to avoid mixed-language outputs.",
    domains: ["all"],
    applies: (p) => !hasPattern(p, /\bin english\b/i, /\brespond in\b/i, /\banswer in\b/i),
    inject: (p) => append(p, "Respond in the same language as this prompt."),
  },

  // 22. No-hallucination anchor
  {
    id: "no-hallucination",
    name: "No-Hallucination Anchor",
    description: "Explicitly prohibit making up information.",
    domains: ["research", "general"],
    applies: (p) => hasPattern(p, /\bfact\b/i, /\bdata\b/i, /\bstatistic\b/i, /\bsource\b/i),
    inject: (p) => append(p, "Do not fabricate data, statistics, or citations. If you do not know, say so."),
  },

  // 23. Code quality standards
  {
    id: "code-quality",
    name: "Code Quality Standards",
    description: "Set explicit code quality expectations.",
    domains: ["code"],
    applies: (p) =>
      hasPattern(p, /\bcode\b/i, /\bfunction\b/i, /\bimplement\b/i, /\bwrite a\b/i) &&
      !hasPattern(p, /\bclean\b/i, /\btested\b/i, /\btype.?safe\b/i),
    inject: (p) => append(p, "Write clean, type-safe code with meaningful variable names. Include brief comments for non-obvious logic."),
  },

  // 24. Iteration permission
  {
    id: "iteration-permission",
    name: "Iteration Permission",
    description: "Allow the model to ask clarifying questions before proceeding.",
    domains: ["all"],
    applies: (p) =>
      !hasPattern(p, /\bask\b/i, /\bclarif\b/i, /\bquestion\b/i) &&
      p.split(" ").length < 25,
    inject: (p) => prepend(p, "If this request is ambiguous, ask one clarifying question before proceeding."),
  },

  // 25. Output length guidance
  {
    id: "output-length",
    name: "Output Length Guidance",
    description: "Provide guidance on expected response length.",
    domains: ["general", "creative"],
    applies: (p) =>
      !hasPattern(p, /\bword\b/i, /\bparagraph\b/i, /\bsentence\b/i, /\blines?\b/i),
    inject: (p) => append(p, "Aim for a response that is complete but not padded — quality over length."),
  },

  // 26. Decomposition request
  {
    id: "decompose",
    name: "Decomposition Request",
    description: "Ask the model to decompose complex tasks into subtasks.",
    domains: ["code", "research"],
    excludeTiers: ["frontier", "standard"],
    applies: (p) =>
      hasPattern(p, /\bcomplex\b/i, /\blarge\b/i, /\bcomprehensive\b/i, /\bfull\b/i) &&
      !hasPattern(p, /\bbreak.?down\b/i, /\bsubtask\b/i, /\bdecompose\b/i),
    inject: (p) => prepend(p, "Break this task down into clear subtasks before executing each one."),
  },
];

// ---------------------------------------------------------------------------
// Apply a subset of techniques to a prompt
// ---------------------------------------------------------------------------
export function applyTechniques(
  prompt: string,
  techniqueIds: string[],
  domain: "code" | "general" | "creative" | "research" = "general",
  modelId?: string
): string {
  const tier = resolveModelTier(modelId);
  let result = prompt;
  for (const id of techniqueIds) {
    const technique = TECHNIQUES.find((t) => t.id === id);
    if (!technique) continue;
    // Skip technique if current model tier is excluded
    if (technique.excludeTiers?.includes(tier)) continue;
    const domainMatch =
      technique.domains.includes("all") || technique.domains.includes(domain);
    if (domainMatch && technique.applies(result)) {
      result = technique.inject(result);
    }
  }
  return result;
}

// Auto-select applicable techniques for a prompt + domain
export function autoSelectTechniques(
  prompt: string,
  domain: "code" | "general" | "creative" | "research",
  modelId?: string
): Technique[] {
  const tier = resolveModelTier(modelId);
  return TECHNIQUES.filter((t) => {
    // Skip technique if current model tier is excluded
    if (t.excludeTiers?.includes(tier)) return false;
    const domainMatch =
      t.domains.includes("all") || t.domains.includes(domain);
    return domainMatch && t.applies(prompt);
  });
}
