import { AgentRuntime, type RunResult } from '../../runtime.js';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { TierSelector } from '../../../src/core/tier-selector.js';
import type { OrchestratorContext } from '../types.js';

export async function handleFix(context: OrchestratorContext): Promise<void> {
  const { stream, log, updateStatus, projectPath, state, safety, tasks } = context;

  log(`[FIX] Running FIX phase...`);
  const currentState = state.get() || ({} as Record<string, unknown>);
  const taskId = ((currentState as Record<string, string>).fixTaskId ||
    (currentState as Record<string, string>).currentTaskId) as string;
  const errorMsg = (currentState as Record<string, string>).previousError || 'Unknown error';
  const reflectionCount = (currentState as Record<string, number>).reflectionCount || 1;

  updateStatus({ lastError: errorMsg.slice(0, 200), phase: 'FIX', taskTitle: `Fixing ${taskId}` });

  if (reflectionCount > 3) {
    log(`[BREAKER] QA failed 3 times. Falling back to IDLE.`);
    (tasks as unknown as Record<string, (id: string, msg: string) => void>).markBlocked(
      taskId,
      'QA failed repeatedly after 3 reflections.',
    );
    stream.emit('System', 'system', {
      action: 'PhaseChange',
      phase: 'IDLE',
      stateUpdates: { reflectionCount: 0 },
    });
    return;
  }

  const tasksArr = (tasks as unknown as Record<string, Record<string, unknown>[]>)._tasks || [];
  const task = tasksArr.find((t: Record<string, unknown>) => String(t.id) === String(taskId));
  const ws = (task?.workspacePath as string) || projectPath;

  log(`[FIX] Running Patcher sub-agent for reflection #${reflectionCount}`);

  const tierSelector = new TierSelector();
  const tier = tierSelector.select('FIX');
  tierSelector.applyTierConfig(tier, ws);

  const patcher = new AgentRuntime({ projectPath: ws, agentType: 'patcher', stream, safety });
  patcher.task = { title: 'Fix QA Error', description: errorMsg };

  const res: RunResult = await patcher.run(120000);
  const content =
    res.content || (res.result as { info?: { content?: string } } | undefined)?.info?.content || '';

  const diffMatch = content.match(/```diff\n([\s\S]*?)```/);
  if (diffMatch && diffMatch[1]) {
    const patchContent = diffMatch[1];

    const { resolve, normalize } = await import('node:path');
    const lines = patchContent.split('\n');
    const resolvedWs = resolve(ws);
    for (const line of lines) {
      if (line.startsWith('--- ') || line.startsWith('+++ ')) {
        const filePartRaw = line.substring(4).split('\t')[0].trim();
        const parts = filePartRaw.split(/\s+/);
        const filePart = parts[0];
        if (filePart === '/dev/null') continue;
        const resolvedPath = resolve(
          ws,
          normalize(
            filePart.startsWith('a/') || filePart.startsWith('b/') ? filePart.slice(2) : filePart,
          ),
        );
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
    } catch (e: unknown) {
      log(`[FIX] Patch failed to apply: ${(e as Error).message}`);
    }
    try {
      unlinkSync(patchFile);
    } catch (e: unknown) {
      console.error('Ignored error:', (e as Error).message);
    }
  } else {
    log(`[FIX] No valid diff block found in Patcher response.`);
  }

  stream.emit('System', 'system', { action: 'PhaseChange', phase: 'QA' });
}
