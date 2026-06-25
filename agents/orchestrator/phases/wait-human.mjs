import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export async function handleWaitHuman(context) {
  const { state, projectPath, log, stream } = context;
  const signalPath = join(projectPath, '.hydra', 'resume-signal.json');

  log(`[WAIT_HUMAN] Entered WAIT_HUMAN phase. Waiting for resume-signal.json...`);

  const checkSignal = () => {
    if (existsSync(signalPath)) {
      log(`[WAIT_HUMAN] Resume signal file detected!`);
      try {
        const content = JSON.parse(readFileSync(signalPath, 'utf-8'));
        log(`[WAIT_HUMAN] Signal details: ${JSON.stringify(content)}`);
      } catch (e) {
        log(`[WAIT_HUMAN] Error reading/parsing resume signal: ${e.message}`);
      }

      try {
        unlinkSync(signalPath);
        log(`[WAIT_HUMAN] Deleted resume signal file.`);
      } catch (e) {
        log(`[WAIT_HUMAN] Warning: could not delete resume signal file: ${e.message}`);
      }

      // Resume by transitioning back to the last phase or IDLE
      const checkpoint = state.get();
      const nextPhase =
        checkpoint.lastPhase && checkpoint.lastPhase !== 'WAIT_HUMAN'
          ? checkpoint.lastPhase
          : 'IDLE';
      log(`[WAIT_HUMAN] Resuming and transitioning back to phase: ${nextPhase}`);
      stream.emit('System', 'system', { action: 'PhaseChange', phase: nextPhase });
      return true;
    }
    return false;
  };

  // Check immediately
  if (checkSignal()) return;

  // Poll every 3 seconds while in WAIT_HUMAN phase
  const pollInterval = setInterval(() => {
    const currentState = state.get();
    if (currentState.phase !== 'WAIT_HUMAN') {
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
