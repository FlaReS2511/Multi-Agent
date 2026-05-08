# Multi-Agent Dev Team

A 6-agent orchestration system that turns a single high-level prompt into coordinated work across specialised agents — Planner, Orchestrator, Backend, Frontend, AI Engineer, and Reviewer — each running in its own terminal, talking through a shared filesystem.

> _[GIF placeholder: prompt → agents working in parallel → working app in `project/`]_

## Why I built this

I started this while building the AI Livestream system at **eCentric JSC**, an ecommerce company running livestream campaigns for major brands. A single Claude Code session kept choking on the scope: backend, React UI, prompt eval — all interleaved, no separation of concerns. I wanted multiple agents working in parallel, each owning a domain.

The hard part was not splitting the work — it was the wiring. Three things I did not know at the start, and the choices that came out of figuring them out:

- **How do you make AI agents talk to each other and hand off tasks?** I had no template for this. After trying a few approaches, I settled on filesystem IPC: each agent has a markdown inbox, messages are blocks separated by `---`, and the Orchestrator owns a JSON task board. Files are introspectable with `cat` and survive a crash — much easier to debug than a message broker when something goes wrong at 2 AM.
- **No direct API access, so each agent is a Claude Code instance.** I wanted to call the Anthropic API directly but did not have access set up at the time. Going through the Claude Code CLI turned out fine — it gave me file editing, shell access, and tool use for free per agent. The multi-backend menu in the roadmap brings real APIs back as an option.
- **I had an LM Studio adapter early on and deleted it.** Thought I would not need local models. Regretting that — adding it back as part of the multi-backend work. Worth recording as a lesson: do not delete optional adapters just because they are not in this week's path.

I use this in daily work. This repo is the version stripped of company specifics.

## How it works

```
User ─chat──▶ Planner (draft spec) ──user-approves-via-UI──▶ Orchestrator
   │                                                                │
   └─chat-direct─▶ Orchestrator ◀────────────────────────────────────┘
                       │
                       ├──▶ Backend Engineer  (Python, API, DB)
                       ├──▶ Frontend Engineer (HTML/CSS/JS, React, Tailwind)
                       ├──▶ AI Engineer       (prompts, eval, model wiring)
                       └──▶ Reviewer/QA       (code review, tests, security)
```

- **Planner** drafts the spec with the user and writes to `agents/planner/workspace/current-draft.md`. It never dispatches tasks; the user approves through the Electron UI, which then injects a message into the Orchestrator's inbox.
- **Orchestrator** is the single entry point for execution. It owns `tasks.json` and routes work to the four workers.
- **Workers** never talk directly to each other — every cross-agent message goes through the Orchestrator. Same reason monolith DBs use a single writer: you can actually reason about ordering.

Full protocol and `tasks.json` schema are in [`CLAUDE.md`](./CLAUDE.md).

## Quick demo

```bash
./scripts/launch-tmux.sh
```

This opens 5 tmux panes (4 agents + a live monitor). Type a task into the Orchestrator pane:

> "Build a fullstack todo app: FastAPI backend with SQLite, React frontend with Tailwind, tests, and a README."

The Orchestrator decomposes the request, dispatches to Backend / Frontend / AI in parallel, the Reviewer audits, and the resulting code lands in `project/`. See [`examples/`](./examples) for past runs.

## Design decisions

| Concern | Choice | Why |
|---|---|---|
| IPC | Markdown inbox + JSON task board on disk | Debuggable with `cat`, survives a crash, no broker to babysit |
| Task board writer | Orchestrator only | Avoids races; workers send messages to request status changes |
| Message format | Markdown blocks separated by `---` | Human-readable in any editor, parseable in ~5 lines of code |
| UI | Electron + React + Vite, polls files at 2s | UI is read-only; killing it does not touch the agents |
| Process model | tmux panes, one per agent | Each agent owns its terminal; `Ctrl-b z` to zoom into one and watch live |

## Backends

Each agent independently picks one of:

- **Claude Code (CLI)** — default, no setup beyond having `claude` in PATH
- **Codex (CLI)** — OpenAI's coding agent
- **Gemini (CLI)** — Google's coding agent
- **Anthropic / Google / OpenAI API** — direct provider calls via SDK
- **LM Studio** — any OpenAI-compatible local endpoint (default `http://localhost:1234/v1`)

Switch via the gear icon in the Electron app. API keys are encrypted with the OS keychain (Electron `safeStorage`) before being written to `shared/.secrets.json` (gitignored). Keys are stored once per provider and shared by every agent set to that provider.

The message protocol is provider-neutral (markdown blocks over filesystem), so adapter wiring is the only thing that changes. A worker writing parsers does not need Opus; a Reviewer might. CLI agents auto-load a per-CLI context file (`CLAUDE.md` / `GEMINI.md` / `AGENTS.md`) — these are regenerated at launch from a single canonical `agents/<role>/AGENT.md`. API agents go through `scripts/agent_runtime.py`, a small Python loop that reads the same `AGENT.md` as a system prompt and exposes Read/Write/Edit/Bash/Grep/Glob tools.

## Hierarchical task decomposition

The Orchestrator can split a single big task into N parallel subtasks, tracked through `parent_id` + `children[]` fields in `tasks.json`. Depth is hard-capped at 2 (root + leaves, no grandchildren) — the IPC layer rejects any attempt to create a child of a child. When all children of a parent reach `done`, the parent flips to `review`. Termination and budget concerns drove the depth cap: naive recursion is the fastest way to blow up token cost, so I chose to ship one bounded level rather than open-ended recursion.

## Per-domain reviewers

Three specialised reviewers — `be-reviewer` (Python / pytest / SQL injection / type hints), `fe-reviewer` (TypeScript strict / React patterns / a11y / bundle), `ai-reviewer` (prompt injection / eval coverage / output schema / cost) — replaced the single generic Reviewer. The Orchestrator auto-routes review by file path: `*.py` and `project/backend/**` go to BE, `*.tsx` and `project/frontend/**` go to FE, `prompts/**` and `project/backend/ai/**` go to AI. Mixed-domain tasks become a parent task split into N review children — same HTN mechanism above.

## Cost & token logging

For agents running on direct APIs (Anthropic / Google / OpenAI / LM Studio), every inference call logs token counts and an estimated USD cost based on a hardcoded pricing table. Per-message totals are logged at completion, with `task=T-XXX` attached when the message header has a task ID — this is what makes per-task cost attribution possible. The pricing table is dated (`as of 2026-05`) and lives at the top of `scripts/agent_runtime.py` — an obvious thing to update or replace with a live pricing API later. CLI-backed agents (Claude Code / Codex / Gemini) don't log tokens because their usage info stays in the CLI's UI, which is acceptable since I only control programmatic backends.

The Electron app surfaces this in two places: a header chip showing today's running total, and a Cost Dashboard modal with breakdowns by agent, top tasks, and an hourly sparkline. The data source is just the log files — `electron/main.ts` parses them every 5s when the modal is open. No separate accumulator process to keep in sync.

## Dynamic agent scaling

The eight roles aren't a hard cap. The orchestrator can clone any of the six worker roles (BE / FE / AI engineers + their three reviewers) when it sees enough parallel work to make it worthwhile, and destroy the clone when the work is done. Cloning is a Bash call from the orchestrator's prompt — `./scripts/clone-agent.sh backend-engineer` returns the new instance id (`backend-engineer-2`), copies the role's `AGENT.md`, appends an entry to `agents-config.json`, and creates a fresh inbox file. The frontend's polling picks up the new entry within a few seconds and a tab appears; the PTY for that clone only spawns when the orchestrator first dispatches a message to it (the existing lazy-spawn path covers it). A soft cap warns at 5 instances per role to keep RAM in check, but doesn't block.

Singletons stay singletons — `planner` and `orchestrator` can't clone, because writing to `tasks.json` is single-writer by design.

## Task workspace

Click any task in the Tasks panel and the right-side detail view shows: metadata, dependencies, **children cards** (click to drill down), **messages thread** (every inbox/outbox block tagged `TASK: T-XXX` from any agent, sorted chronologically), and **cost spent on that task**. If the task has a parent, an `↑` breadcrumb at the top jumps back up. This is the same task-as-unit-of-work pattern Linear and Notion use — it makes the HTN parent/child graph and cross-agent message flow legible without needing to scroll multiple panels.

## Lazy spawn & idle GC

Only the two entry-point agents (`orchestrator`, `planner`) spawn at app start. The other six (BE / FE / AI workers + their reviewers) spawn on demand — either when a message lands in their inbox (the filesystem watcher in `electron/main.ts` calls `spawnAndPing()`) or when the user opens their tab in the Terminals view. After 15 minutes of no PTY activity, an idle GC sweep kills the process and frees the RAM; the agent re-spawns the next time it's needed. Pre-warmed agents are exempt from the GC so the entry points are always instant.

Two implementation details worth calling out: a 5-second warm-up wait after a fresh spawn before injecting "check inbox", because Claude Code (and the other CLIs) need time to load the per-agent context file; and a `spawnLocks` map so two simultaneous inbox events for the same agent don't race into a double-spawn. Tab status dots in the UI are colour-coded by idle bucket (green active, amber warning, rose imminent-kill) so it's visible at a glance.

## Roadmap

**Per-task budget cap.** Hard-stop an agent loop when total cost crosses a threshold per task / per session.

**Streaming responses** in the Python runtime so Electron can show partial output instead of waiting for full completion.

## Run it

Two ways. The Electron app is the primary path; tmux launcher is for terminal-only setups (macOS / WSL / Linux).

**Electron (cross-platform, recommended):**
```bash
cd project/frontend && npm install && npm run dev
```
The app spawns each agent in its own PTY internally. Open the gear icon to switch backends.

**Tmux launcher (macOS / Linux / WSL):**
```bash
./scripts/launch-tmux.sh                              # Start the system in 7 panes
./scripts/monitor.sh                                  # Live CLI dashboard
./scripts/send.sh <to> <from> <task-id> "<message>"   # Manual message inject (debug)
./scripts/reset.sh                                    # Wipe inbox / logs / tasks.json
```
Requires `tmux` + `jq` in PATH. For API-mode agents, export keys before launch:
```bash
export ANTHROPIC_API_KEY=sk-...
export GOOGLE_API_KEY=...
export OPENAI_API_KEY=...
./scripts/launch-tmux.sh
```

Tmux: `Ctrl-b <arrow>` to switch panes, `Ctrl-b z` to zoom, `Ctrl-b d` to detach.

## Stack

- **Agents:** Claude Code (Opus / Sonnet)
- **UI:** Electron, React, TypeScript, Vite, Tailwind
- **Glue:** tmux, bash, markdown, JSON
- **Code produced by the agents:** Python, TypeScript, whatever the task requires

## Status

Used in daily work. Stable for fullstack web tasks; HTN and multi-backend work in progress.
