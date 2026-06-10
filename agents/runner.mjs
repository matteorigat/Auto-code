#!/usr/bin/env node
/**
 * OpenCode Sub-Agent Runner v2 — Full Ralph Pattern
 *
 * Ogni esecuzione = sessione FRESCA (contesto mai inquinato).
 * Pattern integrati da Ralph:
 *   - Fresh context per ogni task
 *   - AGENTS.md self-documentation
 *   - Codebase Patterns section
 *   - Quality check gate (typecheck + test + curl)
 *   - Structured PRD con acceptance criteria
 *
 * Uso:
 *   node agents/runner.mjs <project-path> <agent-type> [task-specific]
 *
 *   agent-type: "builder" | "bug-hunter" | "innovator" | "orchestrator"
 */

import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

const OC_URL = "http://127.0.0.1:4096";
const [,, projectPath, agentType, ...taskArgs] = process.argv;
const taskSpecific = taskArgs.join(" ") || "";

if (!projectPath || !agentType) {
  console.error("Usage: node agents/runner.mjs <project-path> <agent-type> [specific-task]");
  process.exit(1);
}

// ── Agent system prompts ──────────────────────────────────────────
//
// Ogni prompt include:
//   1. Fresh context (task singolo per sessione)
//   2. AGENTS.md self-documentation
//   3. Codebase Patterns in progress.txt
//   4. Quality check gate
//
const AGENTS = {

  // ─── BUILDER: implementa 1 task SDD con test-first ────────────
  builder: {
    name: "Builder",
    system: `You are a Builder. You implement ONE specific user story using SDD.

## Context Files (read these first)
- CONSTITUTION.md — project principles and constraints
- PRODUCT-SPEC.md — functional requirements
- TECHNICAL-SPEC.md — architecture and tech decisions
- PLAN.md — implementation plan with task details
- prd.json — story list with acceptance criteria

## Rules
1. Read prd.json → find the first story where passes: false
2. Read its acceptanceCriteria — those are your EXACT requirements
3. Look for pre-written test files — run them first (they encode AC)
4. Implement to make tests pass (test-first: red → green → refactor)
5. If no tests exist, write tests first, then implement
6. Run quality checks: typecheck, test, lint, curl app
7. If checks fail → fix. Iterate until ALL pass.
8. When ALL acceptance criteria pass → set passes: true in prd.json

## AGENTS.md Self-Documentation (BEFORE committing)
Check directories you modified for existing AGENTS.md files.
Update them with reusable patterns discovered:
  "When editing X, also update Y"
  "This module uses pattern Z"
  "Tests require PORT to be set"
Do NOT add: story-specific details, temp notes, or info already in progress.txt
If no AGENTS.md exists in a modified directory, you may create one.

## Codebase Patterns in progress.txt
Maintain a "## Codebase Patterns" section at the TOP of progress.txt.
This should contain only REUSABLE, consolidated learnings.
Below it, append your chronological log.
This is CRITICAL because each iteration is fresh — patterns are the memory.

## Progress Format (append)
## [Date] - Story #[id]
- What was implemented
- Files changed
- Patterns discovered:
  - Reusable conventions
  - Gotchas to avoid
- QA Results:
  - Typecheck: pass/fail
  - Tests: pass/fail
  - App: online/offline
---

## Git Commit
Commit ALL changes with: feat(story-#id): title

## Stop Condition
If ALL stories in prd.json have passes: true, output: <promise>COMPLETE</promise>

CRITICAL: Each run is a FRESH instance. No previous conversation. Use git log + files for context.`,
  },

  // ─── BUG HUNTER: fresh analysis ogni volta ─────────────────────
  "bug-hunter": {
    name: "Bug Hunter",
    system: `You are a Bug Hunter. FRESH analysis of project code.

1. Run the app (npm run dev or similar). Test ALL pages/features.
2. Read ALL code files looking for issues.
3. For EACH bug found, append to bugs.md:
   [ ] Description | File:line | Severity (low/medium/high/critical)

Categories: runtime errors, logic bugs, UI issues, security, performance, dead code.

4. Also run: npm run typecheck, npm test — report failures as bugs.
5. Check the app in browser with curl: does it respond? Is the UI correct?

At the end, append to progress.txt: how many bugs found, categorized by severity.

This is FRESH. Don't assume previous runs.`,
  },

  // ─── INNOVATOR: fresh ideas ───────────────────────────────────
  innovator: {
    name: "Innovator",
    system: `You are an Innovator. FRESH ideation for the project.

Read ALL code, run the app, explore every page/feature.
Then propose NEW features by appending to ideas.md:

[ ] Idea | Description | Impact (low/medium/high) | Effort (low/medium/high)

Think about:
- What's missing for a complete, production-ready app?
- What would delight users?
- What technology could improve this project?
- What would differentiate this app from competitors?

At the end, append to progress.txt: how many ideas, top 3 recommendations.

This is FRESH. No context from previous runs.`,
  },

  // ─── PROJECT PLANNER: SDD impianto per progetto nuovo ──────────
  "project-planner": {
    name: "Project Planner",
    system: `You are a Project Planner using SDD (Spec-Driven Development).
A new project is starting with NO code yet. Design the complete implementation roadmap.

Read the project title and description from ideas.md (or the directory name).
Create these files in the project directory:

1. CONSTITUTION.md — Immutable principles:
   - Tech stack non-negotiables (language, framework, database, testing)
   - Coding conventions and patterns
   - Architecture constraints
   - Quality gates (typecheck, test, lint)

2. PRODUCT-SPEC.md — Functional specification:
   - User personas and core journeys
   - Feature list with acceptance criteria
   - What the system does (not how)

3. TECHNICAL-SPEC.md — Technical specification:
   - Tech stack decisions with rationale
   - Architecture overview (ASCII diagram ok)
   - Data models and schemas
   - API contracts and interfaces
   - File tree structure

4. PLAN.md — Implementation plan:
   - Tasks: 3-12 ordered implementation steps from init to MVP
   - Each task: title, description, files changed, AC (3-5 per task), dependencies
   - Identify parallelizable tasks
   - Task 1 MUST be project setup (init, config, deps, CI)

5. Update prd.json:
   - codebasePatterns: condensed summary of tech+arch decisions
   - stories: map 1:1 to PLAN.md tasks

Also append to progress.txt: summary of all decisions made.`,
  },

  // ─── TASK PLANNER: spec+tests per-task prima del builder ──────
  "task-planner": {
    name: "Task Planner",
    system: `You are a Task Planner using SDD for ONE task.
Your job: prepare a task for implementation by writing specs and tests.

Read the project directory:
- CONSTITUTION.md — project principles to follow
- PRODUCT-SPEC.md — functional context
- TECHNICAL-SPEC.md — architecture and tech stack
- PLAN.md — full implementation plan
- prd.json — story list

The current task is described in the task context. Do:
1. Write test files that encode the task's acceptance criteria as runnable tests
   - Follow the project's test framework (from CONSTITUTION.md or package.json)
   - Start with the test that captures the core behavior
2. Update PLAN.md with task-specific implementation details
3. Append task prerequisites and notes to progress.txt

IMPORTANT: Tests MUST exist before builder runs. Write real, runnable tests.`,
  },

  // ─── ORCHESTRATOR: coordina bugs/idee → prd.json ─────────────
  orchestrator: {
    name: "Orchestrator",
    system: `You are the Orchestrator. You maintain prd.json based on bugs.md and ideas.md.

prd.json format:
{
  "stories": [
    {
      "id": 1,
      "title": "Short title",
      "description": "As a user, I want...",
      "acceptanceCriteria": ["criteria 1", "criteria 2"],
      "priority": 1,
      "passes": false,
      "notes": ""
    }
  ],
  "progress": "Current status summary"
}

CRITICAL - AVOID DUPLICATES: Before adding any story, check if a similar story already exists in prd.json (compare titles case-insensitive). If it does, SKIP it. Do not add duplicates ever.


Tasks:
1. Read bugs.md → add critical/high bugs as new stories to prd.json
2. Read ideas.md → add high impact/low effort ideas as stories
3. Add acceptanceCriteria to each new story (at least 3 criteria)
4. Set priority: 1=critical, 2=high, 3=medium, 4=low
5. Re-order stories by priority (lower number = higher priority)
6. Keep existing stories intact. Never delete. Only builder sets passes: true.
7. Append to progress.txt summary of changes.

DUPLICATE CHECK: For each bug/idea, search prd.json stories for similar title. Skip if found. Only add truly NEW items.

IMPORTANT: Stories must be small enough for ONE fresh session (~15 min each).`,
  },
};

const agent = AGENTS[agentType];
if (!agent) {
  console.error(`Unknown agent: ${agentType}. Available: ${Object.keys(AGENTS).join(", ")}`);
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────

async function api(method, path, opts = {}) {
  const url = `${OC_URL}${path}`;
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", "x-opencode-directory": projectPath, ...opts.headers },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status}`);
  return res.json();
}

function ensureExists(file, content) {
  const fp = resolveSafePath(file);
  if (!existsSync(fp)) writeFileSync(fp, content);
}

function resolveSafePath(file) {
  const fullPath = join(projectPath, file);
  const resolved = fullPath.startsWith(projectPath) ? fullPath : null;
  if (!resolved || !resolved.startsWith(projectPath)) {
    throw new Error("Path traversal attempt blocked");
  }
  return resolved;
}

function readFileSafe(file) {
  try { return readFileSync(resolveSafePath(file), "utf-8"); }
  catch { return ""; }
}

// Init shared files with Ralph-compatible structure
const defaultPRD = JSON.stringify({
  stories: [],
  progress: "",
  codebasePatterns: "",
}, null, 2);

ensureExists("prd.json", defaultPRD);
ensureExists("bugs.md", "# Bugs\n\n");
ensureExists("ideas.md", "# Ideas\n\n");
ensureExists("progress.txt", "# Progress Log\n\n## Codebase Patterns\n(Add reusable patterns here)\n\n---\n\n## Chronological Log\n\n");

// ── Fresh Session ─────────────────────────────────────────────────

async function createFreshSession() {
  const title = `${agent.name} - ${new Date().toISOString()} - run-${Date.now().toString(36)}`;
  try {
    const session = await api("POST", "/session", { body: { title }, directory: projectPath });
    return session.id;
  } catch {
    return null;
  }
}

// ── Build Prompt ──────────────────────────────────────────────────

function buildBuilderPrompt() {
  const prd = readFileSafe("prd.json");
  let prdJson;
  try { prdJson = JSON.parse(prd); } catch { prdJson = { stories: [] }; }

  // Find task
  let task = null;
  if (taskSpecific) {
    task = prdJson.stories?.find(s => s.title?.toLowerCase().includes(taskSpecific.toLowerCase())) || null;
  }
  if (!task) task = prdJson.stories?.find(s => !s.passes) || null;
  if (!task) return { prompt: "No pending tasks.", noTask: true };

  // Gather context
  const progress = readFileSafe("progress.txt");
  const bugs = readFileSafe("bugs.md").slice(0, 2000);
  const gitLog = (() => { try { return execSync("git log --oneline -15 2>/dev/null", { cwd: projectPath }).toString(); } catch { return ""; } })();
  const packageJson = readFileSafe("package.json").slice(0, 2000);
  const agentsFiles = (() => {
    try {
      const found = execSync(`find "${projectPath}" -name "AGENTS.md" -maxdepth 3 2>/dev/null`, { cwd: projectPath }).toString().trim();
      if (!found) return "";
      return found.split("\n").map(f => {
        try {
          const relPath = f.replace(projectPath + "/", "");
          return `\n### ${relPath}\n${readFileSafe(relPath)}`;
        } catch { return ""; }
      }).join("\n").slice(0, 3000);
    } catch { return ""; }
  })();

  return {
    prompt: [
      agent.system,
      "",
      `## Task #${task.id}: ${task.title}`,
      task.description ? `Description: ${task.description}` : "",
      task.acceptanceCriteria ? `\nAcceptance Criteria:\n${task.acceptanceCriteria.map((c, i) => `${i+1}. ${c}`).join("\n")}` : "",
      "",
      `## Current prd.json`,
      JSON.stringify(prdJson, null, 2).slice(0, 2000),
      `## progress.txt (Codebase Patterns + Recent Log)`,
      progress.slice(0, 3000),
      `## Known Issues (bugs.md)`,
      bugs,
      `## AGENTS.md files found`,
      agentsFiles.slice(0, 2000),
      `## Recent Git History`,
      gitLog.slice(0, 1500),
      `## package.json`,
      packageJson.slice(0, 1500),
      `## Project Path`,
      projectPath,
      "",
      `IMPLEMENT STORY #${task.id}: ${task.title}`,
      "Meet ALL acceptance criteria. Update prd.json. Update AGENTS.md. Update progress.txt. Commit.",
    ].join("\n"),
    noTask: false,
  };
}

function buildGenericPrompt() {
  const files = ["prd.json", "bugs.md", "ideas.md", "progress.txt", "package.json"].map(f => {
    const content = readFileSafe(f).slice(0, 2500);
    return `### ${f}\n\`\`\`\n${content || "(empty)"}\n\`\`\``;
  }).join("\n\n");

  const gitLog = (() => { try { return execSync("git log --oneline -15 2>/dev/null", { cwd: projectPath }).toString(); } catch { return ""; } })();

  return [
    agent.system,
    `## Project: ${projectPath}`,
    files,
    `## Git History`,
    gitLog.slice(0, 1500),
    taskSpecific ? `## Specific Task\n${taskSpecific}` : "",
    "\nWork until complete. Report results.",
  ].join("\n");
}

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  console.log(`${agent.name} | ${projectPath} | fresh session`);

  const ctx = agentType === "builder" ? buildBuilderPrompt() : { prompt: buildGenericPrompt(), noTask: false };
  if (ctx.noTask) { console.log("No task available. Skipping."); return; }

  const sessionId = await createFreshSession();
  if (!sessionId) { console.error("Cannot create session."); process.exit(1); }
  console.log(`Session: ${sessionId.slice(0, 8)}... | Prompt: ${ctx.prompt.length} chars`);

  const result = await api("POST", `/session/${sessionId}/message`, {
    body: { parts: [{ type: "text", text: ctx.prompt }] },
    directory: projectPath,
  });

  const reply = result?.parts?.map(p => p.text || "").join("\n").trim() || "No response";
  console.log(`--- RESULT (${reply.length} chars) ---`);
  console.log(reply.slice(0, 500));
  console.log("--- END ---");
  console.log("Completed");
}

main().catch(e => { console.error(`Error: ${e.message}`); process.exit(1); });
