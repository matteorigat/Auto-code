import { QualityGate } from '../../../src/core/quality-gate.js';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
export async function handleQa(context) {
    const { tasks, stream, log, updateStatus, projectPath, state } = context;
    log(`[QA] Running QA phase...`);
    const currentState = state.get() || {};
    const qaTaskIds = currentState.qaTaskIds || [];
    const tasksArr = tasks._tasks || [];
    if (!qaTaskIds.length) {
        stream.emit('System', 'system', { action: 'PhaseChange', phase: 'IDLE' });
        return;
    }
    const gate = new QualityGate(projectPath);
    for (const taskId of qaTaskIds) {
        const task = tasksArr.find((t) => String(t.id) === String(taskId));
        if (!task)
            continue;
        const ws = task.workspacePath || projectPath;
        updateStatus({ phase: 'QA', taskTitle: `[${task.id}] Preparing QA validations...`, taskId: task.id });
        state.transition('QA', {
            currentTaskId: task.id,
            currentStory: task.title,
        });
        const consensusPath = join(ws, '.hydra', 'swarm-consensus.md');
        try {
            if (existsSync(consensusPath)) {
                unlinkSync(consensusPath);
                log(`[QA] Cleaned up swarm-consensus.md in ${ws}`);
            }
        }
        catch (e) {
            log(`[QA] Failed to clean up swarm-consensus.md: ${e.message}`);
        }
        updateStatus({ phase: 'QA', taskTitle: `[${task.id}] Running static analysis & tests inside Docker sandbox...`, taskId: task.id });
        log(`[QA] Running gates for ${taskId} inside Docker sandbox`);
        const qa = await gate.run({ cwd: ws, taskId: task.id });
        if (qa.passed) {
            log(`[QA] ${taskId} PASSED`);
        }
        else {
            log(`[QA] ${taskId} FAILED`);
            // F2: Reject LLM self-certification — reset passes=false if builder set it prematurely.
            // The QA gate is the authoritative source of truth, not the LLM.
            if (task.passes === true) {
                task.passes = false;
                log(`[QA] F2: Reset passes=false for ${taskId} — QA failed, LLM self-cert rejected.`);
            }
            const reflectionCount = currentState.reflectionCount || 0;
            stream.emit('System', 'system', {
                action: 'PhaseChange',
                phase: 'FIX',
                stateUpdates: {
                    previousError: qa.results
                        .filter((r) => !r.passed)
                        .map((r) => `[${r.name}]\n${r.output}`)
                        .join('\n---\n'),
                    fixTaskId: taskId,
                    reflectionCount: reflectionCount + 1,
                },
            });
            return;
        }
    }
    stream.emit('System', 'system', {
        action: 'PhaseChange',
        phase: 'VISUAL_QA',
        stateUpdates: { visualQaTaskIds: qaTaskIds },
    });
}
