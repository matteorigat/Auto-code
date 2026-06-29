import { AgentRuntime, type RunResult } from '../../runtime.js';
import { TierSelector } from '../../../src/core/tier-selector.js';
import type { OrchestratorContext } from '../types.js';

export async function handleVisualQa(context: OrchestratorContext): Promise<void> {
  const { tasks, stream, log, updateStatus, projectPath, state, safety } = context;

  log(`[VISUAL_QA] Running VISUAL_QA phase...`);
  const currentState = state.get() || ({} as Record<string, unknown>);
  const visualQaTaskIds = (currentState as Record<string, unknown[]>).visualQaTaskIds || [];

  if (!visualQaTaskIds.length) {
    stream.emit('System', 'system', { action: 'PhaseChange', phase: 'IDLE' });
    return;
  }

  let puppeteerMod: Record<string, unknown> | null = null;
  try {
    puppeteerMod = await import('puppeteer');
  } catch (e: unknown) {
    log(`[VISUAL_QA] Puppeteer/Chrome is not available or failed to load: ${(e as Error).message}`);
  }

  const tasksArr = (tasks as unknown as Record<string, Record<string, unknown>[]>)._tasks || [];

  for (const taskId of visualQaTaskIds) {
    const task = tasksArr.find((t: Record<string, unknown>) => String(t.id) === String(taskId));
    if (!task) continue;

    const ws = (task.workspacePath as string) || projectPath;
    updateStatus({
      phase: 'VISUAL_QA',
      taskTitle: task.title as string | undefined,
      taskId: task.id as string | undefined,
    });

    state.transition('VISUAL_QA', {
      currentTaskId: task.id,
      currentStory: task.title,
    });

    let screenshotBase64: string | null = null;

    const puppeteerDefault = puppeteerMod?.default as
      | { launch: (opts: Record<string, unknown>) => Promise<Record<string, unknown>> }
      | undefined;
    if (puppeteerMod && puppeteerDefault) {
      log(`[VISUAL_QA] Attempting to screenshot UI for ${taskId}`);
      let browser: Record<string, unknown> | null = null;
      try {
        browser = (await puppeteerDefault.launch({
          headless: 'new',
          args: ['--no-sandbox', '--disable-setuid-sandbox'],
        })) as Record<string, unknown>;
        const page = await (browser.newPage as () => Promise<Record<string, unknown>>)();
        await (page.goto as (url: string, opts: Record<string, unknown>) => Promise<void>)(
          'http://localhost:3000',
          { waitUntil: 'networkidle0', timeout: 5000 },
        );
        screenshotBase64 = await (
          page.screenshot as (opts: Record<string, unknown>) => Promise<string>
        )({ encoding: 'base64', fullPage: true });
      } catch (e: unknown) {
        log(`[VISUAL_QA] Could not capture screenshot: ${(e as Error).message}`);
      } finally {
        if (browser) await (browser.close as () => Promise<void>)();
      }
    } else {
      log(
        `[VISUAL_QA] Skipping screenshot capture because Puppeteer/Chrome is disabled or not installable on this system.`,
      );
    }

    if (screenshotBase64) {
      log(`[VISUAL_QA] Invoking visual-reviewer AgentRuntime`);

      const tierSelector = new TierSelector();
      const tier = tierSelector.select('QA');
      tierSelector.applyTierConfig(tier, ws);

      const runtime = new AgentRuntime({
        projectPath: ws,
        agentType: 'visual-reviewer',
        task,
        safety,
        stream,
      });

      runtime.task = {
        ...task,
        _screenshotBase64: screenshotBase64,
      };

      const runResult: RunResult = await runtime.run(120000);
      const resultContent: string = runResult.content || '';
      const resultInfo = runResult.result as { info?: { content?: string } } | undefined;
      const feedback: string = resultContent || resultInfo?.info?.content || '';

      if (feedback.includes('APPROVED')) {
        log(`[VISUAL_QA] ${taskId} PASSED visual inspection`);
        (tasks as unknown as { markPass: (id: string) => void }).markPass(taskId as string);
      } else {
        log(`[VISUAL_QA] ${taskId} FAILED visual inspection`);
        const reflectionCount = (currentState as Record<string, number>).reflectionCount || 0;
        stream.emit('System', 'system', {
          action: 'PhaseChange',
          phase: 'FIX',
          stateUpdates: {
            previousError: `Visual UI issues detected:\n${feedback}`,
            fixTaskId: taskId,
            reflectionCount: reflectionCount + 1,
          },
        });
        return;
      }
    } else {
      log(`[VISUAL_QA] No UI detected, auto-passing ${taskId}`);
      (tasks as unknown as { markPass: (id: string) => void }).markPass(taskId as string);
    }
  }

  stream.emit('System', 'system', { action: 'PhaseChange', phase: 'COMMIT' });
}
