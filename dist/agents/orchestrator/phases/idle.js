import { TierSelector } from '../../../src/core/tier-selector.js';
export async function handleIdle(context) {
    const { tasks, notion, stream, log, updateStatus, safety, projectPath, state, memory } = context;
    log(`[IDLE] Running IDLE phase...`);
    const currentState = state.get();
    const lastUpdate = currentState?.updatedAt ? new Date(currentState.updatedAt) : new Date();
    const now = new Date();
    if (lastUpdate.toDateString() !== now.toDateString()) {
        log(`[IDLE] New day detected. Resetting storiesCompletedToday count.`);
        state.transition('IDLE', { storiesCompletedToday: 0 });
    }
    if (memory && memory.needsCompaction()) {
        log(`[IDLE] Event stream needs compaction, rotating...`);
        try {
            const { AgentRuntime } = await import('../../runtime.js');
            const tierSelector = new TierSelector();
            const tier = tierSelector.select('IDLE');
            tierSelector.applyTierConfig(tier, projectPath);
            await memory.compact(() => new AgentRuntime({ projectPath, agentType: 'summarizer', safety, stream }));
            log(`[IDLE] Compaction completed successfully.`);
        }
        catch (e) {
            log(`[IDLE] Compaction failed: ${e.message}`);
        }
    }
    await tasks.loadTasks();
    const mode = tasks.getExecutionMode();
    const readyTasks = tasks.getReadyTasks(mode);
    const allTasks = tasks._tasks || [];
    const blocked = allTasks.filter((t) => t.status === 'blocked').length;
    const done = allTasks.filter((t) => t.passes).length;
    updateStatus({
        phase: 'IDLE',
        taskTitle: 'Waiting for tasks...',
        tasksCompleted: done,
        tasksBlocked: blocked,
        tasksTotal: allTasks.length,
    });
    if (readyTasks.length > 0) {
        log(`[IDLE] Found ${readyTasks.length} ready task(s). Transitioning to PLAN.`);
        stream.emit('System', 'system', {
            action: 'PhaseChange',
            phase: 'PLAN',
            stateUpdates: {
                readyTaskIds: readyTasks.map((t) => t.id),
                idleDiscoverCount: 0,
            },
        });
    }
    else {
        let count = currentState?.idleDiscoverCount || 0;
        if (currentState?.lastPhase === 'WAIT_HUMAN') {
            count = 0;
        }
        const newCount = count + 1;
        if (newCount >= 3) {
            log(`[IDLE] No ready tasks found after 3 consecutive attempts. Suspending loop to avoid infinite cycling.`);
            stream.emit('System', 'system', {
                action: 'PhaseChange',
                phase: 'WAIT_HUMAN',
                stateUpdates: {
                    idleDiscoverCount: 0,
                    humanGateReason: 'Loop suspended: No ready tasks found after 3 cycles.',
                },
            });
        }
        else {
            log(`[IDLE] No ready tasks found (Attempt ${newCount}/3). Transitioning to DISCOVER.`);
            stream.emit('System', 'system', {
                action: 'PhaseChange',
                phase: 'DISCOVER',
                stateUpdates: {
                    idleDiscoverCount: newCount,
                },
            });
        }
    }
}
