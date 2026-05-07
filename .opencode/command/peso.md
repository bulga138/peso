# /peso — PESO Prompt Enhancement

Enhances your prompt using PESO's 10-stage research-backed pipeline before sending it to the main model.

## Usage

```
/peso [mode] [prompt]
```

**Modes:**
- `auto` *(default)* — classify the prompt and decide routing automatically
- `code` — apply code-domain template + rewrite
- `general` — apply general-domain template + rewrite
- `creative` — apply creative-domain template + rewrite
- `research` — apply research-domain template + rewrite (adds freshness check)

## What it does

1. **Classifies** your prompt: domain, complexity, ambiguity
2. **Routes** appropriately:
   - `passthrough` — simple clear prompts sent as-is (saves tokens)
   - `clarify` — ambiguous prompts → asks clarifying questions first
   - `enhance` — applies 10-stage pipeline + VILA-Lab techniques
   - `rewrite` — explicit mode selected → full domain template applied
   - `search` — detects stale info references → provides search hints
3. **Scores** before and after (0–10, rule-based)
4. **Injects context**: current date, git branch, changed files, available tools

## Examples

```
/peso auto Write a function that processes user data
/peso code Implement a retry mechanism with exponential backoff in TypeScript
/peso research What is the latest stable version of React and what changed?
/peso creative Write a short blog post about prompt engineering
```

---

## Instructions for the agent

When this command is invoked with `/peso`:

1. Extract the mode from the first argument (default: `auto`)
2. Extract the user's prompt from the remaining text
3. Call the `peso-enhance` MCP tool with:
   - `prompt`: the user's prompt
   - `mode`: the extracted mode
   - `inject_context`: true
   - `cwd`: the current working directory
4. Inspect the `kind` field in the response:
   - `passthrough` → use the original prompt as-is
   - `clarify` → present the clarifying questions to the user and wait for answers before proceeding
   - `enhance` / `rewrite` → use the enhanced prompt as the actual task input
   - `search` → first perform any recommended searches, then use the enhanced prompt
5. Show the score summary and pipeline stages to the user as a brief status block
6. Proceed with the (enhanced) prompt as the actual task

If the `peso-enhance` tool is not available, fall back to applying these manual improvements:
- Add "You are an expert in [detected domain]." at the start
- Add "Take a deep breath and work through this step-by-step." at the end
- Add "Be thorough and precise." at the end
- If the prompt references 'latest' or 'current', search for up-to-date info first
