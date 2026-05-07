![peso-banner](./assets/banner.png)

# PESO

**Prompt Engineering Smart Optimizer**

An OpenCode plugin that enhances prompts using a configurable small/cheap model before they reach your main (expensive) model.

## How it works

```
User types prompt
      ↓
  PESO plugin (chat.message hook)
      ↓  classifies prompt (rule-based, zero cost)
      ↓  Agent Compass: reads agent permissions → sets intensity
      ↓  10-stage pipeline + 26 VILA-Lab techniques (model-tier-aware)
      ↓  style directives → system prompt; user prompt stays clean
      ↓  if use_llm: calls small model via SDK for rewrite
      ↓  injects context (git, tools, MCP tools)
      ↓  mutates prompt → main model receives enhanced version
```

### Modes

| Mode      | Behavior                                                   |
| --------- | ---------------------------------------------------------- |
| `on`      | Transparent — all prompts enhanced automatically (default) |
| `passive` | Only enhances when agent explicitly calls the `peso` tool  |
| `off`     | Fully disabled                                             |

Set via `PESO_MODE=passive` env at startup, or toggle at runtime with the `peso-toggle` tool.

### Agent Compass

PESO reads real agent permissions from the SDK to determine enhancement intensity:

| Agent Profile       | Permissions            | Intensity |
| ------------------- | ---------------------- | --------- |
| Plan (read-only)    | edit:deny, bash:deny   | Light     |
| Build (full access) | edit:allow, bash:allow | Full      |
| Explore (search)    | edit:deny, bash:ask    | None      |
| General             | mixed                  | Medium    |

## Installation

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["/path/to/peso"]
}
```

## Configuration

### Model Resolution

In plugin mode, PESO uses the OpenCode SDK to resolve the model — no API keys or base URLs needed:

| Priority | Source                                | Example                                         |
| -------- | ------------------------------------- | ----------------------------------------------- |
| 1        | `PESO_MODEL` env var                  | `export PESO_MODEL=groq/llama-3.1-8b-instant`   |
| 2        | SDK: `small_model` in `opencode.json` | `"small_model": "anthropic/claude-haiku-4-5"`   |
| 3        | SDK auto-detection                    | OpenCode picks cheapest model for your provider |
| 4        | SDK: `model` in `opencode.json`       | Falls back to main model                        |
| 5        | Hardcoded fallback                    | `opencode/zen` (free, always available)         |

> **Note:** In plugin mode (the default), all auth and routing is handled by the OpenCode SDK via `client.session.prompt()`. The `PESO_API_KEY` and `PESO_BASE_URL` env vars only apply to the standalone CLI fallback path.

### Example opencode.json

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "anthropic/claude-sonnet-4-5",
  "small_model": "anthropic/claude-haiku-4-5"
}
```

PESO will automatically use `claude-haiku-4-5` for enhancement work.

### Config File (`peso.json`)

PESO loads config from two locations (deep-merged):

1. `~/.config/peso/peso.json` — global defaults
2. `<project>/peso.json` — project overrides

```json
{
  "mode": "passive",
  "shortPromptThreshold": 15,
  "toolPriorities": {
    "prefer": ["read", "glob", "grep", "serena_find_symbol"],
    "avoid": ["task", "webfetch", "websearch"]
  },
  "techniques": {
    "enabled": "all",
    "disabled": ["emotional-stimuli"]
  },
  "context": {
    "injectGit": true,
    "injectMcpTools": true,
    "maxChangedFiles": 10
  },
  "options": {
    "baseURL": "{env:ANTHROPIC_URL}",
    "apiKey": "{env:ANTHROPIC_AUTH_TOKEN}"
  }
```

**Tool priorities** tell the model which tools are cheap (prefer) vs expensive (avoid). This gets injected as `<prefer-tools>` and `<avoid-tools>` in the context block, nudging the model to use `read`/`glob`/`grep` before spawning a `task` subagent.

**`toolPriorities.mode`**:

- `"manual"` (default) — only tools listed in `prefer`/`avoid` are hinted
- `"mcp-first"` — all MCP tools auto-added to `prefer` (favors MCP over native OpenCode tools)

Run `peso-config` to see all available tools and set up your priorities.

### Environment Variables

| Variable        | Purpose                                         | Default         |
| --------------- | ----------------------------------------------- | --------------- |
| `PESO_MODE`     | Set mode at startup: `on`, `passive`, `off`     | `on`            |
| `PESO_AUTO`     | Set to `0` to disable (same as `PESO_MODE=off`) | —               |
| `PESO_MODEL`    | Override model for enhancement                  | SDK auto-detect |
| `PESO_API_KEY`  | API key for CLI fallback path only              | —               |
| `PESO_BASE_URL` | Base URL for CLI fallback path only             | —               |

> In plugin mode, `PESO_API_KEY` and `PESO_BASE_URL` are not needed — the SDK handles auth.

## Tools Provided

### `peso`

Full enhancement pipeline. Classifies the prompt, applies research-backed techniques, optionally calls the small model for a complete rewrite.

```
Use the peso tool to enhance: "fix the login bug"
```

Arguments:

- `prompt` (required): The prompt to enhance
- `mode` (optional): `auto` | `code` | `general` | `creative` | `research`
- `use_llm` (optional): Whether to call the small model (default: true)

### `peso-score`

Score a prompt 0-10 without modifying it. Shows rule violations and dimension breakdown.

### `peso-debug`

Run the full pipeline with trace output: classification, techniques applied, before/after scores, agent compass vector, LLM call result.

### `peso-toggle`

Switch PESO mode at runtime:

```
peso-toggle passive   # only enhances when agent calls peso tool
peso-toggle on        # transparent enhancement (default)
peso-toggle off       # fully disabled
peso-toggle           # show current mode
```

### `peso-config`

Show current configuration: SDK-resolved model, local fallback model, API key status, agent compass table with per-agent intensities.

## Performance

PESO uses aggressive caching to minimize overhead:

| Data                            | Strategy                          | Cost on cache hit |
| ------------------------------- | --------------------------------- | ----------------- |
| CLI tools (`git`, `node`, etc.) | Session-scoped (never re-checked) | 0                 |
| Git branch                      | `.git/HEAD` mtime check           | 1 `stat` call     |
| Git changed files               | `.git/index` mtime check          | 1 `stat` call     |
| Git recent commit               | `.git/HEAD` mtime check           | 1 `stat` call     |
| Agent list                      | Cached after first SDK call       | 0                 |
| MCP/plugin tool IDs             | Cached after first SDK call       | 0                 |

**Typical per-message overhead: <1ms** (no shell forks, no network) unless git state actually changed.

## Context Injection

PESO injects a `<peso:context>` block into enhanced prompts:

```xml
<peso:context>
  <date>2026-05-07</date>
  <cwd>/Users/you/project</cwd>
  <git-branch>feat/my-feature</git-branch>
  <git-changed-files>src/index.ts, src/utils.ts</git-changed-files>
  <available-tools>git, bun, node, npm, npx, curl, jq</available-tools>
  <mcp-tools>bash, read, glob, grep, edit, write, task, webfetch, peso, ...</mcp-tools>
  <project-instructions>true</project-instructions>
</peso:context>
```

- `<mcp-tools>` lists all MCP + plugin tools from the SDK (not just CLI binaries)
- `<project-instructions>` signals when CLAUDE.md / .cursorrules exist (avoids redundant injections)
- `<freshness-warning>` added when prompt references "latest", "current", or future dates

## What it enhances

### Rule-based (free, always runs):

- Position sensitivity: critical instructions moved to first 15%
- Nesting depth check (max 4 levels)
- Instruction ratio optimization (40-50%)
- Duplicate rule consolidation
- Priority statement injection
- 26 VILA-Lab principled techniques (auto-selected by domain and model tier)

### Model-tier-aware filtering

PESO detects the active model and skips techniques that add noise for capable models:

| Tier       | Models                              | Behavior                                                             |
| ---------- | ----------------------------------- | -------------------------------------------------------------------- |
| `frontier` | Opus, GPT-4o, o1/o3, Gemini 2.5 Pro | Minimal injection — only task-specific techniques (verify, examples) |
| `standard` | Sonnet, GPT-4-turbo                 | Same as frontier — style directives go to system prompt only         |
| `small`    | Haiku, GPT-4o-mini, Gemini Flash    | Full injection — includes step-by-step, chain-of-thought, decompose  |

Style/constraint directives (`constraints`, `brevity`, `output-length`, `scope-limit`, `language-spec`, `positive-framing`) always go to the **system prompt**, never the user prompt. This keeps user prompts clean and avoids wasting input tokens on every message.

Reasoning nudges (`step-by-step`, `emotional-stimuli`, `chain-of-thought`, `decompose`) only fire for `small` models where they measurably help

### LLM-based (costs small-model tokens):

- Full prompt rewrite preserving intent
- Context-aware restructuring
- Domain-specific optimization

## Inspirations

| Source                                                                                      | Contribution                               |
| ------------------------------------------------------------------------------------------- | ------------------------------------------ |
| [mtayfur/opencode-prompt-enhancer](https://github.com/mtayfur/opencode-prompt-enhancer)     | Plugin pattern, workspace context          |
| [diegohb gist](https://gist.github.com/diegohb/5bbe7bfa48900e302aa99a2b2760b05a)            | Argument intelligence                      |
| [lim-hyo-jeong/Prompt-Enhancer](https://github.com/lim-hyo-jeong/Prompt-Enhancer)           | 26 VILA-Lab principles                     |
| [meta-introspector dotfiles](https://github.com/meta-introspector/benbrastmckie-dotfiles)   | 10-stage pipeline, scoring                 |
| [ruhanirabin/vscode-prompt-enhancer](https://github.com/ruhanirabin/vscode-prompt-enhancer) | Template system                            |
| DeepMind OPRO                                                                               | Step-by-step breathing (small models only) |
| Microsoft Research                                                                          | Emotional stimuli (small models only)      |
| Stanford/Anthropic                                                                          | Position sensitivity                       |
| Anthropic Prompting Best Practices (2026)                                                   | Model-tier-aware technique filtering       |
