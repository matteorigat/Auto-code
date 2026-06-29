import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { PROJECTS } from '../core/projects.js';
import config from '../config/index.js';
import { getTelemetryClient } from '../dashboard/telemetry-client.js';
const telemetry = getTelemetryClient();
export class LoopManager {
    bot;
    currentProjectPath = null;
    shouldBeRunning = false;
    restartCount = 0;
    lastRestartTime = 0;
    childProc = null;
    currentPhase = null;
    constructor(bot) {
        this.bot = bot;
    }
    sendCommand(cmd) {
        if (this.childProc?.send) {
            this.childProc.send({ action: 'dashboard_cmd', cmd });
        }
    }
    async startLoop(chatId, projectKey) {
        try {
            const projectsRoot = join(config.system.rootDir, '..');
            const projName = projectKey || 'loop';
            const projPath = projectKey
                ? PROJECTS[projectKey]?.path || join(projectsRoot, projectKey)
                : join(projectsRoot, 'loop');
            if (!existsSync(projPath)) {
                await this.bot.send(chatId, `Error: project directory does not exist: \`${projPath}\``);
                return;
            }
            this.currentProjectPath = projPath;
            this.shouldBeRunning = true;
            const loopScript = join(config.system.rootDir, 'agents', 'orchestrator', 'index.ts');
            const child = spawn(process.execPath, ['--import', 'tsx', loopScript, projPath], {
                stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
                env: { ...process.env, HYDRA_CHAT_ID: String(chatId) },
            });
            this.childProc = child;
            child.stdout?.on('data', (d) => {
                const line = d.toString().trim();
                console.log('[orchestrator]', line);
                telemetry.info('orchestrator', line);
            });
            child.stderr?.on('data', (d) => {
                const line = d.toString().trim();
                console.error('[orchestrator-err]', line);
                telemetry.error('orchestrator', line);
            });
            child.on('message', (msg) => {
                if (msg.type === 'telegram' && this.bot.handleIPCMessage) {
                    this.bot.handleIPCMessage(msg);
                }
                if (msg.type === 'loop.status' && msg.data?.phase) {
                    this.currentPhase = msg.data.phase;
                }
            });
            child.on('exit', async (code, signal) => {
                telemetry.emit('process.status', 'orchestrator', `Orchestrator exited (code ${code})`, {
                    level: code === 0 ? 'info' : 'warn',
                    data: { name: 'orchestrator', status: 'stopped', code, signal },
                });
                this.childProc = null;
                this.currentPhase = null;
                if (this.shouldBeRunning) {
                    const now = Date.now();
                    if (now - this.lastRestartTime > 60000) {
                        this.restartCount = 0;
                    }
                    if (this.restartCount < 5) {
                        this.restartCount++;
                        this.lastRestartTime = now;
                        await this.bot.send(chatId, `Restart attempt ${this.restartCount}/5...`);
                        setTimeout(() => this.startLoop(chatId, projectKey), 5000);
                    }
                    else {
                        this.shouldBeRunning = false;
                        await this.bot.send(chatId, 'Too many consecutive crashes. Auto-restart disabled.');
                    }
                }
                else {
                    await this.bot.send(chatId, 'Loop exited.');
                }
            });
            await this.bot.send(chatId, `Hydra Loop started on \`${projName}\`.`);
        }
        catch (err) {
            await this.bot.send(chatId, `Error starting loop: ${err.message}`);
        }
    }
}
