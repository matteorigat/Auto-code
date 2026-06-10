import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";

export class TaskManager {
  constructor({ projectPath, notionAdapter = null } = {}) {
    this.projectPath = projectPath;
    this.notion = notionAdapter;
    this.prdPath = join(projectPath, "prd.json");
    this.projectsDir = join(projectPath, "projects");
    this._tasks = [];
  }

  /* ─── PRD I/O ─── */

  readPRD() {
    try {
      return JSON.parse(readFileSync(this.prdPath, "utf-8"));
    } catch {
      return { projects: [], crossProjectStories: [], progress: "", codebasePatterns: "" };
    }
  }

  writePRD(prd) {
    writeFileSync(this.prdPath, JSON.stringify(prd, null, 2));
  }

  /* ─── Source merge ─── */

  async loadTasks() {
    const prd = this.readPRD();

    // Flatten from nested structure
    let local = [];
    const projectsList = prd.projects || [];
    for (const proj of projectsList) {
      for (const s of (proj.stories || [])) {
        s._projectSlug = proj.slug;
        local.push(s);
      }
    }
    for (const s of (prd.crossProjectStories || [])) {
      s._projectSlug = null;
      local.push(s);
    }

    // Merge Notion if available
    if (this.notion?.isReady()) {
      try {
        const notionTasks = await this.notion.pullTasks();
        local = this._mergeSources(notionTasks, local);
      } catch (e) {
        console.error("[TaskManager] Notion pull failed:", e.message);
      }
    }

    this._tasks = local;
    return this._sortAndResolveDependencies();
  }

  _mergeSources(notionTasks, localStories) {
    const byId = new Map(localStories.map(s => [String(s.id), s]));

    for (const nt of notionTasks) {
      const sid = String(nt.storyId || nt.pageId);
      if (byId.has(sid)) {
        const local = byId.get(sid);
        if (nt.excluded !== undefined) local.excluded = nt.excluded;
        if (nt.priority != null) local.priority = nt.priority;
        if (nt.description) local.description = nt.description;
        if (nt.acceptanceCriteria?.length) local.acceptanceCriteria = nt.acceptanceCriteria;
        if (nt.status && nt.status !== "idle") {
          local.status = nt.status;
          if (nt.status === "completed") local.passes = true;
          if (nt.status === "blocked" && !local.passes) local.passes = false;
        }
      } else {
        byId.set(sid, {
          id: sid,
          title: nt.title,
          description: nt.description,
          acceptanceCriteria: nt.acceptanceCriteria || [],
          priority: nt.priority || 3,
          passes: nt.status === "completed",
          excluded: nt.excluded || false,
          notes: nt.notes || "",
          pageId: nt.pageId,
          blockId: nt.blockId,
          _projectSlug: null,
        });
      }
    }

    const all = Array.from(byId.values());
    return all.filter(s => !s.excluded);
  }

  /* ─── Dependency inference ─── */

  _sortAndResolveDependencies() {
    const inferDeps = (stories) => {
      const isInfra = (s) => /schema|database|table|migration|model|api|backend/i.test(s.title + " " + (s.description || ""));
      const isUI = (s) => /page|component|ui|display|view|frontend|screen/i.test(s.title + " " + (s.description || ""));
      return stories.map(s => {
        const deps = [];
        if (isUI(s)) {
          for (const other of stories) {
            if (other.id !== s.id && isInfra(other)) deps.push(String(other.id));
          }
        }
        return { ...s, _deps: deps };
      });
    };

    const withDeps = inferDeps(this._tasks);
    const sorted = [];
    const pending = new Set(withDeps.map(s => String(s.id)));
    const depMap = new Map(withDeps.map(s => [String(s.id), new Set(s._deps || [])]));

    while (pending.size) {
      let progress = false;
      const candidates = [];
      for (const id of pending) {
        const deps = depMap.get(id);
        if ([...deps].every(d => !pending.has(d))) candidates.push(id);
      }
      if (!candidates.length) break;
      const bestId = candidates.sort((a, b) => {
        const pa = withDeps.find(s => String(s.id) === a)?.priority || 99;
        const pb = withDeps.find(s => String(s.id) === b)?.priority || 99;
        return pa - pb;
      })[0];
      sorted.push(withDeps.find(s => String(s.id) === bestId));
      pending.delete(bestId);
      progress = true;
    }

    for (const id of pending) {
      sorted.push(withDeps.find(s => String(s.id) === id));
    }

    this._tasks = sorted;
    return sorted;
  }

  /* ─── Story fitting / splitting ─── */

  needsSplitting(story, maxChars = 1200) {
    const text = [
      story.title,
      story.description,
      ...(story.acceptanceCriteria || []),
    ].join(" ");
    return text.length > maxChars;
  }

  splitStory(story) {
    const ac = story.acceptanceCriteria || [];
    const mid = Math.ceil(ac.length / 2);
    const a = {
      ...story,
      id: `${story.id}-a`,
      title: `${story.title} (part 1)`,
      acceptanceCriteria: ac.slice(0, mid),
      passes: false,
    };
    const b = {
      ...story,
      id: `${story.id}-b`,
      title: `${story.title} (part 2)`,
      acceptanceCriteria: ac.slice(mid),
      passes: false,
    };
    return [a, b];
  }

  /* ─── CRUD helpers ─── */

  getNextPending() {
    const pending = this._tasks.filter(s => !s.passes && s.status !== "blocked");
    if (!pending.length) return null;
    pending.sort((a, b) => (a.priority || 3) - (b.priority || 3));
    return pending[0];
  }

  markPass(storyId) {
    const s = this._tasks.find(t => String(t.id) === String(storyId));
    if (s) {
      s.passes = true;
      s.status = "completed";
      this._persist();
      this._syncProjectFiles(s);
    }
    return s;
  }

  markBlocked(storyId, reason) {
    const s = this._tasks.find(t => String(t.id) === String(storyId));
    if (s) {
      s.status = "blocked";
      s.notes = reason;
      this._persist();
      this._syncProjectFiles(s);
    }
    return s;
  }

  addStory(story) {
    story.id = story.id || `US-${Date.now().toString(36)}`;
    story.passes = false;
    this._tasks.push(story);
    this._tasks = this._sortAndResolveDependencies();
    this._persist();
    return story;
  }

  stats() {
    const total = this._tasks.length;
    const done = this._tasks.filter(s => s.passes).length;
    const blocked = this._tasks.filter(s => s.status === "blocked").length;
    return { total, done, left: total - done - blocked, blocked };
  }

  /* ─── Persist: flat _tasks back to nested root prd.json ─── */

  _persist() {
    const prd = this.readPRD();

    // Rebuild nested structure from flat _tasks
    const slugIndex = {};
    for (const proj of (prd.projects || [])) { slugIndex[proj.slug] = proj; }

    // Group tasks by _projectSlug
    const bySlug = {};
    const crossProject = [];
    for (const task of this._tasks) {
      const { _projectSlug, ...clean } = task;
      if (_projectSlug) {
        if (!bySlug[_projectSlug]) bySlug[_projectSlug] = [];
        bySlug[_projectSlug].push(clean);
      } else {
        crossProject.push(clean);
      }
    }

    // Update each project's stories in root prd.json
    const updatedSlugs = new Set();
    for (const proj of (prd.projects || [])) {
      proj.stories = bySlug[proj.slug] || [];
      updatedSlugs.add(proj.slug);
    }
    // Add project entries for stories whose slug doesn't exist yet
    for (const slug of Object.keys(bySlug)) {
      if (!updatedSlugs.has(slug) && bySlug[slug].length > 0) {
        prd.projects.push({
          slug, title: slug, pageId: "", stories: bySlug[slug],
        });
        updatedSlugs.add(slug);
      }
    }
    prd.crossProjectStories = crossProject;

    this.writePRD(prd);
  }

  /* ─── Sync a single story's status to project prd.json file ─── */

  _syncProjectFiles(story) {
    const slug = story._projectSlug;
    if (!slug) return;
    const projDir = join(this.projectsDir, slug);
    if (!existsSync(projDir)) return;

    const projPrdPath = join(projDir, "prd.json");
    try {
      let projPrd = { project: slug, projectSlug: slug, stories: [], codebasePatterns: "" };
      try { projPrd = JSON.parse(readFileSync(projPrdPath, "utf-8")); } catch {}

      const idx = projPrd.stories.findIndex(s => String(s.id) === String(story.id));
      const { _projectSlug, ...clean } = story;
      if (idx >= 0) {
        projPrd.stories[idx] = clean;
      } else {
        projPrd.stories.push(clean);
      }
      writeFileSync(projPrdPath, JSON.stringify(projPrd, null, 2));
    } catch (e) {
      console.error(`[TaskManager] sync to ${projPrdPath}: ${e.message}`);
    }
  }

  /* ─── Rebuild all project prd.json files from root data ─── */

  rebuildProjectFiles() {
    const prd = this.readPRD();
    for (const proj of (prd.projects || [])) {
      const projDir = join(this.projectsDir, proj.slug);
      try { mkdirSync(projDir, { recursive: true }); } catch { continue; }

      const projPrd = {
        project: proj.title || proj.slug,
        projectSlug: proj.slug,
        pageId: proj.pageId || "",
        description: proj.description || "",
        codebasePatterns: proj.codebasePatterns || "",
        stories: proj.stories || [],
      };
      writeFileSync(join(projDir, "prd.json"), JSON.stringify(projPrd, null, 2));
    }
  }

  /* ─── Helper: find project slug for a story ID ─── */

  findProjectSlug(storyId) {
    const s = this._tasks.find(t => String(t.id) === String(storyId));
    return s?._projectSlug || null;
  }
}

export default TaskManager;
