# Project Context

## Overview

PESO (Prompt Engineering Smart Optimizer) is an **OpenCode plugin** that intercepts user prompts before they reach the main LLM, enhances them using rule-based techniques and optional small-model rewriting, and injects workspace context. The goal is to improve prompt quality while minimizing input token waste.

It runs as a transparent hook — the user types a prompt, PESO rewrites it, and the main model receives the enhanced version.

## Tech Stack

- **Language:** TypeScript (ES2022, ESM)
- **Runtime:** Bun
- **Plugin SDK:** `@opencode-ai/plugin` (OpenCode plugin API)
- **Build:** `bun build` (single-file bundle to `dist/index.js`)
- **No test framework** — no tests exist yet

## Repository Structure

```
src/
  index.ts              — Re-exports PesoPlugin (the only public export)
  plugin.ts             — Main plugin: hooks, tools, agent resolution, LLM rewrite
  classifier.ts         — Rule-based domain/complexity/routing classification
  enhancer.ts           — 10-stage pipeline, system prompt builder, intensity logic
  techniques.ts         — 26 VILA-Lab techniques, ModelTier system, auto-selection
  scorer.ts             — Prompt scoring (0-10) across 4 dimensions
  context-gatherer.ts   — Git state, CLI tools, MCP tools, workspace context
  llm-client.ts         — Model resolution, SDK/HTTP LLM calls, config reading
  config.ts             — peso.json loading, merging, env template resolution
  router.ts             — Standalone routing (classify → enhance/clarify/search)
  cli.ts                — Standalone CLI entry point (not used in plugin mode)
  rules/
    research-backed.ts  — Position sensitivity, nesting depth, instruction ratio rules
  templates/
    code.md             — System prompt template for code domain
    general.md          — System prompt template for general domain
    creative.md         — System prompt template for creative domain
    research.md         — System prompt template for research domain
peso.json               — Project-level PESO config (tool priorities, context settings)
```

## Main Entry Points

| Entry point          | File                             | When used                               |
| -------------------- | -------------------------------- | --------------------------------------- |
| **Plugin (primary)** | `src/index.ts` → `src/plugin.ts` | OpenCode loads this as a plugin         |
| **CLI (standalone)** | `src/cli.ts`                     | `bun run src/cli.ts` for manual testing |

The plugin exports `PesoPlugin` which registers two hooks and four tools with OpenCode.

## Architecture

### Two hooks

1. **`chat.message`** — intercepts the user prompt, runs the rule-based pipeline, mutates `output.parts` in-place. No LLM call here — purely rule-based.
2. **`experimental.chat.system.transform`** — injects the PESO system prompt (from template + system-level techniques) into the session's system prompt.

### Four tools

| Tool          | Purpose                                                                    |
| ------------- | -------------------------------------------------------------------------- |
| `peso`        | Full enhancement: pipeline + optional LLM rewrite via small model          |
| `peso-debug`  | Same as `peso` but with full trace output (classification, stages, scores) |
| `peso-score`  | Score a prompt 0-10 without modifying it                                   |
| `peso-toggle` | Switch mode at runtime (`on`/`passive`/`off`)                              |
| `peso-config` | Show resolved model, API key status, agent compass table                   |

### Module layers

```
plugin.ts (orchestration, hooks, tools)
    ├── classifier.ts      (domain + complexity detection)
    ├── enhancer.ts         (10-stage pipeline)
    │     ├── techniques.ts (26 techniques + model-tier filtering)
    │     ├── rules/research-backed.ts (structural rules)
    │     └── templates/*.md (system prompt templates)
    ├── scorer.ts           (prompt quality scoring)
    ├── context-gatherer.ts (git, tools, workspace state)
    ├── llm-client.ts       (model resolution + LLM calls)
    └── config.ts           (peso.json loading)
```

## Data Flow

### Live hook flow (`chat.message`, mode=`on`)

1. User types prompt → OpenCode calls `chat.message` hook
2. `plugin.ts` extracts text parts; absolute minimum check (<5 chars → skip)
3. **Short-prompt expansion** (≤6 words): `expandShortPrompt()` in `classifier.ts` matches verb-first intent patterns (fix/explain/refactor/add/remove/test/debug/update/implement/review). If matched, replaces the short prompt with a structured template before classification. If no match and below `shortPromptThreshold`, returns without enhancement.
4. `classifier.ts` classifies: domain, complexity, routing
5. If routing = `clarify`, hook returns (no enhancement)
6. Agent permissions fetched from SDK → compass intensity (none/light/medium/full)
7. `enhancer.ts` `runPipeline()` runs 10 stages (with any loaded technique packs merged into built-ins):
   - Analyze → Elevate Critical → Flatten Nesting → Consolidate → Inject Context → Apply Techniques → Validate → Deliver
8. **User-level techniques** appended to user prompt (task-specific only: verify, examples, etc.)
9. **System-level techniques** go to system prompt (via `experimental.chat.system.transform`)
10. Enhanced prompt pushed to `output.parts` with structured metadata (`peso`, `domain`, `complexity`, `scoreBefore`, `scoreAfter`, `techniquesApplied`)
11. **Inline feedback part** pushed as `ignored: true` — visible in UI, hidden from LLM: `✦ peso: 5.8→8.1 (+2.3) | 4 techniques | code/medium`

### Tool flow (`peso` / `peso-debug`)

1. Same pipeline as above
2. Calls `enhanceWithSdk()` — uses **domain-specific system prompt** (code/research/creative/general) instead of the generic fallback
3. **Quality gate** (`applyQualityGate()`): scores original, pipeline, and LLM rewrite; keeps highest-scoring version. Falls back to original if both enhancements score lower.
4. `peso-debug` includes a `### Quality Gate` section showing all three scores and the winner
5. Returns formatted result to the agent

### Key distinction

- **Live hook:** rule-based only, no LLM call, <1ms overhead
- **Tools:** rule-based + LLM rewrite with quality gate, costs small-model tokens

## Important Domain Concepts

### Model Tiers (`src/techniques.ts`)

```
frontier  — Opus, GPT-4o, o1/o3, Gemini 2.5 Pro  → minimal technique injection
standard  — Sonnet, GPT-4-turbo                    → same as frontier (style → system prompt)
small     — Haiku, GPT-4o-mini, Gemini Flash        → full injection incl. reasoning nudges
```

`resolveModelTier(modelId)` does case-insensitive substring matching. Small patterns are checked before frontier to avoid `gpt-4o-mini` matching `gpt-4o`.

### Technique routing

- **SYSTEM_TECHNIQUES** (14 IDs in `enhancer.ts`): go to system prompt via templates, never touch user prompt
- **User-level techniques** (remaining ~12): appended to user prompt, filtered by `excludeTiers`
- Reasoning nudges (`step-by-step`, `chain-of-thought`, `emotional-stimuli`, `decompose`): small-only via `excludeTiers: ["frontier", "standard"]`

### Agent Compass (`enhancer.ts`)

Reads SDK agent permissions (edit/bash allow/deny) to determine enhancement intensity:

- `edit:deny + bash:deny` → light (read-only agent)
- `edit:allow + bash:allow` → full (build agent)
- Explore agent → none (skip entirely)

### Prompt scoring (`scorer.ts`)

4 dimensions: rules (0-10), length (0-2), clarity (0-2), specificity (0-2). Total 0-10 with letter grade.

## Configuration and Environment

### Config loading priority (`config.ts`)

1. `~/.config/peso/peso.json` — global defaults
2. `<project>/peso.json` — project overrides (deep-merged)
3. Environment variables override specific fields

### Key environment variables

| Variable        | Purpose                           |
| --------------- | --------------------------------- |
| `PESO_MODE`     | `on` / `passive` / `off`          |
| `PESO_AUTO=0`   | Same as `PESO_MODE=off`           |
| `PESO_MODEL`    | Override model for LLM rewrite    |
| `PESO_API_KEY`  | API key (CLI fallback path only)  |
| `PESO_BASE_URL` | Base URL (CLI fallback path only) |

In plugin mode, auth is handled by the OpenCode SDK — `PESO_API_KEY`/`PESO_BASE_URL` are not needed.

### Model resolution for LLM rewrite (`llm-client.ts`)

Priority: `PESO_MODEL` env → `small_model` in opencode.json → SDK auto-detect → `model` in opencode.json → hardcoded fallback.

### Model resolution for `tool.list()` (`plugin.ts`)

Priority: `small_model` → `model` → active session model. Cached per model string in `toolIdsCacheByModel`.

## Running the Project

```bash
bun install                    # install dependencies
bun run build                  # bundle to dist/index.js
bun run dev                    # run src/index.ts directly
bun run cli -- "your prompt"   # standalone CLI test
```

To use as an OpenCode plugin, add to your `opencode.json`:

```json
{ "plugin": ["@bulga138/peso"] }
```

Or in local development:

```json
{ "plugin": ["/path/to/peso"] }
```

## Testing

**No test framework or tests exist.** Verification is done manually via:

- `peso-debug` tool (full pipeline trace)
- `bun --eval` scripts importing source modules directly
- `bun run build` to check for bundling errors

`tsc --noEmit` (`bun run typecheck`) exists but has known pre-existing errors in `plugin.ts:193-196` (`toAgentPermissions` return type).

## Linting, Formatting, and Type Checking

```bash
bun run typecheck   # tsc --noEmit (has known errors)
```

No linter or formatter is configured.

## Build and Deployment

- `bun run build` → single-file `dist/index.js` (node target)
- No CI/CD pipeline
- No Docker
- Deployed by pointing OpenCode's `plugin` config at the repo path

## Common Change Guide

### Add a new technique

1. Add entry to `TECHNIQUES` array in `src/techniques.ts`
2. Set `id`, `name`, `description`, `domains`, `applies()`, `inject()`
3. If it's a style/constraint directive: add its ID to `SYSTEM_TECHNIQUES` in `src/enhancer.ts`
4. If it should only fire for small models: add `excludeTiers: ["frontier", "standard"]`
5. If adding to `SYSTEM_TECHNIQUES`: add a dedup check in `buildSystemPrompt()` if the templates already cover the same concern

### Add an external technique pack

1. Create a `.js` file exporting a `TechniquePack` default (see `src/techniques.ts` JSDoc)
2. Drop it in `~/.config/peso/packs/` — PESO auto-discovers all `.js` files there
3. Packs are loaded once at startup via `initTechniquePacks()` in `enhancer.ts`
4. To disable for a specific project: set `techniquePacks.disabled: ["pack-name"]` in the project's `peso.json`
5. To only enable specific packs: set `techniquePacks.enabled: ["pack-name"]` in `peso.json`

### Add a new domain template

1. Create `src/templates/<domain>.md` with role, focus, output format, constraints
2. Add the domain to the `Domain` type in `src/classifier.ts`
3. Update domain detection patterns in `DOMAIN_PATTERNS`

### Add a new tool

1. Add to the `tool` property in `PesoPlugin` in `src/plugin.ts`
2. Follow the existing pattern: `tool.schema` for args, `execute()` for logic

### Change what goes in the context block

1. Edit `gatherContext()` and/or `formatContextBlock()` in `src/context-gatherer.ts`
2. The `ContextConfig` interface controls which fields are injected

### Change scoring rules

1. Edit dimension functions in `src/scorer.ts`
2. Or edit structural rules in `src/rules/research-backed.ts`

### Change classification logic

1. Edit `src/classifier.ts`: `detectDomain()`, `detectComplexity()`, `detectAmbiguity()`

## Conventions and Patterns

- **ESM throughout** — all imports use `.js` extensions (TypeScript ESM convention)
- **No classes** — functional style; the only class is `ContextCache` in `context-gatherer.ts`
- **Caching** — aggressive session-scoped caching (agents, tools, git state via mtime checks)
- **Technique ordering** — techniques in the `TECHNIQUES` array are numbered 1-26, matching the VILA-Lab paper order
- **System vs user prompt** — style/format directives go to system prompt; only task-specific techniques touch the user prompt
- **Template dedup** — `buildSystemPrompt()` checks if the template already covers a technique before injecting it
- **Model tier checks** — small patterns checked before frontier in `resolveModelTier()` to prevent substring false positives

## Gotchas and Non-Obvious Details

- **`input.model` shape** — the `chat.message` hook receives `input.model` as `{ providerID, modelID }`, not a string. Extract `modelID` for tier resolution.
- **LLM rewrite quality gate** — in the `peso`/`peso-debug` tools, `applyQualityGate()` scores original, pipeline, and LLM rewrite and keeps the best. The original is returned if both enhancements score lower.
- **Domain-specific rewrite prompts** — `DOMAIN_REWRITE_PROMPTS` in `plugin.ts` maps each domain to a tailored system prompt for the LLM rewrite. Falls back to `ENHANCE_SYSTEM_PROMPT` for `general`.
- **Short-prompt expansion** — `expandShortPrompt()` in `classifier.ts` fires before classification for prompts ≤6 words. Returns `matched: false` for non-actionable single words (no verb match), which causes the hook to skip enhancement.
- **Inline feedback part** — the hook pushes a second `ignored: true` text part after the enhanced prompt. It is visible in the OpenCode UI but never sent to the LLM. Its `id` is `${originalId}-peso-feedback`.
- **Technique pack cache** — `_packCache` in `techniques.ts` is module-level. Call `resetPackCache()` to force re-load (e.g. during testing).
- **`SYSTEM_TECHNIQUES` filtering happens twice** — once in `runPipeline()` (filters them out of user-level application) and once in `buildSystemPrompt()` (includes them in system prompt).
- **Config env templates** — `peso.json` supports `{env:VAR_NAME}` syntax for values, resolved at load time by `resolveEnvTemplates()`.
- **JSONC handling** — `readOpencodeConfig()` in `llm-client.ts` tries plain `JSON.parse()` first, then strips comments. The comment-stripping regex was previously mangling URLs — fixed to only strip `//` comments at line starts.
- **`dist/` is gitignored** — always `bun run build` after changes before testing via plugin mode.
- **No `exports` in `package.json` for tools** — OpenCode loads the plugin via the `main` field pointing at `src/index.ts` (Bun resolves TS directly).

## Files to Read First

| Task                      | Files                                                                     |
| ------------------------- | ------------------------------------------------------------------------- |
| Understand the plugin     | `src/index.ts`, `src/plugin.ts` (hooks + tools)                           |
| Understand enhancement    | `src/enhancer.ts` (pipeline), `src/techniques.ts` (26 techniques + tiers) |
| Understand classification | `src/classifier.ts`                                                       |
| Change context injection  | `src/context-gatherer.ts`                                                 |
| Change model resolution   | `src/llm-client.ts`                                                       |
| Change config             | `src/config.ts`, `peso.json`                                              |
| Change scoring            | `src/scorer.ts`, `src/rules/research-backed.ts`                           |
| Change system prompts     | `src/templates/*.md`                                                      |

## Files to Avoid Unless Necessary

- `dist/` — generated build output, do not edit
- `bun.lock` — auto-managed lockfile
- `node_modules/` — dependencies
- `.serena/` — Serena IDE integration config

## Open Questions / Assumptions

- **No tests exist** — verification is entirely manual via `peso-debug` and `bun --eval` scripts
- **`tsc --noEmit` passes** — all type errors resolved as of this revision
- **CLI path (`src/cli.ts`)** appears unmaintained — it has its own `ENHANCE_SYSTEM_PROMPT` constant duplicated from `plugin.ts`
- **`src/router.ts`** provides a standalone `route()` function but it's unclear if anything uses it outside of `cli.ts`
