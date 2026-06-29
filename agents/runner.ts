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
 *   node agents/runner.js <project-path> <agent-type> [task-specific]
 *
 *   agent-type: "builder" | "bug-hunter" | "innovator" | "orchestrator"
 */

import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { systemPrompts } from '../src/prompts/system-prompts.js';
import { TaskManager } from '../src/core/task-manager.js';

interface ApiOptions {
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  directory?: string;
}

interface SessionResponse {
  id?: string;
}

interface MessageResponse {
  parts?: { text?: string; type?: string }[];
  info?: Record<string, unknown>;
}

interface BuilderPromptResult {
  prompt: string;
  noTask: boolean;
}

interface TaskResult {
  id: string | number;
  title?: string;
  description?: string;
  acceptanceCriteria?: string[];
  passes?: boolean;
  [key: string]: unknown;
}

interface PrdJson {
  stories?: TaskResult[];
  progress?: string;
  codebasePatterns?: string;
  projects?: {
    slug?: string;
    title?: string;
    description?: string;
    completed?: boolean;
    stories?: TaskResult[];
  }[];
  crossProjectStories?: TaskResult[];
  [key: string]: unknown;
}

const OC_URL = 'http://127.0.0.1:4096';
const [, , projectPath, agentType, ...taskArgs] = process.argv;
const taskSpecific = taskArgs.join(' ') || '';

if (!projectPath || !agentType) {
  console.error('Usage: node agents/runner.js <project-path> <agent-type> [specific-task]');
  process.exit(1);
}

const tasks = new TaskManager({ projectPath });

const agentSystem = (systemPrompts as Record<string, string>)[agentType];
if (!agentSystem) {
  console.error(`Unknown agent: ${agentType}. Available: ${Object.keys(systemPrompts).join(', ')}`);
  process.exit(1);
}

const agentName = agentType.charAt(0).toUpperCase() + agentType.slice(1);
const agent = { name: agentName, system: agentSystem };

async function api(
  method: string,
  path: string,
  opts: ApiOptions = {},
): Promise<Record<string, unknown>> {
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
  return res.json() as Promise<Record<string, unknown>>;
}

function ensureExists(file: string, content: string): void {
  const fp = resolveSafePath(file);
  if (!existsSync(fp)) writeFileSync(fp, content);
}

function resolveSafePath(file: string): string {
  const fullPath = join(projectPath, file);
  const resolved = fullPath.startsWith(projectPath) ? fullPath : null;
  if (!resolved || !resolved.startsWith(projectPath)) {
    throw new Error('Path traversal attempt blocked');
  }
  return resolved;
}

function readFileSafe(file: string): string {
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

async function createFreshSession(): Promise<string | null> {
  const title = `${agent.name} - ${new Date().toISOString()} - run-${Date.now().toString(36)}`;
  try {
    const session = (await api('POST', '/session', {
      body: { title },
      directory: projectPath,
    })) as SessionResponse;
    return session.id || null;
  } catch {
    return null;
  }
}

function buildBuilderPrompt(): BuilderPromptResult {
  const prdJson = tasks.readPRD() as unknown as PrdJson;

  let task: TaskResult | null = null;
  if (taskSpecific) {
    task =
      prdJson.stories?.find((s: TaskResult) =>
        s.title?.toLowerCase().includes(taskSpecific.toLowerCase()),
      ) || null;
  }
  if (!task) task = prdJson.stories?.find((s: TaskResult) => !s.passes) || null;
  if (!task) return { prompt: 'No pending tasks.', noTask: true };

  const progress = readFileSafe('progress.txt');
  const bugs = readFileSafe('bugs.md').slice(0, 2000);
  const gitLog = (() => {
    try {
      return execFileSync('git', ['log', '--oneline', '-15'], {
        cwd: projectPath,
        encoding: 'utf-8',
      }) as string;
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
      })
        .toString()
        .trim();
      if (!found) return '';
      return found
        .split('\n')
        .map((f: string) => {
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
        ? `\nAcceptance Criteria:\n${task.acceptanceCriteria.map((c: string, i: number) => `${i + 1}. ${c}`).join('\n')}`
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

function buildGenericPrompt(): string {
  const prdRaw = JSON.stringify(tasks.readPRD(), null, 2);
  const files = ['bugs.md', 'ideas.md', 'progress.txt', 'package.json']
    .map((f: string) => {
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
      }) as string;
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

async function main(): Promise<void> {
  console.log(`${agent.name} | ${projectPath} | fresh session`);

  const ctx: BuilderPromptResult =
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

  const result = (await api('POST', `/session/${sessionId}/message`, {
    body: { parts: [{ type: 'text', text: ctx.prompt }] },
    directory: projectPath,
  })) as MessageResponse;

  const reply =
    result?.parts
      ?.map((p: { text?: string }) => p.text || '')
      .join('\n')
      .trim() || 'No response';
  console.log(`--- RESULT (${reply.length} chars) ---`);
  console.log(reply.slice(0, 500));
  console.log('--- END ---');
  console.log('Completed');
}

main().catch((e: Error) => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
