import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { NotionAdapter, NotionTask } from './notion-adapter.js';

export interface Story {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  priority?: number;
  status: string;
  passes: boolean;
  excluded?: boolean;
  notes?: string;
  pageId?: string;
  blockId?: string;
  _projectSlug?: string | null;
  dependsOn?: string[];
  dependencies?: string[];
  _deps?: string[];
}

export interface Project {
  slug: string;
  title: string;
  pageId: string;
  description: string;
  codebasePatterns: string;
  stories: Story[];
}

export interface PRD {
  projects: Project[];
  crossProjectStories: Story[];
  progress: string;
  codebasePatterns: string;
  [key: string]: unknown;
}

export interface TaskManagerOptions {
  projectPath: string;
  notionAdapter?: NotionAdapter | null;
}

export class TaskManager {
  projectPath: string;
  notion: NotionAdapter | null;
  prdPath: string;
  projectsDir: string;
  _tasks: Story[];

  constructor({ projectPath, notionAdapter = null }: TaskManagerOptions) {
    this.projectPath = projectPath;
    this.notion = notionAdapter;
    this.prdPath = join(projectPath, 'prd.json');
    this.projectsDir = join(projectPath, 'projects');
    this._tasks = [];
  }

  /* ─── PRD I/O ─── */

  async readPRDAsync(): Promise<PRD> {
    try {
      const { readFile } = await import('node:fs/promises');
      return JSON.parse(await readFile(this.prdPath, 'utf-8'));
    } catch {
      return { projects: [], crossProjectStories: [], progress: '', codebasePatterns: '' };
    }
  }

  async writePRDAsync(prd: PRD): Promise<void> {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(this.prdPath, JSON.stringify(prd, null, 2));
  }

  readPRD(): PRD {
    try {
      return JSON.parse(readFileSync(this.prdPath, 'utf-8'));
    } catch {
      return { projects: [], crossProjectStories: [], progress: '', codebasePatterns: '' };
    }
  }

  writePRD(prd: PRD) {
    writeFileSync(this.prdPath, JSON.stringify(prd, null, 2));
  }

  /* ─── Execution Mode ─── */

  getExecutionMode(): string {
    try {
      const modePath = join(this.projectPath, '.hydra', 'execution-mode.json');
      if (existsSync(modePath)) {
        const data = JSON.parse(readFileSync(modePath, 'utf-8'));
        return data.mode || 'sequential';
      }
    } catch (e: unknown) {
      console.error('Ignored error:', e instanceof Error ? e.message : String(e));
    }
    return 'sequential';
  }

  /* ─── Source merge ─── */

  async loadTasks(): Promise<Story[]> {
    const prd = await this.readPRDAsync();

    // Flatten from nested structure
    let local: Story[] = [];
    if (prd.projects) {
      for (const proj of prd.projects) {
        if (proj.stories) {
          local.push(...proj.stories.map((s) => ({ ...s, _projectSlug: proj.slug })));
        }
      }
    }
    for (const s of prd.crossProjectStories || []) {
      s._projectSlug = null;
      local.push(s);
    }

    // Merge Notion if available
    if (this.notion?.isReady()) {
      try {
        const notionTasks = await this.notion.pullTasks();
        local = this._mergeSources(notionTasks, local, prd);
        await this.writePRDAsync(prd);
      } catch (e: unknown) {
        console.error(
          '[TaskManager] Notion pull failed:',
          e instanceof Error ? e.message : String(e),
        );
      }
    }

    this._tasks = local;
    this._persist();
    this.rebuildProjectFiles();
    return this._sortAndResolveDependencies();
  }

  _mergeSources(notionTasks: NotionTask[], localStories: Story[], prd: PRD): Story[] {
    const byId = new Map<string, Story>(localStories.map((s) => [String(s.id), s]));

    for (const nt of notionTasks) {
      const sid = String(nt.storyId || nt.pageId);
      if (byId.has(sid)) {
        const local = byId.get(sid)!;
        if (nt.excluded !== undefined) local.excluded = nt.excluded;
        if (nt.priority != null) local.priority = nt.priority;
        if (nt.description) local.description = nt.description;
        if (nt.acceptanceCriteria?.length) local.acceptanceCriteria = nt.acceptanceCriteria;
        if (nt.status && nt.status !== 'idle') {
          local.status = nt.status;
          if (nt.status === 'completed') local.passes = true;
          if (nt.status === 'blocked' && !local.passes) local.passes = false;
        }
        if (nt.dependsOn) local.dependsOn = nt.dependsOn;
        if (nt.dependencies) local.dependencies = nt.dependencies;
        if (nt._deps) local._deps = nt._deps;
      } else {
        if (nt.excluded) continue;
        // Determine project slug from Notion tag
        let projectSlug: string | null = null;
        if (nt.tag) {
          const tagLower = nt.tag.toLowerCase().trim();
          const existing = (prd?.projects || []).find(
            (p) => p.slug?.toLowerCase() === tagLower || p.title?.toLowerCase() === tagLower,
          );
          if (existing) {
            projectSlug = existing.slug;
          } else {
            projectSlug = nt.tag.trim();
            prd.projects.push({
              slug: projectSlug,
              title: nt.tag.trim(),
              pageId: nt.pageId || '',
              description: '',
              codebasePatterns: '',
              stories: [],
            });
          }
        }

        byId.set(sid, {
          id: sid,
          title: nt.title || '',
          description: nt.description || '',
          acceptanceCriteria: nt.acceptanceCriteria || [],
          priority: nt.priority || 3,
          status: nt.status || 'idle',
          passes: nt.status === 'completed',
          excluded: nt.excluded || false,
          notes: nt.notes || '',
          pageId: nt.pageId,
          blockId: nt.blockId,
          _projectSlug: projectSlug,
          dependsOn: nt.dependsOn || undefined,
          dependencies: nt.dependencies || undefined,
          _deps: nt._deps || undefined,
        });
      }
    }

    const all = Array.from(byId.values());
    return all.filter((s) => !s.excluded);
  }

  /* ─── Dependency inference ─── */

  _sortAndResolveDependencies(): Story[] {
    const inferDeps = (stories: Story[]): Story[] => {
      const isInfra = (s: Story) =>
        /\b(schema|database|table|migration|models?|apis?|backend)s?\b/i.test(
          s.title + ' ' + (s.description || ''),
        );
      const isUI = (s: Story) =>
        /\b(page|components?|ui|display|view|frontend|screen)s?\b/i.test(
          s.title + ' ' + (s.description || ''),
        );
      return stories.map((s) => {
        let explicitDeps: string[] = s.dependsOn || s.dependencies || s._deps || [];
        if (!Array.isArray(explicitDeps)) {
          explicitDeps = [String(explicitDeps)];
        }

        // Filter out any dependencies that do not belong to the same project
        const deps = new Set(
          explicitDeps.map(String).filter((depId) => {
            const depTask = stories.find((t) => String(t.id) === depId);
            if (!depTask) return false;
            return (
              depTask._projectSlug === s._projectSlug ||
              depTask._projectSlug === null ||
              s._projectSlug === null
            );
          }),
        );

        if (deps.size === 0 && isUI(s)) {
          for (const other of stories) {
            if (other.id !== s.id && other._projectSlug === s._projectSlug && isInfra(other)) {
              deps.add(String(other.id));
            }
          }
        }
        return { ...s, _deps: Array.from(deps) };
      });
    };

    const withDeps = inferDeps(this._tasks);
    const sorted: Story[] = [];
    const pending = new Set(withDeps.map((s) => String(s.id)));
    const depMap = new Map(withDeps.map((s) => [String(s.id), new Set(s._deps || [])]));

    while (pending.size) {
      let progress = false;
      const candidates: string[] = [];
      for (const id of pending) {
        const deps = depMap.get(id)!;
        if ([...deps].every((d) => !pending.has(d))) candidates.push(id);
      }
      if (!candidates.length) break;
      const bestId = candidates.sort((a, b) => {
        const pa = withDeps.find((s) => String(s.id) === a)?.priority || 99;
        const pb = withDeps.find((s) => String(s.id) === b)?.priority || 99;
        return pa - pb;
      })[0];
      sorted.push(withDeps.find((s) => String(s.id) === bestId)!);
      pending.delete(bestId);
      progress = true;
    }

    for (const id of pending) {
      sorted.push(withDeps.find((s) => String(s.id) === id)!);
    }

    this._tasks = sorted;
    return sorted;
  }

  /* ─── Story fitting / splitting ─── */

  needsSplitting(story: Story, maxChars = 1200): boolean {
    const text = [story.title, story.description, ...(story.acceptanceCriteria || [])].join(' ');
    return text.length > maxChars;
  }

  splitStory(story: Story): Story[] {
    const ac = story.acceptanceCriteria || [];
    const mid = Math.ceil(ac.length / 2);
    const a: Story = {
      ...story,
      id: `${story.id}-a`,
      title: `${story.title} (part 1)`,
      acceptanceCriteria: ac.slice(0, mid),
      passes: false,
    };
    const b: Story = {
      ...story,
      id: `${story.id}-b`,
      title: `${story.title} (part 2)`,
      acceptanceCriteria: ac.slice(mid),
      passes: false,
    };
    return [a, b];
  }

  /* ─── CRUD helpers ─── */

  getAllTasks(): Story[] {
    return this._tasks || [];
  }

  findById(id: string): Story | undefined {
    return this._tasks.find((t) => String(t.id) === String(id));
  }

  getBlocked(): Story[] {
    return this._tasks.filter((t) => t.status === 'blocked');
  }

  getDone(): Story[] {
    return this._tasks.filter((t) => t.passes);
  }

  updateTaskStatus(id: string, status: string) {
    const t = this.findById(id);
    if (t) {
      t.status = status;
      if (status === 'completed') t.passes = true;
      this._persist();
    }
  }

  getNextPending(): Story | null {
    const ready = this.getReadyTasks('sequential');
    return ready.length ? ready[0] : null;
  }

  getReadyTasks(mode = 'sequential'): Story[] {
    const isReady = (task: Story) => {
      if (task.passes || task.status === 'blocked') return false;
      if (!task._deps || task._deps.length === 0) return true;
      return task._deps.every((depId) => {
        const depTask = this._tasks.find((t) => String(t.id) === String(depId));
        return depTask ? depTask.passes : true;
      });
    };

    const readyTasks = this._tasks.filter(isReady);
    readyTasks.sort((a, b) => (a.priority || 3) - (b.priority || 3));

    if (mode === 'parallel') {
      return readyTasks;
    }
    return readyTasks.length ? [readyTasks[0]] : [];
  }

  markPass(storyId: string): Story | undefined {
    const s = this._tasks.find((t) => String(t.id) === String(storyId));
    if (s) {
      s.passes = true;
      s.status = 'completed';
      this._persist();
      this._syncProjectFiles(s);
    }
    return s;
  }

  markBlocked(storyId: string, reason: string): Story | undefined {
    const s = this._tasks.find((t) => String(t.id) === String(storyId));
    if (s) {
      s.status = 'blocked';
      s.notes = reason;
      this._persist();
      this._syncProjectFiles(s);
    }
    return s;
  }

  addStory(story: Partial<Story>): Story {
    const newStory: Story = {
      id: story.id || `US-${Date.now().toString(36)}`,
      title: story.title || '',
      description: story.description || '',
      acceptanceCriteria: story.acceptanceCriteria || [],
      priority: story.priority || 3,
      status: story.status || 'idle',
      passes: story.passes || false,
      ...story,
    };
    this._tasks.push(newStory);
    this._tasks = this._sortAndResolveDependencies();
    this._persist();
    return newStory;
  }

  stats(): { total: number; done: number; left: number; blocked: number } {
    const total = this._tasks.length;
    const done = this._tasks.filter((s) => s.passes).length;
    const blocked = this._tasks.filter((s) => s.status === 'blocked').length;
    return { total, done, left: total - done - blocked, blocked };
  }

  /* ─── Persist: flat _tasks back to nested root prd.json ─── */

  _persist() {
    const prd = this.readPRD();

    // Rebuild nested structure from flat _tasks
    const slugIndex: Record<string, Project> = {};
    for (const proj of prd.projects || []) {
      slugIndex[proj.slug] = proj;
    }

    // Group tasks by _projectSlug
    const bySlug: Record<string, Story[]> = {};
    const crossProject: Story[] = [];
    for (const task of this._tasks) {
      const { _projectSlug, ...clean } = task;
      if (_projectSlug) {
        if (!bySlug[_projectSlug]) bySlug[_projectSlug] = [];
        bySlug[_projectSlug].push(clean as Story);
      } else {
        crossProject.push(clean as Story);
      }
    }

    // Update each project's stories in root prd.json
    const updatedSlugs = new Set<string>();
    for (const proj of prd.projects || []) {
      proj.stories = bySlug[proj.slug] || [];
      updatedSlugs.add(proj.slug);
    }
    // Add project entries for stories whose slug doesn't exist yet
    for (const slug of Object.keys(bySlug)) {
      if (!updatedSlugs.has(slug) && bySlug[slug].length > 0) {
        prd.projects.push({
          slug,
          title: slug,
          pageId: '',
          description: '',
          codebasePatterns: '',
          stories: bySlug[slug],
        });
        updatedSlugs.add(slug);
      }
    }
    prd.crossProjectStories = crossProject;

    this.writePRD(prd);
  }

  /* ─── Sync a single story's status to project prd.json file ─── */

  _syncProjectFiles(story: Story) {
    const slug = story._projectSlug;
    if (!slug) return;
    const projDir = join(this.projectsDir, slug);
    if (!existsSync(projDir)) return;

    const projPrdPath = join(projDir, 'prd.json');
    try {
      const projPrd: {
        project: string;
        projectSlug: string;
        stories: Record<string, unknown>[];
        codebasePatterns: string;
      } = { project: slug, projectSlug: slug, stories: [], codebasePatterns: '' };
      try {
        Object.assign(projPrd, JSON.parse(readFileSync(projPrdPath, 'utf-8')));
      } catch {
        /* intentional: file missing or invalid JSON */
      }

      const idx = projPrd.stories.findIndex((s) => String(s.id) === String(story.id));
      const { _projectSlug, ...clean } = story;
      if (idx >= 0) {
        projPrd.stories[idx] = clean as unknown as Record<string, unknown>;
      } else {
        projPrd.stories.push(clean as unknown as Record<string, unknown>);
      }
      writeFileSync(projPrdPath, JSON.stringify(projPrd, null, 2));
    } catch (e: unknown) {
      console.error(
        `[TaskManager] sync to ${projPrdPath}:`,
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  /* ─── Rebuild all project prd.json files from root data ─── */

  rebuildProjectFiles() {
    const prd = this.readPRD();
    for (const proj of prd.projects || []) {
      const projDir = join(this.projectsDir, proj.slug);
      try {
        mkdirSync(projDir, { recursive: true });
      } catch {
        continue;
      }

      const projPrd = {
        project: proj.title || proj.slug,
        projectSlug: proj.slug,
        pageId: proj.pageId || '',
        description: proj.description || '',
        codebasePatterns: proj.codebasePatterns || '',
        stories: proj.stories || [],
      };
      writeFileSync(join(projDir, 'prd.json'), JSON.stringify(projPrd, null, 2));
    }
  }

  /* ─── Helper: find project slug for a story ID ─── */

  findProjectSlug(storyId: string): string | null {
    const s = this._tasks.find((t) => String(t.id) === String(storyId));
    return s?._projectSlug || null;
  }
}
