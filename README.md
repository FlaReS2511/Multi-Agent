# Orqon

  Orqon is an experimental AI-native desktop IDE for coordinating multi-agent software development.

  It combines a local Electron IDE shell with API-driven AI agents, SQLite-backed coordination state, inline AI editing, code chat, Git tools, terminals, and a group-based worker/reviewer orchestration model.

  ## Status

  Prototype / research project.
  The IDE shell and group orchestration foundation are working, but this is not production-ready yet.

  ## Features

  - Desktop IDE built with Electron, Vite, React, and Monaco Editor
  - Workspace explorer with file create, rename, delete, read, and write operations
  - Project search and replace
  - Git status, staging, commit, pull, push, and branch switching
  - Integrated shell terminal via `node-pty`
  - Agent terminals for resident agents
  - SQLite state store for tasks, messages, logs, usage, secrets, groups, and group memory
  - Encrypted provider keys via Electron `safeStorage`
  - API-only agent runtime written in TypeScript
  - Group orchestration v2:
    - worker + reviewer lifecycle
    - request-review / submit-review signals
    - retry caps
    - budget caps
    - heartbeat timeout
    - sub-group dispatch
    - group memory timeline

  ## Architecture

  Orqon has three main layers:

  1. **IDE Shell**
     - Electron main process
     - React renderer
     - Monaco editor
     - xterm terminals
     - Git and workspace IPC handlers

  2. **State Layer**
     - SQLite database in `shared/state.db`
     - Tasks, messages, logs, usage, secrets, groups, and group memory
     - `shared/agents-config.json` for providers, models, agents, and orchestration settings

  3. **Agent Runtime**
     - Resident agents poll inbox messages from SQLite
     - Group agents run one-shot sessions
     - The coordinator owns lifecycle transitions; LLM agents only emit signals

  ## Multi-Agent Model

  The v2 orchestration model is hybrid:

  - Code owns lifecycle, budgets, retries, concurrency, spawn/kill, and heartbeat checks.
  - LLM agents own implementation, review judgment, and task-specific reasoning.

  A typical group flow:

  task
  -> worker group agent
  -> RequestReview
  -> reviewer group agent
  -> SubmitReview(pass|fail)
  -> done or retry

  ## Project Structure

  agents/                         Agent role prompts
  project/frontend/               Electron + React IDE
  project/frontend/electron/      Main process, DB, runtime, coordinator
  project/frontend/src/           Renderer UI components
  scripts/                        Legacy and utility scripts
  shared/                         Config, artifacts, SQLite runtime state
  MULTIAGENT_DESIGN.md            v2 orchestration design notes

  ## Running Locally

  cd project/frontend

  On Windows, the root launcher can also be used:

  .\start.ps1

  ## Build

  cd project/frontend
  npm run build

  ## Configuration

  Providers and agent models are configured in:

  shared/agents-config.json

  API keys are stored encrypted in SQLite using Electron safeStorage.

  ## Current Limitations

  - Experimental security model
  - Agent file tools still need stricter workspace sandboxing
  - Group orchestration should default to disabled for fresh clones
  - Some provider kinds may be listed before runtime support is implemented
  - No full automated test suite yet
  - Desktop packaging is not finalized

  ## Roadmap

  - Harden workspace and agent permissions
  - Add safer delete/replace workflows
  - Improve group budget accounting across task trees
  - Add provider capability validation
  - Add automated tests for DB migrations and coordinator state transitions
  - Package Orqon as a desktop app
  - Expand context retrieval for selected-code AI edits

  ## License
  MIT
