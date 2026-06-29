import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('Config Loader', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('validates minimal config successfully', async () => {
    // Set only required fields
    process.env.TELEGRAM_BOT_TOKEN = '12345:ABCDE';
    process.env.NOTION_API_TOKEN = 'secret_123';
    process.env.NOTION_DATABASE_ID = 'db_123';
    process.env.NOTION_PAGE_ID = 'page_123';
    process.env.ALLOWED_PROJECTS = 'opencode,testproj';

    const { default: config } = await import('../../src/config/index.js');

    expect(config.telegram.botToken).toBe('12345:ABCDE');
    expect(config.notion.apiToken).toBe('secret_123');
    expect(config.notion.databaseId).toBe('db_123');
    expect(config.notion.pageId).toBe('page_123');
    expect(config.dashboard.port).toBe(8081);
  });
});
