import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { systemPrompts } from '../../src/prompts/system-prompts.js';
export function buildPrompt(projectPath, agentType, task, taskManager) {
    const progressPath = join(projectPath, 'progress.txt');
    const bugsPath = join(projectPath, 'bugs.md');
    const agentsGlob = join(projectPath, 'AGENTS.md');
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
    const prdRaw = JSON.stringify(taskManager.readPRD(), null, 2).slice(0, 4000);
    const agents = read(agentsGlob, 2000);
    const system = systemPrompts[agentType] ||
        systemPrompts.builder;
    const context = [
        `## System\n${system}`,
        `## Task\n${task?.title || 'No specific task'}`,
        task?.description
            ? `Description: ${task.description}`
            : '',
        task?.acceptanceCriteria?.length
            ? `Acceptance Criteria:\n${task.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}`
            : '',
        `## progress.txt (top)\n${progress}`,
        `## bugs.md\n${bugs}`,
        `## AGENTS.md\n${agents}`,
        `## prd.json (excerpt)\n${prdRaw.slice(0, 2000)}`,
        `## Project Path\n${projectPath}`,
        `\nBegin work now. Be minimal. Be correct.`,
    ]
        .filter(Boolean)
        .join('\n\n');
    return context;
}
