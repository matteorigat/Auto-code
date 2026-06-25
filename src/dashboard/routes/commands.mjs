import { Router } from 'express';
import { existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

export function createCommandsRouter({ systemController, telemetryStore, config }) {
  const router = Router();
  const HYDRA_DIR = join(process.cwd(), '.hydra');

  router.post('/bridge-cmd', async (req, res, next) => {
    try {
      const { cmd, projectKey } = req.body;
      if (!cmd) return res.status(400).json({ error: 'cmd required' });

      if (!systemController || !systemController.loopManager) {
        return res
          .status(503)
          .json({ error: 'Loop manager is not integrated in this server process' });
      }

      const loopManager = systemController.loopManager;

      if (cmd === 'kill') {
        loopManager.shouldBeRunning = false;
        if (loopManager.childProc) {
          loopManager.childProc.kill('SIGTERM');
          telemetryStore.ingest({
            type: 'log',
            level: 'warn',
            source: 'dashboard',
            message: 'Loop Orchestrator termination requested',
          });
          return res.json({ status: 'stopping' });
        }
        return res.json({ status: 'stopped' });
      }

      if (cmd === 'pause') {
        loopManager.sendCommand('pause');
        telemetryStore.ingest({
          type: 'log',
          level: 'info',
          source: 'dashboard',
          message: 'Loop Orchestrator pause command sent',
        });
        return res.json({ status: 'pausing' });
      }

      if (cmd === 'resume') {
        // If childProc is not running, we start it
        if (!loopManager.childProc) {
          let chatId = config.telegram?.allowedUserIds?.[0] || ***REMOVED***;
          try {
            const statePath = join(HYDRA_DIR, 'chat-state.json');
            if (existsSync(statePath)) {
              const chatState = JSON.parse(readFileSync(statePath, 'utf8'));
              const keys = Object.keys(chatState);
              if (keys.length > 0) chatId = Number(keys[0]);
            }
          } catch (_) {}

          await loopManager.startLoop(chatId, projectKey || null);
          return res.json({ status: 'starting' });
        }

        loopManager.sendCommand('resume');
        telemetryStore.ingest({
          type: 'log',
          level: 'info',
          source: 'dashboard',
          message: 'Loop Orchestrator resume command sent',
        });
        return res.json({ status: 'resuming' });
      }

      if (cmd === 'start') {
        if (loopManager.childProc) {
          return res.status(400).json({ error: 'Loop is already running' });
        }

        let chatId = config.telegram?.allowedUserIds?.[0] || ***REMOVED***;
        try {
          const statePath = join(HYDRA_DIR, 'chat-state.json');
          if (existsSync(statePath)) {
            const chatState = JSON.parse(readFileSync(statePath, 'utf8'));
            const keys = Object.keys(chatState);
            if (keys.length > 0) chatId = Number(keys[0]);
          }
        } catch (_) {}

        await loopManager.startLoop(chatId, projectKey || null);
        return res.json({ status: 'starting' });
      }

      res.status(400).json({ error: 'Unknown cmd' });
    } catch (e) {
      next(e);
    }
  });

  router.post('/process-cmd', async (req, res, next) => {
    try {
      const { processName, action } = req.body;
      if (!processName || !action) {
        return res.status(400).json({ error: 'processName and action are required' });
      }

      if (!systemController || !systemController.processManager) {
        return res
          .status(503)
          .json({ error: 'Process manager is not integrated in this server process' });
      }

      const pm = systemController.processManager;

      if (processName === 'litellm') {
        if (action === 'start') {
          pm.startLiteLLM();
        } else if (action === 'stop') {
          pm.stopLiteLLM();
        } else if (action === 'restart') {
          pm.stopLiteLLM();
          setTimeout(() => pm.startLiteLLM(), 1000);
        } else {
          return res.status(400).json({ error: `Unknown action: ${action}` });
        }
        return res.json({ status: 'ok' });
      }

      if (processName === 'opencode') {
        if (action === 'start') {
          pm.startOpencode();
        } else if (action === 'stop') {
          pm.stopOpencode();
        } else if (action === 'restart') {
          pm.stopOpencode();
          // startOpencode is auto-called on exit unless manually stopped,
          // but if we call startOpencode manually it resets manualStopOpencode.
          // We can just wait for exit to auto-restart or manually trigger it after delay.
          setTimeout(() => pm.startOpencode(), 1000);
        } else {
          return res.status(400).json({ error: `Unknown action: ${action}` });
        }
        return res.json({ status: 'ok' });
      }

      res.status(400).json({ error: `Unknown processName: ${processName}` });
    } catch (e) {
      next(e);
    }
  });

  router.post('/hitl-resolve', async (req, res, next) => {
    try {
      const { action, responseText } = req.body;
      if (!action) return res.status(400).json({ error: 'action required' });

      if (!systemController || !systemController.loopManager) {
        return res.status(503).json({ error: 'Loop manager not integrated' });
      }

      const loopManager = systemController.loopManager;
      const projectsRoot = join(config.system?.rootDir || process.cwd(), '..');
      const currentProjectPath = loopManager.currentProjectPath || join(projectsRoot, 'loop');

      const signalPath = join(currentProjectPath, '.hydra', 'resume-signal.json');
      const dir = dirname(signalPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      const payload = {
        action: 'resume',
        data: `hydra:${action}`,
        responseText: responseText || null,
        source: 'dashboard',
        ts: new Date().toISOString(),
      };

      writeFileSync(signalPath, JSON.stringify(payload, null, 2), 'utf-8');

      telemetryStore.ingest({
        type: 'log',
        level: 'info',
        source: 'dashboard',
        message: `HITL resolved via dashboard: action=${action} text="${responseText || ''}"`,
      });

      res.json({ status: 'resolved' });
    } catch (e) {
      next(e);
    }
  });

  router.post('/internal/health-ping', (req, res) => {
    const services = req.body || {};
    telemetryStore.ingest({
      type: 'process.status',
      level: 'info',
      source: 'bridge',
      message: 'Health ping received',
      data: { name: 'bridge', services },
    });
    res.json({ status: 'ok' });
  });

  return router;
}
