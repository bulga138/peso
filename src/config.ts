/**
 * PESO Config Loader
 *
 * Resolution order (deep-merged):
 *   1. ~/.config/peso/peso.json   (global defaults)
 *   2. <project>/peso.json        (project overrides)
 *   3. Environment variables       (runtime overrides)
 *
 * Supports {env:VAR_NAME} template syntax for secrets (same as opencode.json).
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface ToolPriorities {
  mode?: "manual" | "mcp-first"; // mcp-first = auto-prefer MCP tools over native opencode tools
  prefer: string[];   // tools to suggest first (cheap/fast)
  avoid: string[];    // tools to deprioritize (expensive/slow)
  notes?: Record<string, string>;
}

export interface PesoConfig {
  mode: "on" | "passive" | "off";
  shortPromptThreshold: number;
  toolPriorities: ToolPriorities;
  techniques: {
    enabled: "all" | string[];
    disabled: string[];
  };
  context: {
    injectGitBranch: boolean;
    injectGitChangedFiles: boolean;
    injectGitLastCommit: boolean;
    injectMcpTools: boolean;
    injectProjectInstructions: boolean;
    maxChangedFiles: number;
  };
  /** Optional overrides for CLI/HTTP fallback path */
  options?: {
    baseURL?: string;  // supports {env:VAR}
    apiKey?: string;   // supports {env:VAR}
  };
}

const DEFAULTS: PesoConfig = {
  mode: "on",
  shortPromptThreshold: 15,
  toolPriorities: {
    prefer: ["read", "glob", "grep"],
    avoid: ["task", "webfetch"],
    notes: {},
  },
  techniques: {
    enabled: "all",
    disabled: [],
  },
  context: {
    injectGitBranch: true,
    injectGitChangedFiles: false, // off by default — stale fast in long sessions
    injectGitLastCommit: false,   // rarely useful for actual tasks
    injectMcpTools: true,
    injectProjectInstructions: true,
    maxChangedFiles: 10,
  },
};

// ---------------------------------------------------------------------------
// {env:VAR} template resolution (same pattern as opencode.json)
// ---------------------------------------------------------------------------
function resolveEnvTemplates(value: string): string {
  return value.replace(/\{env:([^}]+)\}/g, (_, varName) => process.env[varName] || "");
}

function resolveTemplatesDeep(obj: any): any {
  if (typeof obj === "string") return resolveEnvTemplates(obj);
  if (Array.isArray(obj)) return obj.map(resolveTemplatesDeep);
  if (obj && typeof obj === "object") {
    const result: any = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = resolveTemplatesDeep(v);
    }
    return result;
  }
  return obj;
}

// ---------------------------------------------------------------------------
// File loading
// ---------------------------------------------------------------------------
function loadJsonFile(path: string): Partial<PesoConfig> | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return resolveTemplatesDeep(raw);
  } catch {
    return null;
  }
}

function deepMerge<T extends Record<string, any>>(base: T, override: Partial<T>): T {
  const result = { ...base };
  for (const key of Object.keys(override) as (keyof T)[]) {
    const val = override[key];
    if (val !== undefined && val !== null) {
      if (typeof val === "object" && !Array.isArray(val) && typeof result[key] === "object" && !Array.isArray(result[key])) {
        result[key] = deepMerge(result[key] as any, val as any);
      } else {
        result[key] = val as any;
      }
    }
  }
  return result;
}

let cachedConfig: PesoConfig | null = null;

export function loadPesoConfig(projectDir?: string): PesoConfig {
  if (cachedConfig) return cachedConfig;

  let config = { ...DEFAULTS };

  // 1. Global config
  const globalPath = join(homedir(), ".config", "peso", "peso.json");
  const globalCfg = loadJsonFile(globalPath);
  if (globalCfg) config = deepMerge(config, globalCfg);

  // 2. Project config
  if (projectDir) {
    const projectPath = join(projectDir, "peso.json");
    const projectCfg = loadJsonFile(projectPath);
    if (projectCfg) config = deepMerge(config, projectCfg);
  }

  // 3. Env overrides
  if (process.env.PESO_MODE) config.mode = process.env.PESO_MODE as PesoConfig["mode"];
  if (process.env.PESO_AUTO === "0") config.mode = "off";

  cachedConfig = config;
  return config;
}

/** Reset cache — useful for testing */
export function resetConfigCache(): void {
  cachedConfig = null;
}
