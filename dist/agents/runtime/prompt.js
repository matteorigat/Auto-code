import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { systemPrompts } from '../../src/prompts/system-prompts.js';
export function buildPrompt(projectPath, agentType, task, taskManager) {
    const progressPath = join(projectPath, 'progress.txt');
    const bugsPath = join(projectPath, 'bugs.md');
    const agentsGlob = join(projectPath, 'AGENTS.md');
    const ideasPath = join(projectPath, 'ideas.md');
    const read = (p, limit = 3000) => {
        try {
            return readFileSync(p, 'utf-8').slice(0, limit);
        }
        catch {
            return '';
        }
    };
    const progress = read(progressPath, 2500);
    const bugs = read(bugsPath, 1500);
    const agents = read(agentsGlob, 2000);
    // B7: Use the LOCAL project prd.json (task.workspacePath) for builder/task-planner/architect
    // so the agent sees only its project's stories, not all projects
    const localProjectPath = task?.workspacePath || projectPath;
    const localPrdManager = localProjectPath !== projectPath
        ? { readPRD: () => { try {
                return JSON.parse(readFileSync(join(localProjectPath, 'prd.json'), 'utf-8'));
            }
            catch {
                return taskManager.readPRD();
            } } }
        : taskManager;
    const prdRaw = JSON.stringify(localPrdManager.readPRD(), null, 2).slice(0, 4000);
    const system = systemPrompts[agentType] ||
        systemPrompts.builder;
    const ideas = agentType === 'project-planner' ? read(ideasPath, 4000) : '';
    // B8: Inject architect+reviewer technical plan if available (for builder agents)
    const taskId = task?.id;
    const reviewFilePath = taskId ? join(localProjectPath, '.hydra', `review-${taskId}.md`) : '';
    const reviewPlan = reviewFilePath ? read(reviewFilePath, 3000) : '';
    // F3: Resolve dynamic placeholders in system prompt
    let resolvedSystem = system
        .replace(/\{\{PROJECT_PATH\}\}/g, localProjectPath)
        .replace(/\{\{TASK_ID\}\}/g, taskId || '');
    const context = [
        `## System\n${resolvedSystem}`,
        `## Task\n${task?.title || 'No specific task'}`,
        task?.description
            ? `Description: ${task.description}`
            : '',
        task?.acceptanceCriteria?.length
            ? `Acceptance Criteria:\n${task.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}`
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
