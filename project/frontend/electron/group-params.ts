// group-params.ts — pure helpers shared by the main-process GroupCoordinator
// and the standalone Discord bot child process. Both need to turn a
// (taskId, workerRole) pair into the exact CreateGroupArgs (reviewer role,
// models, budget) so a group created from Discord is identical to one created
// from the UI. Keeping this logic in one place prevents drift.

import type { CreateGroupArgs } from './db'
import type { OrchestrationConfig } from './group-coordinator'

// Config block for the Discord bot, stored under `discord` in agents-config.json.
// Token is NOT here — it lives in the encrypted secrets table (provider id
// 'discord'), injected as MULTIAGENT_KEY_DISCORD when the bot is spawned.
export interface DiscordConfig {
  enabled: boolean
  allowed_user_ids: string[]
  allowed_channel_ids: string[]
  default_worker_role: string
  guild_id: string
  max_code_bytes: number
  // Conversational /agent mode: the provider/model the in-channel IDE agent
  // uses, and whether it may run shell commands.
  agent_provider: string
  agent_model: string
  allow_agent_bash: boolean
}

export const DEFAULT_DISCORD_CONFIG: DiscordConfig = {
  enabled: false,
  allowed_user_ids: [],
  allowed_channel_ids: [],
  default_worker_role: 'backend-engineer',
  guild_id: '',
  max_code_bytes: 15000,
  agent_provider: '',
  agent_model: '',
  allow_agent_bash: false,
}

// Merge a partial (possibly undefined) config from disk with the defaults so
// callers always get a complete, well-typed object.
export function normalizeDiscordConfig(raw: Partial<DiscordConfig> | undefined | null): DiscordConfig {
  return {
    ...DEFAULT_DISCORD_CONFIG,
    ...(raw ?? {}),
    allowed_user_ids: raw?.allowed_user_ids ?? [],
    allowed_channel_ids: raw?.allowed_channel_ids ?? [],
  }
}

// Resolve the group parameters (reviewer role, worker/reviewer models, budget)
// for a root group. `modelFor` maps a role → its configured model. Pure: no I/O,
// no side effects — the caller performs db.createGroup with the result.
export function resolveGroupParams(
  taskId: string,
  workerRole: string,
  cfg: OrchestrationConfig,
  modelFor: (role: string) => string | null,
): CreateGroupArgs {
  const reviewerRole = cfg.reviewer_for[workerRole] || null
  const workerModel = modelFor(workerRole)
  const reviewerModel = reviewerRole ? modelFor(reviewerRole) : null
  return {
    task_id: taskId,
    worker_role: workerRole,
    reviewer_role: reviewerRole,
    worker_model: workerModel,
    reviewer_model: reviewerModel,
    budget_usd: cfg.budget_per_group_usd,
    depth: 0,
  }
}
