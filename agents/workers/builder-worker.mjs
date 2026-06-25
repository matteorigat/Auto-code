import { AgentRuntime } from '../runtime.mjs';
import { Safety } from '../../src/core/safety.mjs';

process.on('message', async (msg) => {
  if (msg.type === 'START') {
    const { projectPath, task, safetyOptions } = msg;

    // Fake stream that forwards events to parent process
    const stream = {
      emit: (actor, source, payload) => {
        process.send({ type: 'EVENT', event: { actor, source, payload } });
      },
    };

    const safety = new Safety(projectPath);

    try {
      const runtime = new AgentRuntime({ projectPath, agentType: 'builder', task, safety, stream });

      runtime.on('thinking', () => process.send({ type: 'STATUS', phase: 'THINKING' }));
      runtime.on('toolCall', ({ tool, title }) =>
        process.send({ type: 'STATUS', phase: `TOOL:${tool}` }),
      );

      const result = await runtime.run(safetyOptions?.maxCycleMs || 900000);
      process.send({
        type: 'DONE',
        result: { ok: result.ok, error: result.error, info: result.result?.info },
      });
    } catch (e) {
      process.send({ type: 'DONE', result: { ok: false, error: e.message } });
    }
  }
});
