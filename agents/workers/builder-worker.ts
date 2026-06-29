import { AgentRuntime, type RunResult } from '../runtime.js';
import { Safety } from '../../src/core/safety.js';

interface StartMessage {
  type: 'START';
  projectPath: string;
  task: Record<string, unknown>;
  safetyOptions?: { maxCycleMs?: number };
}

process.on('message', async (msg: StartMessage) => {
  if (msg.type === 'START') {
    const { projectPath, task, safetyOptions } = msg;

    const stream = {
      emit: (actor: string, source: string, payload: Record<string, unknown>) => {
        process.send?.({ type: 'EVENT', event: { actor, source, payload } });
      },
    };

    const safety = new Safety(projectPath);

    try {
      const runtime = new AgentRuntime({ projectPath, agentType: 'builder', task, safety, stream });

      runtime.on('thinking', () => process.send?.({ type: 'STATUS', phase: 'THINKING' }));
      runtime.on('toolCall', ({ tool }: { tool: string }) =>
        process.send?.({ type: 'STATUS', phase: `TOOL:${tool}` }),
      );

      const result: RunResult = await runtime.run(safetyOptions?.maxCycleMs || 900000);
      process.send?.({
        type: 'DONE',
        result: {
          ok: result.ok,
          error: result.error,
          info: (result.result as { info?: unknown } | undefined)?.info,
        },
      });
    } catch (e: unknown) {
      process.send?.({ type: 'DONE', result: { ok: false, error: (e as Error).message } });
    }
  }
});
