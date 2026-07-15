// context-window.ts — resolve a model's context window (max input tokens) so
// the UI can show how full the conversation is. Order of precedence:
//   1. an explicit per-model value in the provider config (context_windows)
//   2. a built-in default keyed by model-name substring
//   3. a conservative fallback
//
// The "used" side comes for free: the API returns prompt_tokens/input_tokens
// each turn, which is exactly the current context size — no estimation needed.

const FALLBACK_WINDOW = 128_000

// Substring → window. First match wins, so order specific before generic.
const DEFAULTS: [string, number][] = [
  ['claude-opus', 200_000],
  ['claude-sonnet', 200_000],
  ['claude-haiku', 200_000],
  ['claude', 200_000],
  ['gpt-5', 400_000],
  ['gpt-4.1', 1_000_000],
  ['gpt-4o', 128_000],
  ['gpt-4', 128_000],
  ['o3', 200_000],
  ['o1', 200_000],
  ['gemini-2.5', 1_048_576],
  ['gemini-1.5', 1_048_576],
  ['gemini', 1_000_000],
  ['deepseek-v4', 128_000],
  ['deepseek', 128_000],
  ['glm-5', 200_000],
  ['glm', 128_000],
  ['qwen3', 256_000],
  ['qwen', 128_000],
  ['kimi', 200_000],
]

export function contextWindowFor(
  model: string,
  providerCfg?: { context_windows?: Record<string, number>; context_window?: number },
): number {
  if (providerCfg?.context_windows && providerCfg.context_windows[model] > 0) {
    return providerCfg.context_windows[model]
  }
  const lower = (model || '').toLowerCase()
  for (const [needle, win] of DEFAULTS) {
    if (lower.includes(needle)) return win
  }
  if (providerCfg?.context_window && providerCfg.context_window > 0) return providerCfg.context_window
  return FALLBACK_WINDOW
}
