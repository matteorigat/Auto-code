import { AgentRuntime } from '../../runtime.mjs';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { TierSelector } from '../../../src/core/tier-selector.mjs';

export async function handleFix(context) {
  const { stream, log, updateStatus, projectPath, state, safety, tasks } = context;

  log(`[FIX] Running FIX phase...`);
  const currentState = state.get();
  const taskId = currentState.fixTaskId || currentState.currentTaskId;
  const errorMsg = currentState.previousError || 'Unknown error';
  const reflectionCount = currentState.reflectionCount || 1;

  updateStatus({ lastError: errorMsg.slice(0, 200), phase: 'FIX', taskTitle: `Fixing ${taskId}` });

  // 4.5 Breaker logic
  if (reflectionCount > 3) {
    log(`[BREAKER] QA failed 3 times. Falling back to IDLE.`);
    tasks.markBlocked(taskId, 'QA failed repeatedly after 3 reflections.');
    stream.emit('System', 'system', {
      action: 'PhaseChange',
      phase: 'IDLE',
      stateUpdates: { reflectionCount: 0 },
    });
    return;
  }

  const task = tasks._tasks.find((t) => String(t.id) === String(taskId));
  const ws = task?.workspacePath || projectPath;

  // 4.3 Patcher Sub-Agent
  log(`[FIX] Running Patcher sub-agent for reflection #${reflectionCount}`);

  const tierSelector = new TierSelector();
  const tier = tierSelector.select('FIX');
  tierSelector.applyTierConfig(tier, ws);

  const patcher = new AgentRuntime({ projectPath: ws, agentType: 'patcher', stream, safety });
  patcher.task = { title: 'Fix QA Error', description: errorMsg };

  const res = await patcher.run(120000); // 2 mins timeout
  const content = res.content || res.result?.info?.content || '';

  // 4.4 Apply Unified Diff Patch
  const diffMatch = content.match(/```diff\n([\s\S]*?)```/);
  if (diffMatch && diffMatch[1]) {
    const patchContent = diffMatch[1];

    // Path traversal check
    const { resolve, normalize } = await import('node:path');
    const lines = patchContent.split('\n');
    const resolvedWs = resolve(ws);
    for (const line of lines) {
      if (line.startsWith('--- ') || line.startsWith('+++ ')) {
        const filePartRaw = line.substring(4).split('\t')[0].trim();
        const parts = filePartRaw.split(/\s+/);
        let filePart = parts[0];
        if (filePart === '/dev/null') continue;
        if (filePart.startsWith('a/') || filePart.startsWith('b/')) {
          filePart = filePart.slice(2);
        }
        const resolvedPath = resolve(ws, normalize(filePart));
        if (!resolvedPath.startsWith(resolvedWs)) {
          log(
            `[FIX] SECURITY WARNING: Patch contains path traversal attempt to ${filePart}. Aborting.`,
          );
          stream.emit('System', 'system', {
            action: 'PhaseChange',
            phase: 'IDLE',
            stateUpdates: { previousError: 'Path traversal detected in patch' },
          });
          return;
        }
      }
    }

    log(`[FIX] Applying generated patch...`);
    const patchFile = join(ws, '.hydra-temp.patch');
    writeFileSync(patchFile, patchContent);

    try {
      await safety.runSafeCommand(taskId, 'patch -p1 < .hydra-temp.patch', ws);
      log(`[FIX] Patch applied successfully.`);
    } catch (e) {
      log(`[FIX] Patch failed to apply: ${e.message}`);
    }
    try {
      unlinkSync(patchFile);
    } catch (e) {
      console.error('Ignored error:', e.message);
    }
  } else {
    log(`[FIX] No valid diff block found in Patcher response.`);
  }

  // After attempting to patch, return to QA
  stream.emit('System', 'system', { action: 'PhaseChange', phase: 'QA' });
}
