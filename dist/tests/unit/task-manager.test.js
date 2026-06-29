import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TaskManager } from '../../src/core/task-manager.js';
import * as fs from 'node:fs';
vi.mock('node:fs', async () => {
    const actual = await vi.importActual('node:fs');
    return {
        ...actual,
        existsSync: vi.fn(),
        mkdirSync: vi.fn(),
        readFileSync: vi.fn(),
        writeFileSync: vi.fn(),
    };
});
describe('TaskManager', () => {
    let tasks;
    let mockNotion;
    beforeEach(() => {
        mockNotion = {
            isReady: vi.fn().mockReturnValue(true),
            pullTasks: vi.fn().mockResolvedValue([]),
        };
        tasks = new TaskManager({ projectPath: '/test/project', notionAdapter: mockNotion });
        vi.clearAllMocks();
    });
    it('initializes empty state when no cache exists', () => {
        vi.mocked(fs.existsSync).mockReturnValue(false);
        expect(tasks.getAllTasks()).toEqual([]);
    });
    it('loads tasks correctly and returns them via public API', async () => {
        mockNotion.pullTasks.mockResolvedValue([
            { storyId: 't1', title: 'Task 1', status: 'in_progress' },
            { storyId: 't2', title: 'Task 2', status: 'blocked' },
            { storyId: 't3', title: 'Task 3', status: 'todo' },
        ]);
        await tasks.loadTasks();
        const all = tasks.getAllTasks();
        expect(all).toHaveLength(3);
        expect(tasks.findById('t1').status).toBe('in_progress');
        expect(tasks.getBlocked()).toHaveLength(1);
        expect(tasks.getBlocked()[0].id).toBe('t2');
    });
    it('updates task status locally and returns via API', async () => {
        mockNotion.pullTasks.mockResolvedValue([
            { storyId: 't1', title: 'Task 1', status: 'todo' },
        ]);
        await tasks.loadTasks();
        tasks.updateTaskStatus('t1', 'in_progress');
        expect(tasks.findById('t1').status).toBe('in_progress');
    });
    it('correctly resolves explicit dependencies', async () => {
        mockNotion.pullTasks.mockResolvedValue([
            { storyId: 't1', title: 'Infra Task', status: 'todo', dependsOn: ['t2'] },
            { storyId: 't2', title: 'UI Task', status: 'todo' },
        ]);
        const sorted = await tasks.loadTasks();
        const t1Idx = sorted.findIndex((t) => t.id === 't1');
        const t2Idx = sorted.findIndex((t) => t.id === 't2');
        expect(t2Idx).toBeLessThan(t1Idx);
        expect(sorted[t1Idx]._deps).toContain('t2');
    });
});
