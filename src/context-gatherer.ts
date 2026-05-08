/**
 * Context Gatherer
 *
 * Collects lightweight workspace and session context to inject into prompts.
 * Inspired by mtayfur/opencode-prompt-enhancer: CWD, git changes, recent prompts.
 */

import { execSync } from 'child_process'
import { statSync } from 'fs'
import { join } from 'path'

export interface WorkspaceContext {
  cwd: string
  gitBranch: string | null
  gitChangedFiles: string[]
  gitRecentCommit: string | null
  availableTools: string[] // CLI tools (git, node, etc.)
  mcpTools: string[] // MCP + plugin tools from SDK
  todayDate: string
  trainingCutoffWarning: boolean
  hasProjectInstructions: boolean // CLAUDE.md, .cursorrules, etc. exist
}

// ---------------------------------------------------------------------------
// Cache — avoids redundant shell forks between messages
// ---------------------------------------------------------------------------
interface CacheEntry<T> {
  value: T
  mtime: number // ms timestamp of the file used for invalidation
}

class ContextCache {
  private tools: string[] | null = null
  private branch: CacheEntry<string | null> | null = null
  private changedFiles: CacheEntry<string[]> | null = null
  private recentCommit: CacheEntry<string | null> | null = null

  private getMtime(path: string): number {
    try {
      return statSync(path).mtimeMs
    } catch {
      return 0
    }
  }

  private gitDir(cwd: string): string {
    return join(cwd, '.git')
  }

  getTools(_cwd: string): string[] {
    if (this.tools) return this.tools
    this.tools = detectAvailableTools()
    return this.tools
  }

  getBranch(cwd: string): string | null {
    const headFile = join(this.gitDir(cwd), 'HEAD')
    const mtime = this.getMtime(headFile)
    if (this.branch && this.branch.mtime === mtime) return this.branch.value
    const value = getGitBranch(cwd)
    this.branch = { value, mtime }
    return value
  }

  getChangedFiles(cwd: string): string[] {
    const indexFile = join(this.gitDir(cwd), 'index')
    const mtime = this.getMtime(indexFile)
    if (this.changedFiles && this.changedFiles.mtime === mtime) return this.changedFiles.value
    const value = getGitChangedFiles(cwd)
    this.changedFiles = { value, mtime }
    return value
  }

  getRecentCommit(cwd: string): string | null {
    const headFile = join(this.gitDir(cwd), 'HEAD')
    const mtime = this.getMtime(headFile)
    if (this.recentCommit && this.recentCommit.mtime === mtime) return this.recentCommit.value
    const value = getGitRecentCommit(cwd)
    this.recentCommit = { value, mtime }
    return value
  }
}

const cache = new ContextCache()

// ---------------------------------------------------------------------------
// Git helpers — gracefully degrade if not in a git repo
// ---------------------------------------------------------------------------
function runGit(cmd: string, cwd: string): string | null {
  try {
    return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  } catch {
    return null
  }
}

function getGitBranch(cwd: string): string | null {
  return runGit('git rev-parse --abbrev-ref HEAD', cwd)
}

function getGitChangedFiles(cwd: string): string[] {
  const result = runGit('git diff --name-only HEAD', cwd)
  if (!result) return []
  return result.split('\n').filter(Boolean).slice(0, 10) // cap at 10
}

function getGitRecentCommit(cwd: string): string | null {
  return runGit("git log -1 --format='%s (%cr)'", cwd)
}

// ---------------------------------------------------------------------------
// Stale-info detector
// Checks if the prompt references things likely beyond model training cutoff.
// ---------------------------------------------------------------------------
const STALE_PATTERNS = [
  /\b(latest|current|newest|recent|up.?to.?date)\b/i,
  /\b(202[5-9]|203\d)\b/, // years after 2024
  /\b(v\d+\.\d+\.\d+)\b/, // version numbers
  /\b(changelog|release notes|what's new)\b/i,
  /\b(today|this week|this month|this year)\b/i,
]

export function detectStaleInfo(prompt: string): boolean {
  return STALE_PATTERNS.some(p => p.test(prompt))
}

// ---------------------------------------------------------------------------
// Main context gatherer
// ---------------------------------------------------------------------------
function hasProjectInstructions(cwd: string): boolean {
  const candidates = ['CLAUDE.md', '.cursorrules', '.github/copilot-instructions.md', 'AGENTS.md']
  for (const f of candidates) {
    try {
      statSync(join(cwd, f))
      return true
    } catch {
      /* nope */
    }
  }
  return false
}

export interface ToolPriorities {
  mode?: 'manual' | 'mcp-first'
  prefer: string[]
  avoid: string[]
}

export interface ContextConfig {
  injectGitBranch?: boolean
  injectGitChangedFiles?: boolean
  injectGitLastCommit?: boolean
  maxChangedFiles?: number
}

let toolPrioritiesCache: ToolPriorities | null = null
let contextConfigCache: ContextConfig | null = null

export function gatherContext(
  cwd?: string,
  mcpTools?: string[],
  toolPriorities?: ToolPriorities,
  contextConfig?: ContextConfig
): WorkspaceContext {
  if (toolPriorities) toolPrioritiesCache = toolPriorities
  if (contextConfig) contextConfigCache = contextConfig
  const cfg = contextConfigCache ?? {}
  const effectiveCwd = cwd || process.cwd()

  return {
    cwd: effectiveCwd,
    gitBranch: cfg.injectGitBranch !== false ? cache.getBranch(effectiveCwd) : null,
    gitChangedFiles: cfg.injectGitChangedFiles
      ? cache.getChangedFiles(effectiveCwd).slice(0, cfg.maxChangedFiles ?? 10)
      : [],
    gitRecentCommit: cfg.injectGitLastCommit ? cache.getRecentCommit(effectiveCwd) : null,
    availableTools: cache.getTools(effectiveCwd),
    mcpTools: mcpTools ?? [],
    todayDate: new Date().toISOString().split('T')[0],
    trainingCutoffWarning: false,
    hasProjectInstructions: hasProjectInstructions(effectiveCwd),
  }
}

// ---------------------------------------------------------------------------
// Detect available tools (MCP/OpenCode environment)
// ---------------------------------------------------------------------------
function detectAvailableTools(): string[] {
  const tools: string[] = []

  // Check common CLI tools
  const cliTools = ['git', 'bun', 'node', 'npm', 'npx', 'curl', 'jq']
  for (const tool of cliTools) {
    try {
      execSync(`which ${tool}`, { stdio: 'pipe' })
      tools.push(tool)
    } catch {
      // not available
    }
  }

  return tools
}

// ---------------------------------------------------------------------------
// Format context into a compact block for prompt injection
// ---------------------------------------------------------------------------
export function formatContextBlock(ctx: WorkspaceContext, prompt: string): string {
  const lines: string[] = ['<peso:context>']

  lines.push(`  <date>${ctx.todayDate}</date>`)
  lines.push(`  <cwd>${ctx.cwd}</cwd>`)

  if (ctx.gitBranch) {
    lines.push(`  <git-branch>${ctx.gitBranch}</git-branch>`)
  }
  if (ctx.gitChangedFiles.length > 0) {
    lines.push(`  <git-changed-files>${ctx.gitChangedFiles.join(', ')}</git-changed-files>`)
  }
  if (ctx.gitRecentCommit) {
    lines.push(`  <git-last-commit>${ctx.gitRecentCommit}</git-last-commit>`)
  }
  if (ctx.availableTools.length > 0) {
    lines.push(`  <available-tools>${ctx.availableTools.join(', ')}</available-tools>`)
  }
  if (ctx.mcpTools.length > 0) {
    lines.push(`  <mcp-tools>${ctx.mcpTools.join(', ')}</mcp-tools>`)
  }
  if (toolPrioritiesCache) {
    const preferred = [...toolPrioritiesCache.prefer]
    const avoided = [...toolPrioritiesCache.avoid]

    // mcp-first: auto-add all MCP tools to prefer (if not already there or in avoid)
    if (toolPrioritiesCache.mode === 'mcp-first' && ctx.mcpTools.length > 0) {
      const avoidSet = new Set(avoided)
      const prefSet = new Set(preferred)
      for (const t of ctx.mcpTools) {
        if (!avoidSet.has(t) && !prefSet.has(t)) preferred.push(t)
      }
    }

    if (preferred.length > 0) {
      lines.push(`  <prefer-tools>${preferred.join(', ')}</prefer-tools>`)
    }
    if (avoided.length > 0) {
      lines.push(`  <avoid-tools>${avoided.join(', ')}</avoid-tools>`)
    }
  }
  if (ctx.hasProjectInstructions) {
    lines.push(`  <project-instructions>true</project-instructions>`)
  }
  if (detectStaleInfo(prompt)) {
    lines.push(
      `  <freshness-warning>This prompt may reference information beyond model training data. Use search/web tools to verify current facts.</freshness-warning>`
    )
  }

  lines.push('</peso:context>')
  return lines.join('\n')
}
