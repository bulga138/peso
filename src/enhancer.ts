/**
 * Enhancement Pipeline — 10-stage prompt optimization.
 *
 * Architecture: produces TWO outputs:
 *  - systemPrompt: role, constraints, output format (from templates + techniques)
 *  - userPrompt: the user's actual task, cleaned up and contextualized
 *
 * This separation prevents bloating the user prompt with boilerplate.
 */

import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import {
  autoSelectTechniques,
  applyTechniques,
  loadTechniquePacks,
  TECHNIQUES,
  resolveModelTier,
  type Technique,
} from './techniques.js'
import { gatherContext, formatContextBlock } from './context-gatherer.js'
import { scorePrompt, type ScoreBreakdown } from './scorer.js'
import type { ClassificationResult, Domain, Complexity } from './classifier.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// Pack technique cache — loaded once, passed to pipeline calls
// ---------------------------------------------------------------------------
let _extraTechniques: Technique[] = []

/**
 * Pre-load external technique packs.
 * Called once from plugin.ts on startup; safe to call multiple times.
 */
/**
 * Load external technique packs from discovered global paths.
 *
 * @param packPaths   Absolute paths from discoverGlobalPacks()
 * @param packConfig  enabled/disabled config from peso.json
 */
export async function initTechniquePacks(
  packPaths: string[],
  packConfig?: { enabled: 'all' | string[]; disabled: string[] }
): Promise<void> {
  if (packPaths.length === 0) return
  _extraTechniques = await loadTechniquePacks(packPaths, packConfig)
}

/** Subset of the SDK Agent.permission shape we care about for compass classification */
export interface AgentPermissions {
  edit: 'ask' | 'allow' | 'deny'
  bash: Record<string, 'ask' | 'allow' | 'deny'> | 'ask' | 'allow' | 'deny'
  webfetch?: 'ask' | 'allow' | 'deny'
  /** Optional: agent description text from AGENTS.md / agent config */
  description?: string
  /** Optional: subagent mode ("subagent" | "primary" | "all") */
  mode?: string
}

export interface ToolPriorities {
  prefer: string[]
  avoid: string[]
}

export interface ContextConfig {
  injectGitBranch?: boolean
  injectGitChangedFiles?: boolean
  injectGitLastCommit?: boolean
  maxChangedFiles?: number
}

export interface EnhancementOptions {
  domain: Domain
  injectContext: boolean
  cwd?: string
  mcpTools?: string[] // MCP + plugin tool IDs from SDK
  toolPriorities?: ToolPriorities // tool cost hints for context injection
  contextConfig?: ContextConfig // per-field git context control
  selectedTechniqueIds?: string[]
  skipStages?: StageId[]
  agent?: string // agent name — used as secondary signal
  agentPermissions?: AgentPermissions // PRIMARY signal for compass classification
  modelId?: string // active model ID — used for tier-aware technique filtering
}

export type StageId =
  | 'analyze'
  | 'elevate-critical'
  | 'flatten-nesting'
  | 'optimize-ratio'
  | 'consolidate'
  | 'add-priority'
  | 'inject-context'
  | 'apply-techniques'
  | 'validate'
  | 'deliver'

export interface StageResult {
  stage: StageId
  applied: boolean
  change: string
}

export interface EnhancementResult {
  original: string
  enhanced: string // The enhanced USER prompt only
  systemPrompt: string // System-level instructions (template, role, format)
  domain: Domain
  scoreBefore: ScoreBreakdown
  scoreAfter: ScoreBreakdown
  stages: StageResult[]
  techniquesApplied: string[]
  needsFreshInfo: boolean
}

// ---------------------------------------------------------------------------
// Template loading
// ---------------------------------------------------------------------------
function loadTemplate(domain: Domain): string {
  try {
    const templatePath = join(__dirname, 'templates', `${domain}.md`)
    return readFileSync(templatePath, 'utf8').trim()
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// Stage: Elevate Critical Rules
// ---------------------------------------------------------------------------
function stageElevateCritical(prompt: string): { result: string; note: string } {
  const paragraphs = prompt.split(/\n\n+/)
  if (paragraphs.length < 2) return { result: prompt, note: 'single paragraph, skipped' }

  const criticalPattern = /\b(do not|never|must|required|critical|important)\b/i
  const critical = paragraphs.filter(p => criticalPattern.test(p))
  const other = paragraphs.filter(p => !criticalPattern.test(p))

  if (critical.length === 0) return { result: prompt, note: 'no critical rules to elevate' }

  return {
    result: [...critical, ...other].join('\n\n'),
    note: `elevated ${critical.length} critical paragraph(s)`,
  }
}

// ---------------------------------------------------------------------------
// Stage: Flatten Nesting (advisory only)
// ---------------------------------------------------------------------------
function stageFlattenNesting(prompt: string): { result: string; note: string } {
  let maxDepth = 0
  let depth = 0
  const tagPattern = /<(\/?)[a-zA-Z][^>]*>/g
  let match: RegExpExecArray | null

  while ((match = tagPattern.exec(prompt)) !== null) {
    if (match[1] === '/') depth = Math.max(0, depth - 1)
    else {
      depth++
      maxDepth = Math.max(maxDepth, depth)
    }
  }

  if (maxDepth <= 4) return { result: prompt, note: `nesting depth ${maxDepth} OK` }
  return { result: prompt, note: `WARNING: nesting depth ${maxDepth} exceeds 4` }
}

// ---------------------------------------------------------------------------
// Stage: Consolidate — remove duplicate sentences
// ---------------------------------------------------------------------------
function stageConsolidate(prompt: string): { result: string; note: string } {
  const sentences = prompt.split(/(?<=[.!?])\s+/)
  const seen = new Set<string>()
  const deduped: string[] = []
  let removed = 0

  for (const s of sentences) {
    const key = s.trim().toLowerCase().slice(0, 60)
    if (!seen.has(key)) {
      seen.add(key)
      deduped.push(s)
    } else removed++
  }

  if (removed === 0) return { result: prompt, note: 'no duplicates found' }
  return { result: deduped.join(' '), note: `removed ${removed} duplicate(s)` }
}

// ---------------------------------------------------------------------------
// Stage: Inject Context
// ---------------------------------------------------------------------------
function stageInjectContext(
  prompt: string,
  options: EnhancementOptions
): { result: string; note: string } {
  if (!options.injectContext) return { result: prompt, note: 'context injection disabled' }

  const ctx = gatherContext(
    options.cwd,
    options.mcpTools,
    options.toolPriorities,
    options.contextConfig
  )
  const block = formatContextBlock(ctx, prompt)

  return {
    result: `${block}\n\n${prompt}`,
    note: `injected context (branch: ${ctx.gitBranch || 'n/a'}, changed: ${ctx.gitChangedFiles.length} files)`,
  }
}

// ---------------------------------------------------------------------------
// Stage: Validate intent preservation
// ---------------------------------------------------------------------------
function stageValidate(original: string, enhanced: string): { result: string; note: string } {
  const origWords = new Set(
    original
      .toLowerCase()
      .split(/\W+/)
      .filter(w => w.length > 3)
  )
  const enhWords = new Set(
    enhanced
      .toLowerCase()
      .split(/\W+/)
      .filter(w => w.length > 3)
  )

  let overlap = 0
  for (const w of origWords) {
    if (enhWords.has(w)) overlap++
  }

  const ratio = origWords.size > 0 ? overlap / origWords.size : 1
  if (ratio < 0.5) {
    return {
      result: enhanced,
      note: `WARNING: low intent preservation (${Math.round(ratio * 100)}%)`,
    }
  }
  return { result: enhanced, note: `intent preserved (${Math.round(ratio * 100)}%)` }
}

// ---------------------------------------------------------------------------
// Select which techniques apply to USER prompt vs SYSTEM prompt
// ---------------------------------------------------------------------------
const SYSTEM_TECHNIQUES = new Set([
  'expert-role', // role assignment → system prompt
  'audience-spec', // audience → system prompt
  'output-format', // format instructions → system prompt
  'structured-output', // parsing rules → system prompt
  'language-register', // tone → system prompt
  'code-quality', // quality standards → system prompt
  'no-hallucination', // safety → system prompt
  'persona-consistency', // persona → system prompt
  // Style/constraint directives — belong in system prompt, not user prompt
  'constraints', // "keep concise" → system prompt
  'brevity', // "keep brief" → system prompt
  'output-length', // "complete but not padded" → system prompt
  'scope-limit', // "focus only on what is asked" → system prompt
  'language-spec', // "respond in same language" → system prompt
  'positive-framing', // "focus on what TO do" → system prompt
])

// ---------------------------------------------------------------------------
// Build system prompt from template + system-level techniques
// ---------------------------------------------------------------------------
function buildSystemPrompt(domain: Domain, userPrompt: string): string {
  const template = loadTemplate(domain)

  // Select system-level techniques that apply
  const systemTechs = TECHNIQUES.filter(t => {
    const domainMatch = t.domains.includes('all') || t.domains.includes(domain)
    const isSystem = SYSTEM_TECHNIQUES.has(t.id)
    return domainMatch && isSystem && t.applies(userPrompt)
  })

  // Template already contains role + format + constraints
  // Only add techniques that the template doesn't already cover
  const extras: string[] = []
  for (const tech of systemTechs) {
    // Skip if template already covers the concern
    if (tech.id === 'expert-role' && template.includes('You are')) continue
    if (tech.id === 'output-format' && template.includes('Output format')) continue
    if (tech.id === 'code-quality' && template.includes('Type safety')) continue
    if (tech.id === 'constraints' && template.includes('Constraints')) continue
    if (tech.id === 'brevity' && template.includes('concise')) continue
    if (tech.id === 'output-length' && template.includes('concise')) continue
    if (tech.id === 'scope-limit' && template.includes('Scope')) continue
    // Apply the rest
    extras.push(tech.inject('').trim())
  }

  if (template && extras.length > 0) {
    return `${template}\n\n${extras.join('\n')}`
  }
  if (template) return template
  if (extras.length > 0) return extras.join('\n\n')
  return ''
}

// ---------------------------------------------------------------------------
// Determine enhancement intensity based on complexity
// ---------------------------------------------------------------------------
function getIntensity(complexity: Complexity): 'light' | 'medium' | 'full' {
  switch (complexity) {
    case 'simple':
      return 'light'
    case 'medium':
      return 'medium'
    case 'complex':
      return 'full'
  }
}

// ---------------------------------------------------------------------------
// Agent Compass — 2-axis vectorized classification
// ---------------------------------------------------------------------------
//
//  Autonomy axis  X: read-only (-1.0) ←——→ write-capable (+1.0)
//  Specificity  axis Y: broad/explore (-1.0) ←——→ focused/task (+1.0)
//
//                  focused (+Y)
//                      |
//  plan / plan-github   |   build / build-github
//       (light) ────────+──────── (full)
//  read-only (-X)       |              write (+X)
//       explore         |   general / api-docs-lookup
//        (none) ────────+──────── (medium)
//                   broad (-Y)
//
// PRIMARY signal: agent.permission.edit + bash  (authoritative, from SDK)
// SECONDARY signal: agent name patterns + description keywords (fallback)

interface AgentVector {
  autonomy: number // -1 read-only → +1 write
  specificity: number // -1 broad     → +1 focused
}

// ---------- PRIMARY: permission-based autonomy ----------
function autonomyFromPermissions(perms: AgentPermissions): number {
  const edit = perms.edit
  const bashRaw = perms.bash
  const bash: 'ask' | 'allow' | 'deny' =
    typeof bashRaw === 'string'
      ? (bashRaw as 'ask' | 'allow' | 'deny')
      : bashRaw != null && typeof bashRaw === 'object'
        ? ((Object.values(bashRaw as Record<string, string>)[0] as
            | 'ask'
            | 'allow'
            | 'deny'
            | undefined) ?? 'ask')
        : 'ask'

  // Both deny → fully read-only
  if (edit === 'deny' && bash === 'deny') return -1.0
  // Both allow → fully autonomous
  if (edit === 'allow' && bash === 'allow') return +1.0
  // Mixed or ask → partial
  if (edit === 'allow' || bash === 'allow') return +0.5
  return 0 // all ask
}

// ---------- SECONDARY: name + description patterns ----------
const NAME_SIGNALS: Array<{ pattern: RegExp; delta: Partial<AgentVector> }> = [
  // Autonomy
  { pattern: /\bplan\b/i, delta: { autonomy: -0.8 } },
  { pattern: /\bexplore\b/i, delta: { autonomy: -0.6 } },
  { pattern: /\breview\b/i, delta: { autonomy: -0.4 } },
  { pattern: /\bbuild\b/i, delta: { autonomy: +0.8 } },
  { pattern: /\bcode\b/i, delta: { autonomy: +0.6 } },
  { pattern: /\bfix\b/i, delta: { autonomy: +0.5 } },
  { pattern: /\bgeneral\b/i, delta: { autonomy: +0.2 } },
  // Specificity
  { pattern: /\bplan\b/i, delta: { specificity: +0.7 } },
  { pattern: /\bbuild\b/i, delta: { specificity: +0.6 } },
  { pattern: /\bcode\b/i, delta: { specificity: +0.8 } },
  { pattern: /\bfix\b/i, delta: { specificity: +0.7 } },
  { pattern: /\bexplore\b/i, delta: { specificity: -0.8 } },
  { pattern: /\bgeneral\b/i, delta: { specificity: -0.3 } },
  { pattern: /\breview\b/i, delta: { specificity: +0.3 } },
  // Description-derived specificity hints
  { pattern: /read.only|read only|no.edit|no.write/i, delta: { autonomy: -0.6 } },
  { pattern: /write|edit|implement|create/i, delta: { autonomy: +0.4 } },
  { pattern: /task|implement|specific|focused/i, delta: { specificity: +0.4 } },
  { pattern: /research|discover|explore|broad/i, delta: { specificity: -0.4 } },
]

function vectorizeByNameAndDesc(agentName: string, description?: string): AgentVector {
  const text = `${agentName} ${description || ''}`
  let autonomy = 0,
    specificity = 0
  for (const sig of NAME_SIGNALS) {
    if (sig.pattern.test(text)) {
      autonomy += sig.delta.autonomy || 0
      specificity += sig.delta.specificity || 0
    }
  }
  return {
    autonomy: Math.max(-1, Math.min(1, autonomy)),
    specificity: Math.max(-1, Math.min(1, specificity)),
  }
}

// ---------- Combine into final vector ----------
function buildAgentVector(agent: string, perms?: AgentPermissions): AgentVector {
  const nameSig = vectorizeByNameAndDesc(agent, perms?.description)

  if (perms) {
    // Permissions are authoritative for autonomy axis
    const permAutonomy = autonomyFromPermissions(perms)
    // Blend: 80% permissions, 20% name (for corner cases)
    const autonomy = permAutonomy * 0.8 + nameSig.autonomy * 0.2
    // Subagent mode pushes toward focused
    const modeBonus = perms.mode === 'subagent' ? +0.3 : 0
    const specificity = Math.max(-1, Math.min(1, nameSig.specificity + modeBonus))
    return { autonomy: Math.max(-1, Math.min(1, autonomy)), specificity }
  }

  return nameSig
}

function intensityFromVector(v: AgentVector): 'light' | 'medium' | 'full' | 'none' {
  if (v.autonomy < -0.3 && v.specificity < -0.3) return 'none' // SW: explore
  if (v.autonomy < -0.3) return 'light' // NW: plan
  if (v.autonomy >= 0.3 && v.specificity >= 0.3) return 'full' // NE: build
  return 'medium' // SE/center: general
}

function resolveIntensity(
  complexity: Complexity,
  agent?: string,
  perms?: AgentPermissions
): 'light' | 'medium' | 'full' | 'none' {
  if (!agent && !perms) return getIntensity(complexity)

  const vector = buildAgentVector(agent ?? '', perms)
  const cap = intensityFromVector(vector)

  if (cap === 'none') return 'none'

  const base = getIntensity(complexity)
  const order = ['light', 'medium', 'full'] as const
  return order[Math.min(order.indexOf(base), order.indexOf(cap))]
}

// ---------------------------------------------------------------------------
// Main pipeline runner
// ---------------------------------------------------------------------------
export function runPipeline(
  prompt: string,
  classification: ClassificationResult,
  options: EnhancementOptions
): EnhancementResult {
  const { domain } = options
  const skip = new Set(options.skipStages || [])
  const intensity = resolveIntensity(
    classification.complexity,
    options.agent,
    options.agentPermissions
  )

  // If agent is "explore" or intensity is "none", return the prompt unchanged
  if (intensity === 'none') {
    const scoreBefore = scorePrompt(prompt)
    return {
      original: prompt,
      enhanced: prompt,
      systemPrompt: '',
      domain,
      scoreBefore,
      scoreAfter: scoreBefore,
      stages: [
        {
          stage: 'analyze',
          applied: false,
          change: `skipped: agent "${options.agent}" classified as explore (read-only+broad)`,
        },
      ],
      techniquesApplied: [],
      needsFreshInfo: classification.needsFreshInfo,
    }
  }

  const scoreBefore = scorePrompt(prompt)
  const stages: StageResult[] = []
  const techniquesApplied: string[] = []

  let current = prompt

  // --- Stage 1: Analyze
  stages.push({
    stage: 'analyze',
    applied: true,
    change: `baseline scored, intensity: ${intensity}${options.agent ? ` (agent: ${options.agent})` : ''}`,
  })

  // --- Stage 2: Elevate Critical (medium/full only)
  if (!skip.has('elevate-critical') && intensity !== 'light') {
    const s = stageElevateCritical(current)
    const changed = s.result !== current
    current = s.result
    stages.push({ stage: 'elevate-critical', applied: changed, change: s.note })
  } else {
    stages.push({ stage: 'elevate-critical', applied: false, change: 'skipped (light intensity)' })
  }

  // --- Stage 3: Flatten Nesting (advisory, always)
  if (!skip.has('flatten-nesting')) {
    const s = stageFlattenNesting(current)
    stages.push({ stage: 'flatten-nesting', applied: false, change: s.note })
  }

  // --- Stage 4: Optimize Ratio — removed (was adding filler)
  stages.push({ stage: 'optimize-ratio', applied: false, change: 'handled by system prompt' })

  // --- Stage 5: Consolidate (medium/full only)
  if (!skip.has('consolidate') && intensity !== 'light') {
    const s = stageConsolidate(current)
    const changed = s.result !== current
    current = s.result
    stages.push({ stage: 'consolidate', applied: changed, change: s.note })
  } else {
    stages.push({ stage: 'consolidate', applied: false, change: 'skipped (light intensity)' })
  }

  // --- Stage 6: Add Priority — now goes to system prompt, not user prompt
  stages.push({ stage: 'add-priority', applied: false, change: 'moved to system prompt' })

  // --- Stage 7: Inject Context
  if (!skip.has('inject-context')) {
    const s = stageInjectContext(current, options)
    const changed = s.result !== current
    current = s.result
    stages.push({ stage: 'inject-context', applied: changed, change: s.note })
  }

  // --- Stage 8: Apply USER-level techniques only
  if (!skip.has('apply-techniques')) {
    // Filter out system-level techniques — those go to systemPrompt
    const userTechIds = (
      options.selectedTechniqueIds ||
      autoSelectTechniques(prompt, domain, options.modelId, _extraTechniques).map(t => t.id)
    ).filter(id => !SYSTEM_TECHNIQUES.has(id))

    if (userTechIds.length > 0) {
      const enhanced = applyTechniques(
        current,
        userTechIds,
        domain,
        options.modelId,
        _extraTechniques
      )
      const changed = enhanced !== current
      current = enhanced
      techniquesApplied.push(...userTechIds)
      stages.push({
        stage: 'apply-techniques',
        applied: changed,
        change: `applied ${userTechIds.length} user-level technique(s): ${userTechIds.join(', ')}${options.modelId ? ` [tier: ${resolveModelTier(options.modelId)}]` : ''}`,
      })
    } else {
      stages.push({
        stage: 'apply-techniques',
        applied: false,
        change: 'no user-level techniques applicable',
      })
    }
  }

  // --- Stage 9: Validate
  if (!skip.has('validate')) {
    const s = stageValidate(prompt, current)
    stages.push({ stage: 'validate', applied: true, change: s.note })
  }

  // --- Stage 10: Deliver
  stages.push({ stage: 'deliver', applied: true, change: 'pipeline complete' })

  // Build system prompt separately
  const systemPrompt = buildSystemPrompt(domain, prompt)

  const scoreAfter = scorePrompt(current)

  return {
    original: prompt,
    enhanced: current,
    systemPrompt,
    domain,
    scoreBefore,
    scoreAfter,
    stages,
    techniquesApplied,
    needsFreshInfo: classification.needsFreshInfo,
  }
}
