# OpenCode Bridge Telegram — Architecture

## 1. Project Layout

```
.
├── src/                    # Telegram Bot and process management
│   ├── index.mjs           # Main entry point for the bot and services
│   ├── bot/                # Telegram bot, Wizard FSM, telegram-channel.mjs
│   ├── core/               # OpenCode client, durable-state, memory-manager, safety, task-manager, etc.
│   └── services/           # Process management (LiteLLM, opencode serve)
└── agents/
    ├── orchestrator/       # 24/7 SDD Orchestrator (Event-driven Phase State Machine)
    │   ├── index.mjs       # Main orchestrator loop
    │   └── phases/         # Handlers for each phase (idle, plan, exec, qa, etc.)
    ├── workers/            # Isolated worker processes
    ├── runtime.mjs         # Async streaming runtime with SSE, stagnation detection
    └── docker-runtime.mjs  # Sub-agent Docker runner
```

### Entry Points

| File | Role |
|------|------|
| `src/index.mjs` | **Main bridge**. Manages `opencode serve` subprocess, LiteLLM proxy, and Health server. Instantiates Telegram bot polling and wizard (`/new`). |
| `agents/orchestrator/index.mjs` | **Main orchestrator**. Replaces hydra-loop.mjs. Event-driven loop managing phases (IDLE, PLAN, EXEC, QA, COMMIT, REFLECT, DISCOVER, ecc.). |

### Loop Project Structure

```
/loop/
├── .hydra/
│   ├── loop-checkpoint.json     # Durable phase checkpoint (atomic writes)
│   ├── loop-checkpoint.json.bak
│   ├── resume-signal.json       # HITL resume signal from Telegram callback
│   ├── event-stream.jsonl       # Append-only event log
│   ├── patterns.json            # Patterns DB (JSON array, max 200)
│   ├── cost-log.json            # Cost accumulator entries
│   ├── heartbeat                # Last phase + timestamp
│   └── bridge-chat.json         # Persisted Telegram chatId
├── prd.json                     # Root: projects[] + crossProjectStories[]
├── progress.txt                 # Global progress log
├── bugs.md                      # Cross-project bugs
├── ideas.md                     # Cross-project ideas
└── projects/
    ├── app-di-libri-usati/      # One git repo per Notion project
    │   ├── .git/
    │   ├── prd.json             # Stories for this project
    │   ├── progress.txt         # Per-project progress
    │   ├── bugs.md              # Per-project bugs
    │   ├── ideas.md             # Per-project ideas
    │   ├── CONSTITUTION.md      # SDD: immutable principles
    │   ├── PRODUCT-SPEC.md      # SDD: functional spec
    │   ├── TECHNICAL-SPEC.md    # SDD: architecture + tech decisions
    │   ├── PLAN.md              # SDD: implementation plan with task breakdown
    │   └── ... (generated code)
    ├── app-di-sondaggi/
    └── ...
```

## 2. Design Principles

| # | Principle | Implementation |
|---|---|---|
| 1 | **State outside LLM** | `prd.json`, `progress.txt`, `PLAN.md`, `loop-checkpoint.json`, `patterns.json`, `event-stream.jsonl` |
| 2 | **Fresh context per micro-task** | `agent-runtime.mjs` creates new OpenCode session per task. `runner.mjs` also fresh per invocation. |
| 3 | **Event log is primary memory** | `event-stream.jsonl` in `memory-manager.mjs` — append-only NDJSON, used for debugging + replay |
| 4 | **Atomic checkpoint per phase** | `durable-state.mjs` writes via `tmp → rename` atomic pattern |
| 5 | **Idempotency on side-effects** | Notion adapter deduplicates by `Story ID` before create. Fresh session per retry = no double-effect. |
| 6 | **HITL is a first-class gate** | Loop pauses on `question.asked` / `permission.asked`, persists `WAIT_HUMAN`, resumes on file signal |
| 7 | **Quality gates block completion** | `phaseQA()` runs `QualityGate` checks. If required check fails, story stays incomplete, enters `FIX` phase |
| 8 | **Telegram is the dashboard** | Pinned status message, typing heartbeat, SSE streaming, inline keyboards for HITL |
| 9 | **Notion is backlog source-of-truth** | `NotionAdapter` pulls tasks, merges into local `prd.json`, pushes status back |
| 10 | **SDD: spec-first, test-driven** | `project-planner` writes CONSTITUTION + PRODUCT-SPEC + TECHNICAL-SPEC + PLAN.md per progetto. `task-planner` genera test prima del builder. Builder esegue red→green→refactor. |
| 11 | **Self-documenting via AGENTS.md** | Builder scrive AGENTS.md con pattern riutilizzabili in ogni directory modificata. Ogni sessione fresh legge AGENTS.md + progress.txt per contesto. |

## 3. SDD Artifact Pipeline

```
                  ┌──────────────────────────────────────┐
                  │         PROJECT-PLANNER               │
                  │  (eseguito 1x per nuovo progetto)      │
                  │                                      │
                  │  ideas.md ──(title + description)──►  │
                  │                                      │
                  │  OUTPUT:                              │
                  │  ├── CONSTITUTION.md                  │
                  │  │   (principi immutabili, tech       │
                  │  │    stack, quality gates)           │
                  │  ├── PRODUCT-SPEC.md                  │
                  │  │   (specifica funzionale: user      │
                  │  │    personas, feature, AC)          │
                  │  ├── TECHNICAL-SPEC.md                │
                  │  │   (architettura, data model,       │
                  │  │    API, file tree)                 │
                  │  ├── PLAN.md                          │
                  │  │   (task breakdown con dipendenze,   │
                  │  │    file coinvolti, AC per task)    │
                  │  └── prd.json (aggiornato)            │
                  │      (codebasePatterns, stories 1:1   │
                  │       con PLAN.md tasks)              │
                  └──────────────────────────────────────┘
                                  │
                                  ▼
                  ┌──────────────────────────────────────┐
                  │         TASK-PLANNER                  │
                  │  (eseguito per OGNI task in PLAN)     │
                  │                                      │
                  │  Legge: CONSTITUTION + PRODUCT-SPEC   │
                  │         + TECHNICAL-SPEC + PLAN.md    │
                  │         + prd.json (task corrente)    │
                  │                                      │
                  │  OUTPUT:                              │
                  │  ├── Test stub che codificano AC      │
                  │  │   (red → barra verde, fail intenz.)│
                  │  ├── PLAN.md (aggiornato con dettagli  │
                  │  │   implementativi del task)         │
                  │  └── progress.txt (note, prereq)      │
                  └──────────────────────────────────────┘
                                  │
                                  ▼
                  ┌──────────────────────────────────────┐
                  │         BUILDER                       │
                  │  (eseguito per OGNI task in EXEC)     │
                  │                                      │
                  │  1. Legge CONSTITUTION + PRODUCT-SPEC │
                  │     + TECHNICAL-SPEC + PLAN.md        │
                  │  2. Trova test pre-esistenti          │
                  │  3. Esegue test (RED iniziale)        │
                  │  4. Implementa (GREEN)                │
                  │  5. Rifattorizza (REFACTOR)           │
                  │  6. typecheck + test + lint           │
                  │  7. Se nessun test, li scrive PRIMA   │
                  │  8. Imposta passes: true in prd.json  │
                  │  9. Scrive AGENTS.md, progress.txt    │
                  │  10. git commit                       │
                  └──────────────────────────────────────┘
```

## 4. Hydra Loop — SDD State Machine

### Phase Transitions

```
                     ┌──────► IDLE ◄─────────────────────────┐
                     │          │                             │
                     │          ▼                             │
                     │        PLAN ─── (task-planner)         │
                     │          │                             │
                     │          ▼                             │
                     │ ┌──►  EXEC ─── (Builder, test-first)   │
                     │ │       │                              │
                     │ │   ┌───┴────┐                         │
                     │ │   ▼        ▼                         │
                     │ │ PAUSED   FIX ◄──┐                    │
                     │ │ (per-     │     │                    │
                     │ │ project)  │     │                    │
                     │ │   │       ▼     │                    │
                     │ │   │      QA ────┘                    │
                     │ │   │       │                           │
                     │ │   │       ▼                           │
                     │ │   │    COMMIT                         │
                     │ │   │       │                           │
                     │ │   │       ▼                           │
                     │ │   └───── SYNC ────────────────────────┘
                     │ │
                     │ └── DISCOVER (ciclo completo scoperta)
                     │      ├── bug-hunter → bugs.md
                     │      ├── innovator → ideas.md
                     │      ├── orchestrator → stories in prd.json
                     │      ├── project-planner → SDD artifacts (solo nuovi)
                     │      └── sync nuove storie → Notion
```

**Pause è per-progetto, non globale.** Se un progetto va in pausa (budget, stagnazione, max tentativi), il loop continua a processare gli altri progetti. I progetti in pausa sono registrati in `.hydra/paused-projects.json` e saltati da `getNextPending()`.

### Phase Details

| Phase | Handler | What it does | SDD Role |
|-------|---------|-------------|----------|
| `IDLE` | `phaseIDLE()` | Load tasks da Notion + prd.json. Aggiorna registro. Scopre nuovi progetti. Auto-unpause progetti le cui condizioni non sussistono più. Conta solo task disponibili (non in pausa). Se nessun task → DISCOVER. | Source sync |
| `PLAN` | `phasePLAN()` | Pick prossimo pending NON in pausa. Split se oversized. Se tutti i pending sono in pausa → IDLE. Avvia `task-planner` genera test stub. | Spec generation |
| `EXEC` | `phaseEXEC()` | Spawn `AgentRuntime` builder SDD. `question.asked`/`permission.asked` auto-approvati (LLM ha pieno accesso). Stagnation → pausa progetto. Budget superato → pausa progetto. | Implementation |
| `QA` | `phaseQA()` | QualityGate (typecheck, test, lint, build). Skip se no config. Se fallisce → rollback + FIX. | Validation |
| `COMMIT` | `phaseCOMMIT()` | git add + commit. | Persistence |
| `SYNC` | `phaseSYNC()` | Push Notion. Persiste prd.json. Rebuild project files. | Sync |
| `FIX` | `phaseFIX()` | Incrementa attempt. Rollback snapshot. Se >= maxAttempts → BLOCKED + pausa progetto. Altro → ri-EXEC. | Error recovery |
| `DISCOVER` | `phaseDISCOVER()` | Per progetto: bug-hunter → innovator → orchestrator → project-planner (solo nuovo). Push storie a Notion. | Discovery |
| `WAIT_HUMAN` | `phaseWAIT_HUMAN()` | Persist checkpoint. Poll resume-signal.json. Usato solo per circuito esterno (non auto-transizione dal loop). | Human gate |

## 5. SDD Cycle — Dalla Scoperta al Progetto Finito

### 5.1 Nuovo Progetto da Notion

```
Notion DB ──(nuova pagina)──► IDLE
                                │
                                ▼
                     _syncNewProjectsFromNotion()
                     │  confronta pageId con root prd.json
                     │  trova nuovo progetto → crea slug, dir
                     │  _initProjectDirectory() → mkdir + git + stubs
                     │  aggiunge a root prd.json: projects[]
                     │  return newProjects[]
                                │
                                ▼
                           DISCOVER
                                │
                    ┌───────────┴───────────┐
                    ▼                       ▼
             bug-hunter (skip)      innovator → ideas.md
                                         │
                                         ▼
                                   orchestrator → prd.json
                                         │
                                         ▼
                                  project-planner
                                   ├── CONSTITUTION.md
                                   ├── PRODUCT-SPEC.md
                                   ├── TECHNICAL-SPEC.md
                                   ├── PLAN.md
                                   └── prd.json (aggiornato)
                                         │
                                         ▼
                                    IDLE → PLAN → EXEC...
```

### 5.2 Bug Resolution

```
DISCOVER (triggerato quando IDLE trova 0 pending)
    │
    ▼
bug-hunter per ogni progetto con codice
    │  esegue app, test, analisi statica
    │  trova bug → append a bugs.md
    │
    ▼
innovator per ogni progetto
    │  propone feature → append a ideas.md
    │
    ▼
orchestrator per ogni progetto
    │  legge bugs.md + ideas.md
    │  crea nuove storie con AC in prd.json
    │  deduplica, ordina per priorità
    │
    ▼
sync nuove storie → Notion
    │
    ▼
IDLE → trova storie bug → PLAN → EXEC → QA → COMMIT → SYNC

In FIX: se builder fallisce o QA fallisce:
    rollback git snapshot → incrementa attempt → ri-EXEC
    se 3 tentativi esauriti → BLOCKED → notifica Telegram
```

### 5.3 Nuova Feature Discovery

```
Come bug resolution, ma:
  innovator → ideas.md (feature propose, non bug)
  orchestrator → crea storie feature
  project-planner → NON eseguito (progetto già esistente)
  
Nuove storie feature entrano nel loop normale:
  IDLE → PLAN (task-planner → test) → EXEC (builder test-first) → QA → COMMIT → SYNC
```

### 5.4 Progetto Completato (compilabile, testato, funzionante)

```
Criterio di completamento:
  tutte le storie in prd.json hanno passes: true
  QA passa (typecheck + test + lint + build)

Stato IDLE:
  st.done === st.total, st.left === 0, st.blocked === 0
    → "No pending tasks. Running discovery agents..."
    → DISCOVER (cerca nuovi bug/idee)

Se non ci sono nuovi bug o idee:
  → orchestrator non crea nuove storie
  → IDLE trova 0 pending
  → DISCOVER (nessuna scoperta nuova)
  → IDLE (sleep 5s)
  → loop continua all'infinito, in attesa di nuove storie da Notion

Se arriva nuovo task da Notion:
  IDLE → loadTasks() → merge Notion → nuovo task
  → st.left > 0 → PLAN → EXEC → ...
```

### 5.5 Ciclo Continuo

```
┌─────────────────────────────────────────────────────────┐
│ while(true):                                             │
│                                                          │
│  IDLE:                                                   │
│    1. _refreshRegistry() — ricostruisce da prd.json      │
│    2. _syncNewProjectsFromNotion() — scopre nuovi        │
│    3. tasks.loadTasks() — flatten + merge Notion         │
│    4. _assignPendingTasksToProjects() — assegna slug     │
│    5. Stats: se nuovi progetti → DISCOVER                │
│              se 0 pending + 0 blocked → DISCOVER         │
│              se 0 pending + N blocked → WAIT_HUMAN       │
│              se N pending → PLAN                         │
│                                                          │
│  PLAN:                                                   │
│    1. Prende prossimo task (topological sort)            │
│    2. Split se oversized                                 │
│    3. _initTaskProject() → resolve dir, sync story       │
│    4. Se SDD artifacts esistono → task-planner           │
│       → genera test stub che codificano AC               │
│       → aggiorna PLAN.md                                 │
│                                                          │
│  EXEC:                                                   │
│    1. AgentRuntime(builder) — fresh session              │
│    2. Builder:                                           │
│       a. Legge CONSTITUTION, PRODUCT-SPEC, TECHNICAL-SPEC│
│       b. Trova test pre-esistenti                        │
│       c. Li esegue (RED) → implementa (GREEN)            │
│       d. Refactoring                                     │
│       e. typecheck + test + lint                         │
│       f. passes: true                                    │
│       g. AGENTS.md auto-documentation                    │
│       h. git commit                                      │
│                                                          │
│  QA:                                                     │
│    1. QualityGate: typecheck (required), test (required) │
│                     lint (optional), build (if exists)    │
│    2. Se passa → COMMIT                                  │
│    3. Se fallisce → rollback snapshot → FIX              │
│                                                          │
│  FIX:                                                    │
│    1. Incrementa attempt counter                         │
│    2. Se >= maxAttempts (3) → BLOCKED                    │
│    3. Altrimenti → EXEC (ritenta con snapshot pulito)    │
│                                                          │
│  COMMIT: git add -A && git commit                        │
│  SYNC: push a Notion, persist prd.json, rebuild files    │
└─────────────────────────────────────────────────────────┘
```

## 6. Components

### 6.1 Bridge (`index.mjs`, `bridge-v3.mjs`, `bridge-v2.cjs`)
- **Polling**: offset-based `getUpdates` with 30s timeout, 300ms interval between polls
- **Rate limiting**: Telegram Bot API — no explicit rate limiter, relies on polling interval
- **Message splitting**: chunks at 4000 chars, breaks at last `\n` boundary
- **Markdown safety**: strips triple backticks from code blocks to prevent parse errors
- **Session lifecycle**: auto-create on first message, `/new` resets + deletes messages
- **Authorization**: `TELEGRAM_ALLOWED_USER_ID` comma-separated list (default: `***REMOVED***`)

### 6.2 Durable State (`src/core/durable-state.mjs`)
- **File**: `.hydra/loop-checkpoint.json`
- **Atomic writes**: write to `*.tmp{timestamp}` → `renameSync` → delete backup
- **Schema**: `{ version, phase, lastPhase, currentTaskId, currentStory, attempt, maxAttempts, previousError, eventId, costAccumulatorUsd, storiesCompletedToday }`
- **Transition**: `transition(newPhase, extraFields)` — sets `lastPhase`, increments `eventId`, merges extra, saves

### 6.3 Task Manager (`src/core/task-manager.mjs`)
- **Sources**: `prd.json` (local) + `NotionAdapter` (remote)
- **Structure**: root prd.json ha `projects[]` (ogni progetto con `stories[]`) + `crossProjectStories[]`
- **Flatten**: `loadTasks()` appiattisce da tutti i progetti in un array interno con `_projectSlug`
- **Persist**: raggruppa per `_projectSlug`, ricostruisce `projects[].stories`, rebuild per-project prd.json
- **Merge**: Notion wins on status/priority unless local says completed; excluded tasks filtered out
- **Sorting**: Kahn-like topological sort with priority tiebreaker; infra stories before UI stories
- **Splitting**: 2-way split by acceptance criteria halves, appends `-a` / `-b` suffixes
- **CRUD**: `getNextPending()`, `markPass()`, `markBlocked()`, `addStory()`
- **Project sync**: `_syncProjectFiles()` aggiorna il per-project prd.json + root prd.json

### 6.4 Agent Runtime (`agents/runtime.mjs`)
- **Session**: creates fresh OpenCode session per `run()`
- **SSE**: subscribes to `/global/event`, processes event types:
  - `message.part.updated.type=reasoning` → thinking event
  - `message.part.updated.type=tool` → tool call event
  - `session.diff` → file changes
  - `message.updated` → token/cost tracking + completion detection
  - `question.asked` / `permission.asked` → human gate required
  - `session.error` / `session.status.type=retry` → stagnation tracking
- **System prompts**: 6 agent types (builder, bug-hunter, innovator, orchestrator, project-planner, task-planner) — ognuno con prompt SDD dedicato
- **Context injection**: per ogni agente, legge prd.json, progress.txt, bugs.md, ideas.md, AGENTS.md, git log
- **Stagnation**: same error fingerprint ≥3 times → emit `stagnation` event
- **Poll fallback**: polls `GET /session/{id}/message` every 3s as SSE backup
- **Timeout**: configurable via `Safety.maxCycleMs()`
- **SOTA Cache**: Predictive Semantic Cache using `src/core/semantic-cache.mjs`
- **SOTA Distillation**: Auto-Distillation using `src/core/distillation-logger.mjs`

### 6.5 Telegram Channel (`src/bot/telegram-channel.mjs`)
- **Pinned message**: debounced at 2s interval, shows phase, task, model, context, cost, files, uptime
- **Heartbeat**: `sendChatAction('typing')` every 4s while loop is alive — user knows system isn't crashed
- **HITL**: `requestHumanGate()` sends inline keyboard: Approve / Reject / Pause / Abort
- **Alerts**: `alert(level, text)` — info (ℹ️), warn (⚠️), critical (🚨)
- **Auto-reinit**: if pinned message is deleted → re-send and re-pin

### 6.6 Notion Adapter (`src/core/notion-adapter.mjs`)
- **Two modes**: Page mode (heading_3 blocks as stories) and Database mode (structured properties)
- **Auto-detect**: tries `/databases/{id}` first, falls back to page mode
- **Page mode**: parses `### N) "Title" (tag)` headings, nested blocks via recursive fetch
- **Database mode**: queries with filters (Status, Project tag), paginated via `start_cursor`
- **Push**: `pushProgress()` updates heading text (page mode) or properties.Status (database mode)
- **Create**: `createStory()` checks duplicates by `Story ID`, appends block or creates DB page
- **New project detection**: `pullTasks()` returns all pages → IDLE confronta pageId con root prd.json

### 6.7 Memory Manager (`src/core/memory-manager.mjs`)
- Uses **JSONL** (`event-stream.jsonl`) and **JSON** (`patterns.json`) — no SQLite
- Append-only event log via `appendEvent(type, payload)`
- Pattern deduplication by normalized text, max 200 entries
- `progress.txt` compatibility: `appendProgress()` writes chronological log entries
- Compaction stubbed at 50 MB threshold (not implemented)

### 6.8 Quality Gate (`src/core/quality-gate.mjs`)
- Project-local config: `.hydra/gate.json` with `checks` array
- Auto-detect from `package.json` scripts: `typecheck`, `test`, `lint`, `build`
- Default checks: `typecheck`, `test` (required), `lint` (optional)
- Port injection: `{APP_PORT}` placeholder replaced from `.port` file
- Returns `{ passed, results: [{ name, passed, required, output, exitCode }] }`

### 6.9 Safety (`src/core/safety.mjs`)
- **Circuit breaker**: 3 consecutive 5xx/429 → open. Half-open after 5 min cooldown.
- **Cost guard**: daily window (24h), configurable via `LOOP_DAILY_COST_LIMIT` (default $10). Quando superato → pausa solo il progetto corrente, non l'intero loop.
- **Git snapshot**: `git stash push -m "hydra-pre-{storyId}"` before EXEC. Rollback via stash pop.
- **Timeout**: `LOOP_MAX_CYCLE_MINUTES` or `LOOP_MAX_CYCLE_MS` (default 30 min)
- **Per-project pause**: budget, stagnazione, o max tentativi mettono in pausa SOLO il progetto interessato (`paused-projects.json`). Altri progetti continuano.

## 7. Sub-Agent Runner System

### `agents/runner.mjs` — Fresh Session Runner
Used by both `bridge-v3.mjs` `/loop agent` command and `agents/loop.mjs`.

| Agent Type | Role | SDD Artifacts |
|------------|------|---------------|
| `builder` | Test-first implementation: legge SDD artifacts, scrive test prima del codice, red→green→refactor, QA gate, AGENTS.md auto-doc, git commit | CONSTITUTION, PRODUCT-SPEC, TECHNICAL-SPEC, PLAN.md, prd.json |
| `bug-hunter` | Fresh analysis: runs app, reads code, appends bugs to `bugs.md` | bugs.md |
| `innovator` | Fresh ideation: explores app, proposes features to `ideas.md` | ideas.md |
| `orchestrator` | Maintains `prd.json`: merges bugs/ideas into stories, deduplicates, reorders by priority | prd.json |
| `project-planner` | SDD project planner (new projects): scrive CONSTITUTION, PRODUCT-SPEC, TECHNICAL-SPEC, PLAN.md, prd.json. Crea task breakdown da init a MVP. | CONSTITUTION, PRODUCT-SPEC, TECHNICAL-SPEC, PLAN.md, prd.json |
| `task-planner` | Per-task spec generation: legge SDD artifacts, scrive test stub che codificano AC, aggiorna PLAN.md | Test files, PLAN.md |

Each invocation creates a **fresh OpenCode session** (no chat history), injects full file context (SDD artifacts, git log, package.json, progress.txt, bugs.md, ideas.md, AGENTS.md), and runs until completion or timeout.

### System Prompt Architecture

```
agent-runtime.mjs (used by hydra-loop):
  systemParts = {
    builder:          SDD builder prompt (test-first)
    bug-hunter:       Fresh analysis prompt
    innovator:        Fresh ideation prompt
    orchestrator:     PRD maintenance prompt
    project-planner:  SDD new project planner
    task-planner:     SDD per-task planner
  }
  → system = systemParts[this.agentType] || systemParts.builder
  → context injection: prd.json, progress.txt, bugs.md, ideas.md, AGENTS.md, git log

runner.mjs (used standalone or by legacy loop):
  AGENTS = {
    builder, bug-hunter, innovator, orchestrator,
    project-planner, task-planner
  }
  → buildGenericPrompt() or buildBuilderPrompt()
  → same context injection pattern
```

### `agents/orchestrator/index.mjs` — SDD State Machine Loop
The primary 24/7 loop. Uses all `src/core/` components. Recovers from `loop-checkpoint.json` on restart. Handles all phases including DISCOVER (parallel discovery agents) and WAIT_HUMAN (polling for resume signal).

Key architectural patterns:
- **Project Registry**: `Map<pageId, {slug, title, dir}>` — refreshato ogni IDLE da root prd.json
- **New Project Discovery**: `_syncNewProjectsFromNotion()` — confronta pageId Notion con root prd.json, crea dir + git + stubs
- **Task Assignment**: `_assignPendingTasksToProjects()` — setta `_projectSlug` per task Notion non assegnati
- **SDD Gate**: `phasePLAN()` controlla esistenza artefatti SDD prima di eseguire task-planner

### `agents/loop.mjs` — Legacy Ralph Loop
Older loop implementation. Uses `spawnSync` to run `runner.mjs` for each agent. Simpler state management (no durable checkpoint). Still functional but being superseded by hydra-loop.

## 8. OpenCode API Endpoints Used

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/health` | Server readiness check |
| POST | `/session` | Create new session |
| GET | `/session?limit=20` | List recent sessions |
| POST | `/session/{id}/message` | Send prompt |
| POST | `/session/{id}/abort` | Abort running session |
| GET | `/session/status` | Active sessions overview |
| GET | `/session/{id}/message?role=assistant&limit=3` | Poll for completion |
| GET | `/global/event` | SSE event stream (live updates) |

## 9. Environment Variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `TELEGRAM_BOT_TOKEN` | **Yes** | — | Bot token from @BotFather |
| `TELEGRAM_ALLOWED_USER_ID` | No | `***REMOVED***` | Comma-separated Telegram user IDs |
| `NOTION_API_TOKEN` | For Notion | — | Notion internal integration token |
| `NOTION_DATABASE_ID` | For DB mode | — | Notion database ID |
| `NOTION_PAGE_ID` | For page mode | — | Notion page ID (falls back to db id) |
| `OPENCODE_PORT` | No | `4096` | Port for opencode serve |
| `BRIDGE_MODE` | No | `api` | `api` (opencode serve) or `cli` (opencode run) |
| `SESSION_TIMEOUT_MINUTES` | No | `1440` | Session idle timeout (0 = ∞) |
| `STALL_TIMEOUT_MINUTES` | No | `30` | Alert if no SSE events (0 = off) |
| `OPENCODE_DEFAULT_PROJECT` | No | `neo` | Default project key |
| `OPENCODE_DEFAULT_MODEL` | No | `opencode big pickle` | Default model |
| `LOOP_DAILY_COST_LIMIT` | No | `10` | Max daily cost in USD |
| `LOOP_MAX_CYCLE_MINUTES` | No | `30` | Max agent runtime per task |
| `LOOP_MAX_CYCLE_MS` | No | — | Override cycle timeout in ms |
| `LOOP_MAX_ATTEMPTS` | No | `3` | Retry count before BLOCKED |
| `HYDRA_CHAT_ID` | No | — | Telegram chat ID for loop status |

## 10. Anti-Patterns We Avoid

| Anti-Pattern | Our Replacement |
|---|---|
| Keeping all state in LLM context | Durable JSON checkpoints + file-based SDD artifacts (`loop-checkpoint.json`, `CONSTITUTION.md`, `PLAN.md`) |
| Naive summarization as compaction | Event log + stubbed semantic condenser — compaction not yet implemented, but event-stream.jsonl preserves raw events for debugging |
| One monolithic prompt for everything | Task decomposition via `TaskManager.splitStory()`, fresh session per micro-task, SDD artifact chain |
| Global pause on any human gate | Per-project pause: solo il progetto problematico si ferma, il loop continua con gli altri |
| Retrying without idempotency | Fresh session per retry = no double-effect from prior run. Git snapshot rollback prima di ogni retry. |
| Blind trust in agent "done" statements | Mandatory Quality Gate (typecheck + test + lint) before marking passes:true |
| `0.0.0.0` in curl health checks | Always use `127.0.0.1` — `0.0.0.0` is a bind address, not reachable |
| Sending documents via `file://` URLs | Telegram Bot API does not support file:// URLs — chunk text into multiple messages instead |
| Spec as static document | SDD artifacts (CONSTITUTION, PRODUCT-SPEC, TECHNICAL-SPEC, PLAN.md) sono viventi: aggiornati da project-planner, task-planner, builder a ogni ciclo |
| Code without tests | SDD impone test-first: task-planner scrive test, builder implementa per farli passare. QA gate li esegue. |

## 11. Known Architectural Gaps

| Gap | Impact | Priority |
|-----|--------|----------|
| **No health check HTTP endpoint** | No external monitoring (systemd, uptime robot) | Low |
| **No process manager config** | No systemd/pm2 unit provided — user must set up manually | Low |
| **No log rotation** | `event-stream.jsonl` grows unbounded | Medium |
| **No general idempotency keys** | API calls (Telegram, Notion) could double-fire on retry if network flakes at the wrong moment | Medium |
| **Compaction stubbed** | `compact()` always returns false, no automated summarization | Low |
| **SDD artifacts only for new projects** | Existing projects not retrofitted with SDD artifacts — task-planner non eseguito su progetti legacy | Low |
| **No parallel task execution** | Tasks eseguiti one-at-a-time anche quando PLAN.md dichiara task parallelizzabili | Medium |
| **No QA build step per default** | `build` check non è required — non garantisce che il progetto sia compilabile sempre | Low |
| **No per-project auto-resume via Telegram** | Resume signal per progetto è file-based — manca automazione callback Telegram | Low |

## 12. Data Flow Diagrams

### 12.1 Notion → Loop → Progetto

```
Notion Database
    │
    ├── pullTasks() ───────────────────────────────┐
    │   (pages with Status, Project tag)            │
    │                                               ▼
    │                                        IDLE phase
    │                                   _syncNewProjectsFromNotion()
    │                                   tasks.loadTasks() (merge)
    │                                   _assignPendingTasksToProjects()
    │                                               │
    │                                               ▼
    │                                        PLAN → EXEC → QA → COMMIT
    │                                               │
    └──────────── pushProgress() ◄──────────────────┘
         (status: completed/blocked/idle)
```

### 12.2 File-Based Memory Chain

```
Ogni task fresh session riceve:
  prd.json ────── storie + AC del progetto
  progress.txt ── codebase patterns + cronologia
  bugs.md ─────── bug noti
  ideas.md ────── idee da esplorare
  AGENTS.md ───── pattern riutilizzabili per directory
  CONSTITUTION.md ─ principi immutabili (SDD)
  PRODUCT-SPEC.md ─ specifica funzionale (SDD)
  TECHNICAL-SPEC.md ─ specifica tecnica (SDD)
  PLAN.md ────────── piano implementativo (SDD)
  git log ────────── cronologia commit
  package.json ───── dipendenze e script
```

## 13. File Relationships

```
index.mjs (entry)
├── spawns → opencode serve
├── imports → PROJECTS (projects.mjs)
├── imports → MemoryManager
├── spawns → agents/hydra-loop.mjs
│   └── imports → src/core/* (all)
└── spawns → agents/runner.mjs (via /loop agent command)

bridge-v3.mjs (standalone alternative)
├── spawns → opencode serve
└── same pattern as index.mjs (no wizard, no loop control)

bridge-v2.cjs (legacy)
├── calls → opencode run CLI
└── standalone (no core imports)
```
