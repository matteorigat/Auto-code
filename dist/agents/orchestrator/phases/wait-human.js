import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
export async function handleWaitHuman(context) {
    const { state, projectPath, log, stream, updateStatus } = context;
    const signalPath = join(projectPath, '.hydra', 'resume-signal.json');
    const currentState = state.get();
    const reason = currentState?.humanGateReason || 'Loop paused — waiting for operator input.';
    log(`[WAIT_HUMAN] Entered WAIT_HUMAN phase. Reason: ${reason}`);
    updateStatus({ phase: 'WAIT_HUMAN', taskTitle: `Paused: ${reason.slice(0, 80)}` });
    const checkSignal = () => {
        if (existsSync(signalPath)) {
            log(`[WAIT_HUMAN] Resume signal file detected!`);
            let signalData = {};
            try {
                signalData = JSON.parse(readFileSync(signalPath, 'utf-8'));
                log(`[WAIT_HUMAN] Signal details: ${JSON.stringify(signalData)}`);
            }
            catch (e) {
                log(`[WAIT_HUMAN] Error reading/parsing resume signal: ${e instanceof Error ? e.message : String(e)}`);
            }
            try {
                unlinkSync(signalPath);
                log(`[WAIT_HUMAN] Deleted resume signal file.`);
            }
            catch (e) {
                log(`[WAIT_HUMAN] Warning: could not delete resume signal file: ${e instanceof Error ? e.message : String(e)}`);
            }
            // B9: Determine the correct next phase:
            // - If there's an explicit resumeTarget in state, use it
            // - If paused due to circuit breaker (lastPhase === 'IDLE'), go to DISCOVER with reset
            // - Otherwise, go back to lastPhase or IDLE
            const explicitTarget = signalData?.nextPhase || currentState?.resumeTarget;
            const lastPhase = currentState?.lastPhase;
            let nextPhase;
            if (explicitTarget && explicitTarget !== 'WAIT_HUMAN') {
                nextPhase = explicitTarget;
                log(`[WAIT_HUMAN] Using explicit resume target: ${nextPhase}`);
            }
            else if (lastPhase === 'IDLE' || !lastPhase || lastPhase === 'WAIT_HUMAN') {
                // Circuit breaker or fresh start — reset idle count and go to DISCOVER
                nextPhase = 'DISCOVER';
                state.transition('WAIT_HUMAN', { idleDiscoverCount: 0, resumeTarget: null });
                log(`[WAIT_HUMAN] Circuit breaker resume — transitioning to DISCOVER with fresh count.`);
            }
            else {
                nextPhase = lastPhase;
                log(`[WAIT_HUMAN] Resuming from last phase: ${nextPhase}`);
            }
            stream.emit('System', 'system', {
                action: 'PhaseChange',
                phase: nextPhase,
                stateUpdates: { humanGateReason: null, resumeTarget: null },
            });
            return true;
        }
        return false;
    };
    if (checkSignal())
        return;
    const pollInterval = setInterval(() => {
        const currentPhase = state.get()?.phase;
        if (currentPhase !== 'WAIT_HUMAN') {
            clearInterval(pollInterval);
            return;
        }
        if (checkSignal()) {
            clearInterval(pollInterval);
        }
    }, 3000);
    const cleanup = () => clearInterval(pollInterval);
    process.once('beforeExit', cleanup);
}
