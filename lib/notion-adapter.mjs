#!/usr/bin/env node
/**
 * Notion Adapter — Bidirectional TODO / Backlog sync
 *
 * Treats a Notion page as the source-of-truth for task ideas.
 * Pulls tasks from page blocks, pushes progress back by updating headings.
 *
 * Env: NOTION_API_TOKEN, NOTION_DATABASE_ID or NOTION_PAGE_ID
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import crypto from "node:crypto";

const NOTION_API = "https://api.notion.com/v1";

export class NotionAdapter {
  constructor({ token, databaseId, projectTag, pageId } = {}) {
    this.token = token || process.env.NOTION_API_TOKEN;
    this.dbId = databaseId || process.env.NOTION_DATABASE_ID;
    this.pageId = pageId || process.env.NOTION_PAGE_ID || this.dbId;
    this.projectTag = projectTag || null;
    this._cache = null;
    this._cacheTs = 0;
    this._isPage = null; // auto-detected on first call
    this._idempotencyCache = new Map();
  }

  isReady() { return !!(this.token && (this.dbId || this.pageId)); }

  /* ─── Low-level Notion HTTP ─── */

  async _request(path, opts = {}) {
    if ((opts.method || "GET") !== "GET") {
      const hashStr = path + JSON.stringify(opts);
      const hash = crypto.createHash("md5").update(hashStr).digest("hex");
      const now = Date.now();
      if (this._idempotencyCache.has(hash) && (now - this._idempotencyCache.get(hash)) < 3000) {
        return {};
      }
      this._idempotencyCache.set(hash, now);
      for (const [k, v] of this._idempotencyCache.entries()) {
        if (now - v > 10000) this._idempotencyCache.delete(k);
      }
    }

    const url = `${NOTION_API}${path}`;
    const res = await fetch(url, {
      ...opts,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
        ...opts.headers,
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Notion ${opts.method || "GET"} ${path}: ${res.status} ${text.slice(0, 200)}`);
    }
    return res.json().catch(() => ({}));
  }

  /* ─── Auto-detect: page or database ─── */

  async _detectType() {
    if (this._isPage !== null) return;
    const id = this.dbId || this.pageId;
    try {
      const res = await fetch(`${NOTION_API}/databases/${id}`, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Notion-Version": "2022-06-28",
        },
      });
      if (res.ok) {
        this._isPage = false;
        return;
      }
    } catch {}
    this._isPage = true;
  }

  /* ─── Pull: Notion → local stories ─── */

  async pullTasks({ statusFilter = null, since = null } = {}) {
    if (!this.isReady()) return [];
    await this._detectType();

    if (this._isPage) {
      return this._pullFromPage();
    }
    return this._pullFromDatabase(statusFilter);
  }

  /* ─── Page mode ─── */

  async _pullFromPage() {
    const pid = this.pageId || this.dbId;
    // Get page metadata (for URL)
    let pageUrl = "";
    try {
      const pageMeta = await this._request(`/pages/${pid}`);
      pageUrl = pageMeta.url || "";
    } catch {}

    const blocks = await this._getAllBlocks(pid);
    const stories = this._blocksToStories(blocks, pageUrl);
    this._cache = stories;
    this._cacheTs = Date.now();
    return stories;
  }

  async _getAllBlocks(blockId) {
    const blocks = [];
    let cursor = null;
    do {
      const url = cursor
        ? `/blocks/${blockId}/children?page_size=100&start_cursor=${cursor}`
        : `/blocks/${blockId}/children?page_size=100`;
      const res = await this._request(url);
      blocks.push(...(res.results || []));
      cursor = res.next_cursor || null;
    } while (cursor);

    const result = [];
    for (const b of blocks) {
      result.push(b);
      if (b.has_children) {
        const kids = await this._getAllBlocks(b.id);
        result.push(...kids);
      }
    }
    return result;
  }

  _blocksToStories(blocks, pageUrl) {
    const stories = [];
    let current = null;

    const blockText = (b) => {
      const t = b[b.type]?.rich_text;
      if (!t) return "";
      return t.map(rt => rt.plain_text).join("");
    };

    for (const block of blocks) {
      const text = blockText(block);

      // Detect story heading: ### N) "Title" (tag)
      if (block.type === "heading_3") {
        const storyMatch = text.match(/^(\d+)\)\s*[\u201c\u0022](.+?)[\u201d\u0022](?:\s*\((.+)\))?$/);
        if (storyMatch) {
          if (current) stories.push(current);
          current = {
            blockId: block.id,
            storyId: storyMatch[1],
            title: storyMatch[2],
            tag: storyMatch[3] || "",
            status: "idle",
            excluded: false,
            priority: 3,
            description: "",
            acceptanceCriteria: [],
            notes: "",
            costEstimate: null,
            originalRichText: JSON.stringify(block.heading_3?.rich_text || []),
            url: pageUrl,
            lastEdited: block.last_edited_time,
          };
          continue;
        }
      }

      if (current && (block.type === "paragraph" || block.type === "bulleted_list_item" || block.type === "numbered_list_item")) {
        if (text) current.description += text + "\n";
      }
    }
    if (current) stories.push(current);

    // Trim descriptions
    for (const s of stories) {
      s.description = s.description.trim();
    }
    return stories;
  }

  /* ─── Database mode ─── */

  async _pullFromDatabase(statusFilter) {
    const sorts = [{ timestamp: "created_time", direction: "descending" }];
    const body = { sorts };

    const filters = [];
    if (statusFilter) {
      filters.push({
        property: "Status",
        select: { equals: statusFilter },
      });
    }
    if (this.projectTag) {
      filters.push({
        property: "Project",
        rich_text: { contains: this.projectTag },
      });
    }
    if (filters.length === 1) body.filter = filters[0];
    else if (filters.length > 1) body.filter = { and: filters };

    const pages = await this._queryDatabase(body);
    const tasks = pages.map(p => this._dbRowToTask(p));
    this._cache = tasks;
    this._cacheTs = Date.now();
    return tasks;
  }

  async _queryDatabase(body) {
    try {
      return await this._queryDatabaseRaw(body);
    } catch (e) {
      // If filter references a non-existent property, retry without filters
      if (e.message?.includes("Could not find property") && body.filter) {
        console.warn("[NotionAdapter] Filter property not found, retrying without filter");
        const retry = { sorts: body.sorts };
        return await this._queryDatabaseRaw(retry);
      }
      throw e;
    }
  }

  async _queryDatabaseRaw(body) {
    const pages = [];
    let nextCursor = null;
    do {
      const reqBody = nextCursor ? { ...body, start_cursor: nextCursor } : body;
      const res = await this._request(`/databases/${this.dbId}/query`, {
        method: "POST",
        body: JSON.stringify(reqBody),
      });
      pages.push(...(res.results || []));
      nextCursor = res.next_cursor;
      if (!res.has_more) break;
    } while (nextCursor);
    return pages;
  }

  _dbRowToTask(page) {
    const p = page.properties || {};
    const getTitle = (p) => p?.title?.[0]?.plain_text || "";
    const getSelect = (p) => p?.select?.name || "";
    const getNumber = (p) => (typeof p?.number === "number" ? p.number : null);
    const getRichText = (p) => p?.rich_text?.map(rt => rt.plain_text).join("") || "";
    const getCheckbox = (p) => p?.checkbox || false;

    const NOTION_TO_INTERNAL = {
      "Backlog": "idle",
      "In Progress": "running",
      "QA": "verifying",
      "Done": "completed",
      "Blocked": "blocked",
      "Archived": "archived",
    };

    return {
      pageId: page.id,
      storyId: page.id,
      title: getTitle(p.Name),
      status: NOTION_TO_INTERNAL[getSelect(p.Status)] || "idle",
      priority: getNumber(p.Priority) || 3,
      description: getRichText(p.Description),
      acceptanceCriteria: [],
      notes: getRichText(p.Notes),
      costEstimate: null,
      excluded: getCheckbox(p["Excluded from Loop"]),
      tag: getRichText(p.Tag),
      url: page.url,
      lastEdited: page.last_edited_time,
    };
  }

  /* ─── Push: local progress → Notion ─── */

  async pushProgress(task) {
    if (!this.isReady() || !task) return false;
    await this._detectType();

    if (this._isPage && task.blockId) {
      return this._updatePageBlock(task);
    }
    if (!this._isPage && task.pageId) {
      return this._updateDatabasePage(task);
    }
    return false;
  }

  async _updatePageBlock(task) {
    const isDone = task.status === "completed";
    const sid = task.storyId || "";
    const title = task.title || "";

    // Preserve original rich text structure, just update content
    let richText;
    try {
      richText = JSON.parse(task.originalRichText || "[]");
    } catch {
      richText = [{ type: "text", text: { content: "" } }];
    }

    // Detect quote style from original text: curly or straight
    const orig = richText.map(r => r.plain_text || "").join("");
    const curly = orig.includes("\u201c") || orig.includes("\u201d");
    const lq = curly ? "\u201c" : '"';
    const rq = curly ? "\u201d" : '"';

    const tag = task.tag ? ` (${task.tag})` : "";
    const newContent = `${sid}) ${lq}${title}${rq}${tag}`;
    if (richText.length > 0) {
      richText[0].text.content = newContent;
      // Remove extra items if we collapsed
      richText.splice(1);
    } else {
      richText.push({ type: "text", text: { content: newContent } });
    }

    await this._request(`/blocks/${task.blockId}`, {
      method: "PATCH",
      body: JSON.stringify({
        heading_3: { rich_text: richText },
      }),
    });
    return true;
  }

  async _updateDatabasePage(task) {
    const DEFAULT_STATUS_MAP = {
      Backlog: "idle",
      "In Progress": "running",
      QA: "verifying",
      Done: "completed",
      Blocked: "blocked",
      Archived: "archived",
    };
    const REVERSE_STATUS_MAP = Object.fromEntries(
      Object.entries(DEFAULT_STATUS_MAP).map(([k, v]) => [v, k])
    );

    const props = {};
    if (task.status && REVERSE_STATUS_MAP[task.status]) {
      props.Status = { select: { name: REVERSE_STATUS_MAP[task.status] } };
    }
    if (typeof task.priority === "number") {
      props.Priority = { number: task.priority };
    }
    if (task.notes !== undefined) {
      props.Notes = { rich_text: [{ text: { content: String(task.notes).slice(0, 2000) } }] };
    }

    await this._request(`/pages/${task.pageId}`, {
      method: "PATCH",
      body: JSON.stringify({ properties: props }),
    });
    return true;
  }

  async createStory(task) {
    if (!this.isReady()) return null;

    await this._detectType();
    if (this._isPage) {
      // For pages, we append a new heading_3 block
      if (task.storyId) {
        const existing = await this.pullTasks();
        if (existing.find(t => String(t.storyId) === String(task.storyId))) {
          return existing.find(t => String(t.storyId) === String(task.storyId)).blockId;
        }
      }
      const sid = task.storyId || Date.now().toString(36);
      const text = `${sid}) "${task.title}"`;
      const res = await this._request(`/blocks/${this.pageId}/children`, {
        method: "PATCH",
        body: JSON.stringify({
          children: [{
            object: "block",
            type: "heading_3",
            heading_3: {
              rich_text: [{ type: "text", text: { content: text } }],
            },
          }],
        }),
      });
      return res.results?.[0]?.id || null;
    }
    return this._createDatabaseStory(task);
  }

  async _createDatabaseStory(task) {
    const DEFAULT_STATUS_MAP = {
      Backlog: "idle",
      "In Progress": "running",
      QA: "verifying",
      Done: "completed",
      Blocked: "blocked",
      Archived: "archived",
    };
    const REVERSE_STATUS_MAP = Object.fromEntries(
      Object.entries(DEFAULT_STATUS_MAP).map(([k, v]) => [v, k])
    );

    if (task.storyId) {
      const dupes = await this.pullTasks();
      const existing = dupes.find(t => String(t.storyId) === String(task.storyId));
      if (existing) return existing.pageId;
    }

    const body = {
      parent: { database_id: this.dbId },
      properties: {
        Name: { title: [{ text: { content: task.title } }] },
        Status: { select: { name: REVERSE_STATUS_MAP[task.status || "idle"] || "Backlog" } },
        Priority: { number: typeof task.priority === "number" ? task.priority : 3 },
        "Story ID": { rich_text: [{ text: { content: String(task.storyId || Date.now().toString(36)) } }] },
      },
    };
    if (this.projectTag) {
      body.properties.Project = { rich_text: [{ text: { content: this.projectTag } }] };
    }
    if (task.description) {
      body.properties.Description = { rich_text: [{ text: { content: task.description.slice(0, 2000) } }] };
    }
    if (task.acceptanceCriteria?.length) {
      body.properties["Acceptance Criteria"] = {
        rich_text: [{ text: { content: task.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n").slice(0, 2000) } }],
      };
    }

    const res = await this._request("/pages", { method: "POST", body: JSON.stringify(body) });
    return res.id;
  }

  /* ─── Sync helpers ─── */

  async syncLocalPRD(projectPath, prd) {
    const stories = prd?.stories || [];
    const notionTasks = await this.pullTasks();
    const byId = new Map(notionTasks.map(t => [String(t.storyId), t]));

    const results = [];
    for (const s of stories) {
      const sid = String(s.id);
      if (!byId.has(sid)) {
        const pageId = await this.createStory({
          storyId: sid,
          title: s.title,
          description: s.description,
          acceptanceCriteria: s.acceptanceCriteria || [],
          priority: s.priority,
          status: s.passes ? "completed" : "idle",
        });
        results.push({ action: "created", pageId, storyId: sid });
      } else {
        const t = byId.get(sid);
        const localStatus = s.passes ? "completed" : t.status === "completed" ? "completed" : t.status;
        if (t.status !== localStatus) {
          await this.pushProgress({ ...t, status: localStatus });
          results.push({ action: "updated", pageId: t.blockId || t.pageId, storyId: sid });
        }
      }
    }
    return results;
  }
}

export default NotionAdapter;
