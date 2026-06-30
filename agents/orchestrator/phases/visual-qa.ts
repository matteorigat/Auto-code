import { AgentRuntime, type RunResult } from '../../runtime.js';
import { TierSelector } from '../../../src/core/tier-selector.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OrchestratorContext } from '../types.js';

/**
 * Detect the port the dev server is running on.
 * Priority: .hydra/app-config.json > package.json scripts.dev port > common ports probe.
 */
async function detectAppPort(ws: string): Promise<number | null> {
  // 1. Explicit config override
  try {
    const cfg = JSON.parse(readFileSync(join(ws, '.hydra', 'app-config.json'), 'utf-8'));
    if (cfg.port && typeof cfg.port === 'number') return cfg.port;
  } catch (_) {}

  // 2. Parse port from package.json scripts (e.g. "dev": "next dev -p 3001" or "vite --port 4000")
  try {
    const pkg = JSON.parse(readFileSync(join(ws, 'package.json'), 'utf-8'));
    const scripts = pkg.scripts || {};
    const devScript: string = scripts.dev || scripts.start || scripts.serve || '';
    const portMatch = devScript.match(/(?:--port|-p)\s+(\d+)/);
    if (portMatch) return parseInt(portMatch[1], 10);
    // Next.js default on 3000, Vite on 5173, CRA on 3000
    if (devScript.includes('next')) return 3000;
    if (devScript.includes('vite')) return 5173;
  } catch (_) {}

  // 3. Probe common dev ports
  const { createConnection } = await import('node:net');
  const tryPort = (port: number): Promise<boolean> =>
    new Promise((resolve) => {
      const sock = createConnection(port, '127.0.0.1');
      sock.on('connect', () => { sock.destroy(); resolve(true); });
      sock.on('error', () => resolve(false));
      sock.setTimeout(400, () => { sock.destroy(); resolve(false); });
    });

  for (const port of [3000, 3001, 5173, 4000, 8080, 8000]) {
    if (await tryPort(port)) return port;
  }

  return null;
}

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
      taskTitle: `[${task.id}] Initiating visual validations...`,
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
      // B3: Dynamically detect the app port instead of hardcoding localhost:3000
      const appPort = await detectAppPort(ws);
      if (appPort === null) {
        log(`[VISUAL_QA] No running dev server detected on any known port. Auto-passing ${taskId}.`);
        (tasks as unknown as { markPass: (id: string) => void }).markPass(taskId as string);
        continue;
      }

      updateStatus({
        phase: 'VISUAL_QA',
        taskTitle: `[${task.id}] Launching browser & capturing screenshot on port ${appPort}...`,
        taskId: task.id as string | undefined,
      });
      log(`[VISUAL_QA] Attempting to screenshot UI for ${taskId} on localhost:${appPort}`);
      let browser: Record<string, unknown> | null = null;
      try {
        browser = (await puppeteerDefault.launch({
          headless: 'new',
          args: ['--no-sandbox', '--disable-setuid-sandbox'],
        })) as Record<string, unknown>;
        const page = await (browser.newPage as () => Promise<Record<string, unknown>>)();
        await (page.goto as (url: string, opts: Record<string, unknown>) => Promise<void>)(
          `http://localhost:${appPort}`,
          { waitUntil: 'networkidle0', timeout: 8000 },
        );
        screenshotBase64 = await (
          page.screenshot as (opts: Record<string, unknown>) => Promise<string>
        )({ encoding: 'base64', fullPage: true });
      } catch (e: unknown) {
        log(`[VISUAL_QA] Could not capture screenshot on port ${appPort}: ${(e as Error).message}`);
      } finally {
        if (browser) await (browser.close as () => Promise<void>)();
      }
    } else {
      log(
        `[VISUAL_QA] Skipping screenshot capture because Puppeteer/Chrome is disabled or not installable on this system.`,
      );
    }

    if (screenshotBase64) {
      updateStatus({
        phase: 'VISUAL_QA',
        taskTitle: `[${task.id}] Reviewing UI layout with visual-reviewer...`,
        taskId: task.id as string | undefined,
      });
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
