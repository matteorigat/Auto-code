import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync, unlinkSync, } from 'node:fs';
import { join } from 'node:path';
import config from '../config/index.js';
import { FileLocker } from './file-locker.js';
const CHECKPOINT_FILE = 'loop-checkpoint.json';
const BACKUP_FILE = 'loop-checkpoint.json.bak';
export class DurableStateManager {
    projectPath;
    dir;
    cpPath;
    bakPath;
    stream;
    locker;
    state = null;
    version = 1;
    constructor(projectPath, stream) {
        this.projectPath = projectPath;
        this.dir = join(projectPath, '.hydra');
        this.cpPath = join(this.dir, CHECKPOINT_FILE);
        this.bakPath = join(this.dir, BACKUP_FILE);
        this.stream = stream;
        this.locker = new FileLocker(projectPath);
        if (!existsSync(this.dir))
            mkdirSync(this.dir, { recursive: true });
    }
    async load() {
        return this.locker.withLock('durable-state', async () => {
            try {
                if (existsSync(this.cpPath)) {
                    const raw = readFileSync(this.cpPath, 'utf-8');
                    const parsed = JSON.parse(raw);
                    this.state = parsed;
                    this.version = parsed.version || 1;
                    return parsed;
                }
            }
            catch {
                try {
                    if (existsSync(this.bakPath)) {
                        const raw = readFileSync(this.bakPath, 'utf-8');
                        const parsed = JSON.parse(raw);
                        this.state = parsed;
                        this.version = parsed.version || 1;
                        writeFileSync(this.cpPath, raw, 'utf-8');
                        return parsed;
                    }
                }
                catch {
                    // Both checkpoint and backup failed
                }
            }
            const baseline = this.makeBaseline();
            this.saveSync(baseline);
            this.state = baseline;
            return baseline;
        });
    }
    saveSync(override) {
        const st = override ?? this.state;
        if (!st)
            return false;
        st.version = this.version;
        st.updatedAt = new Date().toISOString();
        const json = JSON.stringify(st, null, 2);
        const tmp = `${this.cpPath}.tmp${Date.now()}`;
        try {
            if (existsSync(this.cpPath)) {
                try {
                    writeFileSync(this.bakPath, readFileSync(this.cpPath, 'utf-8'), 'utf-8');
                }
                catch {
                    // Best-effort backup
                }
            }
            writeFileSync(tmp, json, 'utf-8');
            renameSync(tmp, this.cpPath);
            return true;
        }
        catch {
            try {
                if (existsSync(tmp))
                    unlinkSync(tmp);
            }
            catch {
                // Best-effort cleanup
            }
            return false;
        }
    }
    async save(override) {
        return this.locker.withLock('durable-state', async () => {
            return this.saveSync(override);
        });
    }
    async transition(phase, extra) {
        if (!this.state)
            await this.load();
        const prev = this.state.phase;
        this.state.phase = phase;
        this.state.lastPhase = prev;
        if (extra) {
            Object.assign(this.state, extra);
        }
        this.state.eventId = (this.state.eventId || 0) + 1;
        await this.save();
        return this.state;
    }
    get() {
        return this.state;
    }
    set(key, val) {
        if (!this.state) {
            this.load().catch(() => { });
        }
        if (this.state) {
            this.state[key] = val;
            this.save();
            this.stream.emit('state-update', 'system', { key, val });
        }
    }
    makeBaseline() {
        return {
            version: this.version,
            projectPath: this.projectPath,
            phase: 'IDLE',
            lastPhase: null,
            currentTaskId: null,
            currentStory: null,
            attempt: 0,
            maxAttempts: config.loop.maxAttempts,
            previousError: null,
            humanGateReason: null,
            humanGateResolvedAt: null,
            eventId: 0,
            startedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            costAccumulatorUsd: 0,
            storiesCompletedToday: 0,
        };
    }
}
const instances = new Map();
export function getDurableState(projectPath, stream) {
    if (!instances.has(projectPath)) {
        instances.set(projectPath, new DurableStateManager(projectPath, stream));
    }
    return instances.get(projectPath);
}
