import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { systemPrompts } from '../../src/prompts/system-prompts.js';

export function buildPrompt(
  projectPath: string,
  agentType: string,
  task: Record<string, unknown> | null,
  taskManager: { readPRD: () => Record<string, unknown> },
): string {
  const progressPath = join(projectPath, 'progress.txt');
  const bugsPath = join(projectPath, 'bugs.md');
  const agentsGlob = join(projectPath, 'AGENTS.md');
  const ideasPath = join(projectPath, 'ideas.md');

  const read = (p: string, limit = 3000): string => {
    try {
      return readFileSync(p, 'utf-8').slice(0, limit);
    } catch {
      return '';
    }
  };

  const progress = read(progressPath, 2500);
  const bugs = read(bugsPath, 1500);
  const agents = read(agentsGlob, 2000);

  // B7: Use the LOCAL project prd.json (task.workspacePath) for builder/task-planner/architect
  // so the agent sees only its project's stories, not all projects
  const localProjectPath =
    (task as Record<string, string> | null)?.workspacePath || projectPath;
  const localPrdManager =
    localProjectPath !== projectPath
      ? { readPRD: () => { try { return JSON.parse(readFileSync(join(localProjectPath, 'prd.json'), 'utf-8')); } catch { return taskManager.readPRD(); } } }
      : taskManager;

  const prdRaw = JSON.stringify(localPrdManager.readPRD(), null, 2).slice(0, 4000);

  const system =
    (systemPrompts as Record<string, string>)[agentType] ||
    (systemPrompts as Record<string, string>).builder;

  const ideas = agentType === 'project-planner' ? read(ideasPath, 4000) : '';

  // B8: Inject architect+reviewer technical plan if available (for builder agents)
  const taskId = (task as Record<string, string> | null)?.id;
  const reviewFilePath = taskId ? join(localProjectPath, '.hydra', `review-${taskId}.md`) : '';
  const reviewPlan = reviewFilePath ? read(reviewFilePath, 3000) : '';

  // F3: Resolve dynamic placeholders in system prompt
  let resolvedSystem = system
    .replace(/\{\{PROJECT_PATH\}\}/g, localProjectPath)
    .replace(/\{\{TASK_ID\}\}/g, taskId || '');

  const context = [
    `## System\n${resolvedSystem}`,
    `## Task\n${(task as Record<string, string>)?.title || 'No specific task'}`,
    (task as Record<string, string>)?.description
      ? `Description: ${(task as Record<string, string>).description}`
      : '',
    (task as Record<string, string[]>)?.acceptanceCriteria?.length
      ? `Acceptance Criteria:\n${(task as Record<string, string[]>).acceptanceCriteria.map((c: string, i: number) => `${i + 1}. ${c}`).join('\n')}`
      : '',
    ideas ? `## ideas.md (Project Brief)\n${ideas}` : '',
    reviewPlan ? `## Technical Plan (Architect + Reviewer)\n${reviewPlan}` : '',
    `## progress.txt (top)\n${progress}`,
    `## bugs.md\n${bugs}`,
    `## AGENTS.md\n${agents}`,
    `## prd.json (project backlog)\n${prdRaw.slice(0, 2000)}`,
    `## Project Path\n${localProjectPath}`,
    `\nBegin work now. Build production-quality software.`,
  ]
    .filter(Boolean)
    .join('\n\n');

  return context;
}
