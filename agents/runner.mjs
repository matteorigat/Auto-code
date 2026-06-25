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

import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { systemPrompts } from '../src/prompts/system-prompts.mjs';
import { TaskManager } from '../src/core/task-manager.mjs';

const OC_URL = 'http://127.0.0.1:4096';
const [, , projectPath, agentType, ...taskArgs] = process.argv;
const taskSpecific = taskArgs.join(' ') || '';

if (!projectPath || !agentType) {
  console.error('Usage: node agents/runner.mjs <project-path> <agent-type> [specific-task]');
  process.exit(1);
}

const tasks = new TaskManager({ projectPath });

const agentSystem = systemPrompts[agentType];
if (!agentSystem) {
  console.error(`Unknown agent: ${agentType}. Available: ${Object.keys(systemPrompts).join(', ')}`);
  process.exit(1);
}

const agentName = agentType.charAt(0).toUpperCase() + agentType.slice(1);
const agent = { name: agentName, system: agentSystem };

// ── Helpers ───────────────────────────────────────────────────────

async function api(method, path, opts = {}) {
  const url = `${OC_URL}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-opencode-directory': projectPath,
      ...opts.headers,
    },
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
    throw new Error('Path traversal attempt blocked');
  }
  return resolved;
}

function readFileSafe(file) {
  try {
    return readFileSync(resolveSafePath(file), 'utf-8');
  } catch {
    return '';
  }
}

// Init shared files with Ralph-compatible structure
const defaultPRD = JSON.stringify(
  {
    stories: [],
    progress: '',
    codebasePatterns: '',
  },
  null,
  2,
);

ensureExists('prd.json', defaultPRD);
ensureExists('bugs.md', '# Bugs\n\n');
ensureExists('ideas.md', '# Ideas\n\n');
ensureExists(
  'progress.txt',
  '# Progress Log\n\n## Codebase Patterns\n(Add reusable patterns here)\n\n---\n\n## Chronological Log\n\n',
);

// ── Fresh Session ─────────────────────────────────────────────────

async function createFreshSession() {
  const title = `${agent.name} - ${new Date().toISOString()} - run-${Date.now().toString(36)}`;
  try {
    const session = await api('POST', '/session', { body: { title }, directory: projectPath });
    return session.id;
  } catch {
    return null;
  }
}

// ── Build Prompt ──────────────────────────────────────────────────

function buildBuilderPrompt() {
  const prdJson = tasks.readPRD();

  // Find task
  let task = null;
  if (taskSpecific) {
    task =
      prdJson.stories?.find((s) => s.title?.toLowerCase().includes(taskSpecific.toLowerCase())) ||
      null;
  }
  if (!task) task = prdJson.stories?.find((s) => !s.passes) || null;
  if (!task) return { prompt: 'No pending tasks.', noTask: true };

  // Gather context
  const progress = readFileSafe('progress.txt');
  const bugs = readFileSafe('bugs.md').slice(0, 2000);
  const gitLog = (() => {
    try {
      return execFileSync('git', ['log', '--oneline', '-15'], {
        cwd: projectPath,
        encoding: 'utf-8',
      });
    } catch {
      return '';
    }
  })();
  const packageJson = readFileSafe('package.json').slice(0, 2000);
  const agentsFiles = (() => {
    try {
      const found = execFileSync('find', [projectPath, '-name', 'AGENTS.md', '-maxdepth', '3'], {
        cwd: projectPath,
        encoding: 'utf-8',
      }).trim();
      if (!found) return '';
      return found
        .split('\n')
        .map((f) => {
          try {
            const relPath = f.replace(projectPath + '/', '');
            return `\n### ${relPath}\n${readFileSafe(relPath)}`;
          } catch {
            return '';
          }
        })
        .join('\n')
        .slice(0, 3000);
    } catch {
      return '';
    }
  })();

  return {
    prompt: [
      agent.system,
      '',
      `## Task #${task.id}: ${task.title}`,
      task.description ? `Description: ${task.description}` : '',
      task.acceptanceCriteria
        ? `\nAcceptance Criteria:\n${task.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}`
        : '',
      '',
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
      '',
      `IMPLEMENT STORY #${task.id}: ${task.title}`,
      'Meet ALL acceptance criteria. Update prd.json. Update AGENTS.md. Update progress.txt. Commit.',
    ].join('\n'),
    noTask: false,
  };
}

function buildGenericPrompt() {
  const prdRaw = JSON.stringify(tasks.readPRD(), null, 2);
  const files = ['bugs.md', 'ideas.md', 'progress.txt', 'package.json']
    .map((f) => {
      const content = readFileSafe(f).slice(0, 2500);
      return `### ${f}\n\`\`\`\n${content || '(empty)'}\n\`\`\``;
    })
    .join('\n\n');

  const allFiles = `### prd.json\n\`\`\`\n${prdRaw.slice(0, 2500)}\n\`\`\`\n\n${files}`;

  const gitLog = (() => {
    try {
      return execFileSync('git', ['log', '--oneline', '-15'], {
        cwd: projectPath,
        encoding: 'utf-8',
      });
    } catch {
      return '';
    }
  })();

  return [
    agent.system,
    `## Project: ${projectPath}`,
    allFiles,
    `## Git History`,
    gitLog.slice(0, 1500),
    taskSpecific ? `## Specific Task\n${taskSpecific}` : '',
    '\nWork until complete. Report results.',
  ].join('\n');
}

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  console.log(`${agent.name} | ${projectPath} | fresh session`);

  const ctx =
    agentType === 'builder'
      ? buildBuilderPrompt()
      : { prompt: buildGenericPrompt(), noTask: false };
  if (ctx.noTask) {
    console.log('No task available. Skipping.');
    return;
  }

  const sessionId = await createFreshSession();
  if (!sessionId) {
    console.error('Cannot create session.');
    process.exit(1);
  }
  console.log(`Session: ${sessionId.slice(0, 8)}... | Prompt: ${ctx.prompt.length} chars`);

  const result = await api('POST', `/session/${sessionId}/message`, {
    body: { parts: [{ type: 'text', text: ctx.prompt }] },
    directory: projectPath,
  });

  const reply =
    result?.parts
      ?.map((p) => p.text || '')
      .join('\n')
      .trim() || 'No response';
  console.log(`--- RESULT (${reply.length} chars) ---`);
  console.log(reply.slice(0, 500));
  console.log('--- END ---');
  console.log('Completed');
}

main().catch((e) => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
