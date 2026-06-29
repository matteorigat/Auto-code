#!/usr/bin/env node
/**
 * Notion Adapter — Bidirectional TODO / Backlog sync
 *
 * Treats a Notion page as the source-of-truth for task ideas.
 * Pulls tasks from page blocks, pushes progress back by updating headings.
 *
 * Env: NOTION_API_TOKEN, NOTION_DATABASE_ID or NOTION_PAGE_ID
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Client } from '@notionhq/client';
import config from '../config/index.js';
import { join } from 'node:path';
import crypto from 'node:crypto';

export interface NotionTask {
  storyId?: string;
  title?: string;
  status?: string;
  description?: string;
  priority?: number;
  pageId?: string;
  blockId?: string;
  tag?: string;
  excluded?: boolean;
  acceptanceCriteria?: string[];
  notes?: string;
  costEstimate?: number | null;
  originalRichText?: string;
  url?: string;
  lastEdited?: string;
  dependsOn?: string[];
  dependencies?: string[];
  _deps?: string[];
}

export interface NotionAdapterOptions {
  token?: string;
  databaseId?: string;
  projectTag?: string;
  pageId?: string;
}

export interface NotionRichText {
  type: string;
  plain_text: string;
  text?: { content: string };
}

export interface NotionBlock {
  id: string;
  type: string;
  has_children: boolean;
  last_edited_time?: string;
  heading_3?: { rich_text: NotionRichText[] };
  paragraph?: { rich_text: NotionRichText[] };
  bulleted_list_item?: { rich_text: NotionRichText[] };
  numbered_list_item?: { rich_text: NotionRichText[] };
}

export interface NotionProperty {
  id?: string;
  type?: string;
  title?: NotionRichText[];
  rich_text?: NotionRichText[];
  select?: { name: string };
  number?: number;
  checkbox?: boolean;
}

export interface NotionPage {
  id: string;
  url?: string;
  last_edited_time?: string;
  properties: Record<string, NotionProperty>;
}

export interface NotionResponse {
  results?: unknown[];
  next_cursor?: string | null;
  has_more?: boolean;
  url?: string;
}

const NOTION_API = 'https://api.notion.com/v1';

const NOTION_STATUS_MAP: Record<string, string> = {
  Backlog: 'idle',
  'In Progress': 'running',
  QA: 'verifying',
  Done: 'completed',
  Blocked: 'blocked',
  Archived: 'archived',
};

const REVERSE_STATUS_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(NOTION_STATUS_MAP).map(([k, v]) => [v, k]),
);

export class NotionAdapter {
  token: string | undefined;
  dbId: string | undefined;
  pageId: string | undefined;
  projectTag: string | null;
  _cache: NotionTask[] | null;
  _cacheTs: number;
  _isPage: boolean | null;
  _idempotencyCache: Map<string, number>;

  constructor({ token, databaseId, projectTag, pageId }: NotionAdapterOptions = {}) {
    this.token = token || config.notion.apiToken;
    this.dbId = databaseId || config.notion.databaseId;
    this.pageId = pageId || config.notion.pageId || this.dbId;
    this.projectTag = projectTag || null;
    this._cache = null;
    this._cacheTs = 0;
    this._isPage = null; // auto-detected on first call
    this._idempotencyCache = new Map();
  }

  isReady(): boolean {
    return !!(this.token && (this.dbId || this.pageId));
  }

  /* ─── Low-level Notion HTTP ─── */

  async _request(
    path: string,
    opts: { method?: string; body?: string; headers?: Record<string, string> } = {},
  ): Promise<NotionResponse> {
    if ((opts.method || 'GET') !== 'GET') {
      const hashStr = path + JSON.stringify(opts);
      const hash = crypto.createHash('md5').update(hashStr).digest('hex');
      const now = Date.now();
      if (
        this._idempotencyCache.has(hash) &&
        now - (this._idempotencyCache.get(hash) || 0) < 3000
      ) {
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
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
        ...opts.headers,
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `Notion ${opts.method || 'GET'} ${path}: ${res.status} ${text.slice(0, 200)}`,
      );
    }
    return res.json().catch(() => ({})) as Promise<NotionResponse>;
  }

  /* ─── Auto-detect: page or database ─── */

  async _detectType() {
    if (this._isPage !== null) return;
    const id = this.dbId || this.pageId;
    try {
      const res = await fetch(`${NOTION_API}/databases/${id}`, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Notion-Version': '2022-06-28',
        },
      });
      if (res.ok) {
        this._isPage = false;
        return;
      }
    } catch (e: unknown) {
      console.error('Ignored error:', e instanceof Error ? e.message : String(e));
    }
    this._isPage = true;
  }

  /* ─── Pull: Notion → local stories ─── */

  /**
   * Pulls tasks from the configured Notion database.
   */
  async pullTasks({
    statusFilter = null,
    since = null,
  }: { statusFilter?: string | null; since?: string | null } = {}): Promise<NotionTask[]> {
    if (!this.isReady()) return [];
    await this._detectType();

    if (this._isPage) {
      return this._pullFromPage();
    }
    return this._pullFromDatabase(statusFilter);
  }

  /* ─── Page mode ─── */

  async _pullFromPage(): Promise<NotionTask[]> {
    const pid = this.pageId || this.dbId;
    // Get page metadata (for URL)
    let pageUrl = '';
    try {
      const pageMeta = await this._request(`/pages/${pid}`);
      pageUrl = pageMeta.url || '';
    } catch (e: unknown) {
      console.error('Ignored error:', e instanceof Error ? e.message : String(e));
    }

    const blocks = await this._getAllBlocks(pid);
    const stories = this._blocksToStories(blocks, pageUrl);
    this._cache = stories;
    this._cacheTs = Date.now();
    return stories;
  }

  async _getAllBlocks(blockId: string | undefined): Promise<NotionBlock[]> {
    const blocks: NotionBlock[] = [];
    let cursor: string | null = null;
    do {
      const url = cursor
        ? `/blocks/${blockId}/children?page_size=100&start_cursor=${cursor}`
        : `/blocks/${blockId}/children?page_size=100`;
      const res = await this._request(url);
      if (res.results) {
        blocks.push(...(res.results as NotionBlock[]));
      }
      cursor = res.next_cursor || null;
    } while (cursor);

    const result: NotionBlock[] = [];
    for (const b of blocks) {
      result.push(b);
      if (b.has_children) {
        const kids = await this._getAllBlocks(b.id);
        result.push(...kids);
      }
    }
    return result;
  }

  _blocksToStories(blocks: NotionBlock[], pageUrl: string): NotionTask[] {
    const stories: NotionTask[] = [];
    let current: NotionTask | null = null;

    const blockText = (b: NotionBlock): string => {
      let rt: NotionRichText[] | undefined;
      if (b.type === 'heading_3') rt = b.heading_3?.rich_text;
      else if (b.type === 'paragraph') rt = b.paragraph?.rich_text;
      else if (b.type === 'bulleted_list_item') rt = b.bulleted_list_item?.rich_text;
      else if (b.type === 'numbered_list_item') rt = b.numbered_list_item?.rich_text;

      if (!rt) return '';
      return rt.map((r) => r.plain_text).join('');
    };

    for (const block of blocks) {
      const text = blockText(block);

      // Detect story heading: ### N) "Title" (tag)
      if (block.type === 'heading_3') {
        const storyMatch = text.match(
          /^(\d+)\)\s*[\u201c\u0022](.+?)[\u201d\u0022](?:\s*\((.+)\))?$/,
        );
        if (storyMatch) {
          if (current) stories.push(current);
          current = {
            blockId: block.id,
            storyId: storyMatch[1],
            title: storyMatch[2],
            tag: storyMatch[3] || '',
            status: 'idle',
            excluded: false,
            priority: 3,
            description: '',
            acceptanceCriteria: [],
            notes: '',
            costEstimate: null,
            originalRichText: JSON.stringify(block.heading_3?.rich_text || []),
            url: pageUrl,
            lastEdited: block.last_edited_time,
          };
          continue;
        }
      }

      if (
        current &&
        (block.type === 'paragraph' ||
          block.type === 'bulleted_list_item' ||
          block.type === 'numbered_list_item')
      ) {
        if (text) current.description += text + '\n';
      }
    }
    if (current) stories.push(current);

    // Trim descriptions
    for (const s of stories) {
      if (s.description) s.description = s.description.trim();
    }
    return stories;
  }

  /* ─── Database mode ─── */

  async _pullFromDatabase(statusFilter: string | null | undefined): Promise<NotionTask[]> {
    const sorts = [{ timestamp: 'created_time', direction: 'descending' }];
    const body: Record<string, unknown> = { sorts };

    const filters: Record<string, unknown>[] = [];
    if (statusFilter) {
      filters.push({
        property: 'Status',
        select: { equals: statusFilter },
      });
    }
    if (this.projectTag) {
      filters.push({
        property: 'Project',
        rich_text: { contains: this.projectTag },
      });
    }
    if (filters.length === 1) body.filter = filters[0];
    else if (filters.length > 1) body.filter = { and: filters };

    const pages = await this._queryDatabase(body);
    const tasks = pages.map((p) => this._dbRowToTask(p as NotionPage));
    this._cache = tasks;
    this._cacheTs = Date.now();
    return tasks;
  }

  async _queryDatabase(body: Record<string, unknown>): Promise<NotionPage[]> {
    try {
      return await this._queryDatabaseRaw(body);
    } catch (e: unknown) {
      const err = e as Error;
      if (err.message?.includes('Could not find property') && body.filter) {
        console.warn('[NotionAdapter] Filter property not found, retrying without filter');
        const retry = { sorts: body.sorts };
        return await this._queryDatabaseRaw(retry);
      }
      throw e;
    }
  }

  async _queryDatabaseRaw(body: Record<string, unknown>): Promise<NotionPage[]> {
    const pages: NotionPage[] = [];
    let nextCursor: string | null = null;
    do {
      const reqBody = nextCursor ? { ...body, start_cursor: nextCursor } : body;
      const res = await this._request(`/databases/${this.dbId}/query`, {
        method: 'POST',
        body: JSON.stringify(reqBody),
      });
      if (res.results) {
        pages.push(...(res.results as NotionPage[]));
      }
      nextCursor = res.next_cursor || null;
      if (!res.has_more) break;
    } while (nextCursor);
    return pages;
  }

  _dbRowToTask(page: NotionPage): NotionTask {
    const props = page.properties || {};
    const getTitle = (p: NotionProperty | undefined) => p?.title?.[0]?.plain_text || '';
    const getSelect = (p: NotionProperty | undefined) => p?.select?.name || '';
    const getNumber = (p: NotionProperty | undefined) =>
      typeof p?.number === 'number' ? p.number : null;
    const getRichText = (p: NotionProperty | undefined) =>
      p?.rich_text?.map((rt) => rt.plain_text).join('') || '';
    const getCheckbox = (p: NotionProperty | undefined) => p?.checkbox || false;

    const p = props;

    return {
      pageId: page.id,
      storyId: page.id,
      title: getTitle(p.Name),
      status: NOTION_STATUS_MAP[getSelect(p.Status)] || 'idle',
      priority: getNumber(p.Priority) || 3,
      description: getRichText(p.Description),
      acceptanceCriteria: [],
      notes: getRichText(p.Notes),
      costEstimate: null,
      excluded: getCheckbox(p['Excluded from Loop']),
      tag: getRichText(p.Tag),
      url: page.url,
      lastEdited: page.last_edited_time,
    };
  }

  /* ─── Push: local progress → Notion ─── */

  async pushProgress(task: NotionTask): Promise<boolean> {
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

  async _updatePageBlock(task: NotionTask): Promise<boolean> {
    const sid = task.storyId || '';
    const title = task.title || '';

    // Preserve original rich text structure, just update content
    let richText: NotionRichText[];
    try {
      richText = JSON.parse(task.originalRichText || '[]');
    } catch {
      richText = [{ type: 'text', plain_text: '', text: { content: '' } }];
    }

    const orig = richText.map((r) => r.plain_text || '').join('');
    const curly = orig.includes('\u201c') || orig.includes('\u201d');
    const lq = curly ? '\u201c' : '"';
    const rq = curly ? '\u201d' : '"';

    const tag = task.tag ? ` (${task.tag})` : '';
    const newContent = `${sid}) ${lq}${title}${rq}${tag}`;
    if (richText.length > 0) {
      if (richText[0].text) richText[0].text.content = newContent;
      richText[0].plain_text = newContent;
      // Remove extra items if we collapsed
      richText.splice(1);
    } else {
      richText.push({ type: 'text', plain_text: newContent, text: { content: newContent } });
    }

    await this._request(`/blocks/${task.blockId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        heading_3: { rich_text: richText },
      }),
    });
    return true;
  }

  async _updateDatabasePage(task: NotionTask): Promise<boolean> {
    const props: Record<string, unknown> = {};
    if (task.status && REVERSE_STATUS_MAP[task.status]) {
      props.Status = { select: { name: REVERSE_STATUS_MAP[task.status] } };
    }
    if (typeof task.priority === 'number') {
      props.Priority = { number: task.priority };
    }
    if (task.notes !== undefined) {
      props.Notes = { rich_text: [{ text: { content: String(task.notes).slice(0, 2000) } }] };
    }

    await this._request(`/pages/${task.pageId}`, {
      method: 'PATCH',
      body: JSON.stringify({ properties: props }),
    });
    return true;
  }

  async createStory(task: NotionTask): Promise<string | null> {
    if (!this.isReady()) return null;

    await this._detectType();
    if (this._isPage) {
      // For pages, we append a new heading_3 block
      if (task.storyId) {
        const existing = await this.pullTasks();
        if (existing.find((t) => String(t.storyId) === String(task.storyId))) {
          return existing.find((t) => String(t.storyId) === String(task.storyId))!.blockId || null;
        }
      }
      const sid = task.storyId || Date.now().toString(36);
      const text = `${sid}) "${task.title}"`;
      const res = await this._request(`/blocks/${this.pageId}/children`, {
        method: 'PATCH',
        body: JSON.stringify({
          children: [
            {
              object: 'block',
              type: 'heading_3',
              heading_3: {
                rich_text: [{ type: 'text', text: { content: text } }],
              },
            },
          ],
        }),
      });
      return (res.results?.[0] as NotionBlock)?.id || null;
    }
    return this._createDatabaseStory(task);
  }

  async _createDatabaseStory(task: NotionTask): Promise<string | null> {
    if (task.storyId) {
      const dupes = await this.pullTasks();
      const existing = dupes.find((t) => String(t.storyId) === String(task.storyId));
      if (existing) return existing.pageId || null;
    }

    const body: Record<string, unknown> = {
      parent: { database_id: this.dbId },
      properties: {
        Name: { title: [{ text: { content: task.title } }] },
        Status: { select: { name: REVERSE_STATUS_MAP[task.status || 'idle'] || 'Backlog' } },
        Priority: { number: typeof task.priority === 'number' ? task.priority : 3 },
        'Story ID': {
          rich_text: [{ text: { content: String(task.storyId || Date.now().toString(36)) } }],
        },
      } as Record<string, unknown>,
    };
    if (this.projectTag) {
      (body.properties as Record<string, unknown>).Project = {
        rich_text: [{ text: { content: this.projectTag } }],
      };
    }
    if (task.description) {
      (body.properties as Record<string, unknown>).Description = {
        rich_text: [{ text: { content: task.description.slice(0, 2000) } }],
      };
    }
    if (task.acceptanceCriteria?.length) {
      (body.properties as Record<string, unknown>)['Acceptance Criteria'] = {
        rich_text: [
          {
            text: {
              content: task.acceptanceCriteria
                .map((c, i) => `${i + 1}. ${c}`)
                .join('\n')
                .slice(0, 2000),
            },
          },
        ],
      };
    }

    const res = await this._request('/pages', { method: 'POST', body: JSON.stringify(body) });
    return (res as unknown as NotionPage).id || null;
  }

  /* ─── Sync helpers ─── */

  async syncLocalPRD(
    projectPath: string,
    prd: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]> {
    const stories = (prd?.stories as Record<string, unknown>[]) || [];
    const notionTasks = await this.pullTasks();
    const byId = new Map(notionTasks.map((t) => [String(t.storyId), t]));

    const results: Record<string, unknown>[] = [];
    for (const s of stories) {
      const sid = String(s.id);
      if (!byId.has(sid)) {
        const pageId = await this.createStory({
          storyId: sid,
          title: String(s.title),
          description: String(s.description),
          acceptanceCriteria: (s.acceptanceCriteria as string[]) || [],
          priority: Number(s.priority),
          status: s.passes ? 'completed' : 'idle',
        });
        results.push({ action: 'created', pageId, storyId: sid });
      } else {
        const t = byId.get(sid)!;
        const localStatus = s.passes
          ? 'completed'
          : t.status === 'completed'
            ? 'completed'
            : t.status;
        if (t.status !== localStatus) {
          await this.pushProgress({ ...t, status: localStatus as string });
          results.push({ action: 'updated', pageId: t.blockId || t.pageId, storyId: sid });
        }
      }
    }
    return results;
  }
}

export default NotionAdapter;
