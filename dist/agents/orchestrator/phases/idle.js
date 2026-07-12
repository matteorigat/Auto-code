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
        // Check if everything is fully completed
        let allFinished = false;
        let hasUnplannedProjects = false;
        const unplannedReadyTaskIds = [];
        try {
            const currentPrd = tasks.readPRD();
            const projects = (currentPrd.projects || []);
            if (projects.length > 0) {
                const activeUncompleted = projects.filter((p) => !p.completed);
                // B2: Projects with 0 stories need to be planned — synthesize a planning task for them
                for (const p of activeUncompleted) {
                    const stories = p.stories || [];
                    if (stories.length === 0) {
                        // This project has never been planned — create a synthetic "plan this project" task
                        log(`[IDLE] Project "${p.slug || p.title}" has no stories yet — creating planning task.`);
                        const syntheticId = `PLAN-${(p.slug || p.title || 'project').replace(/[^a-z0-9]/gi, '-').toLowerCase()}-${Date.now().toString(36)}`;
                        const syntheticTask = {
                            id: syntheticId,
                            title: `Plan project: ${p.title || p.slug}`,
                            description: p.description || `Initialize SDD specifications and story backlog for project "${p.slug}".`,
                            acceptanceCriteria: ['PLAN.md exists', 'PRODUCT-SPEC.md exists', 'TECHNICAL-SPEC.md exists', 'CONSTITUTION.md exists', 'prd.json has at least 1 story'],
                            priority: 1,
                            status: 'idle',
                            passes: false,
                            _projectSlug: p.slug,
                            _projectTitle: p.title,
                        };
                        unplannedReadyTaskIds.push(syntheticId);
                        hasUnplannedProjects = true;
                        // Inject task into manager's task array so PLAN can find it
                        const tasksArr = tasks._tasks;
                        if (!tasksArr.find((t) => t.id === syntheticId)) {
                            tasksArr.push(syntheticTask);
                        }
                    }
                }
                if (!hasUnplannedProjects) {
                    const allStoriesCompleted = activeUncompleted.every((p) => {
                        const stories = p.stories || [];
                        return stories.length > 0 && stories.every((s) => s.passes || s.status === 'completed');
                    });
                    if (allStoriesCompleted && activeUncompleted.length > 0) {
                        log(`[IDLE] All active projects have all stories completed. Marking them as completed...`);
                        for (const p of activeUncompleted) {
                            p.completed = true;
                        }
                        tasks.writePRD(currentPrd);
                        allFinished = true;
                    }
                    else if (projects.every((p) => p.completed)) {
                        allFinished = true;
                    }
                }
            }
        }
        catch (_) { }
        if (hasUnplannedProjects) {
            log(`[IDLE] Found ${unplannedReadyTaskIds.length} unplanned project(s). Transitioning to PLAN.`);
            stream.emit('System', 'system', {
                action: 'PhaseChange',
                phase: 'PLAN',
                stateUpdates: {
                    readyTaskIds: unplannedReadyTaskIds,
                    idleDiscoverCount: 0,
                },
            });
            return;
        }
        if (allFinished) {
            log(`[IDLE] Every project in the loop backlog is completed. Transitioning to DONE and exiting loop.`);
            stream.emit('System', 'system', {
                action: 'PhaseChange',
                phase: 'DONE',
                stateUpdates: {
                    currentTaskId: null,
                    currentStory: null,
                    idleDiscoverCount: 0,
                },
            });
            setTimeout(() => process.exit(0), 1000);
            return;
        }
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
