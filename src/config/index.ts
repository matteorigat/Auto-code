import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, '..', '..');

// Load .env files from standard paths
const paths = [join(ROOT_DIR, '.env'), join(homedir(), '.openclaw', '.env')];

for (const p of paths) {
  if (existsSync(p)) {
    loadDotenv({ path: p, override: false }); // Load first found without overwriting process.env if already set
  }
}

// Utility to parse boolean env vars
function parseBool(val: string | undefined | null, fallback = false): boolean {
  if (val === undefined || val === null) return fallback;
  const s = String(val).toLowerCase();
  return s === 'true' || s === '1' || s === 'yes';
}

function parseNum(val: string | undefined | null, fallback: number): number {
  if (val === undefined || val === null || val === '') return fallback;
  const num = Number(val);
  return isNaN(num) ? fallback : num;
}

// Validation logic
const missingRequired: string[] = [];
function requireEnv(key: string): string | undefined {
  if (!process.env[key]) missingRequired.push(key);
  return process.env[key];
}

// Sync Kilo API Keys
if (process.env.KILOCODE_API_KEY && !process.env.KILO_API_KEY) {
  process.env.KILO_API_KEY = process.env.KILOCODE_API_KEY;
}
if (process.env.KILO_API_KEY && !process.env.KILOCODE_API_KEY) {
  process.env.KILOCODE_API_KEY = process.env.KILO_API_KEY;
}

export interface AppConfig {
  telegram: {
    botToken: string;
    allowedUserIds: number[];
    pollingTimeoutSec: number;
  };
  notion: {
    apiToken?: string;
    databaseId?: string;
    pageId?: string;
  };
  opencode: {
    port: number;
    url: string;
    model: string;
    mode: string;
  };
  modelRouter: {
    port: number;
    url: string;
    opencodeZenApiKey?: string;
    openrouterApiKey?: string;
  };
  loop: {
    dailyCostLimit: number;
    maxAttempts: number;
    maxCycleMs: number;
    bugHunterProbability: number;
    innovatorProbability: number;
  };
  dashboard: {
    port: number;
    bindAddress: string;
    token?: string;
    timezoneOffset: string;
  };
  health: {
    port: number;
  };
  system: {
    rootDir: string;
    debug: boolean;
    logLevel: string;
    logJson: boolean;
    logFormat?: string;
    sessionTimeoutMinutes: number;
    stallTimeoutMinutes: number;
    chatId?: string;
  };
}

const config: AppConfig = {
  telegram: {
    botToken: requireEnv('TELEGRAM_BOT_TOKEN') || '',
    allowedUserIds: requireEnv('TELEGRAM_ALLOWED_USER_ID')
      ? (process.env.TELEGRAM_ALLOWED_USER_ID as string)
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean)
          .map(Number)
          .filter((n) => !isNaN(n))
      : [],
    pollingTimeoutSec: parseNum(process.env.TELEGRAM_POLLING_TIMEOUT_SEC, 30),
  },
  notion: {
    apiToken: process.env.NOTION_API_TOKEN,
    databaseId: process.env.NOTION_DATABASE_ID,
    pageId: process.env.NOTION_PAGE_ID,
  },
  opencode: {
    port: parseNum(process.env.OPENCODE_PORT, 4096),
    url: process.env.OC_URL || `http://127.0.0.1:${parseNum(process.env.OPENCODE_PORT, 4096)}`,
    model: process.env.OPENCODE_DEFAULT_MODEL || 'model-router/tier-4-planner',
    mode: process.env.BRIDGE_MODE || 'api',
  },
  modelRouter: {
    port: parseNum(process.env.MODELROUTER_PORT, 20128),
    url: process.env.MODELROUTER_URL || `http://127.0.0.1:${parseNum(process.env.MODELROUTER_PORT, 20128)}`,
    opencodeZenApiKey: process.env.OPENCODE_ZEN_API_KEY || process.env.OPENCODE_API_KEY,
    openrouterApiKey: process.env.OPENROUTER_API_KEY,
  },
  loop: {
    dailyCostLimit: parseNum(process.env.LOOP_DAILY_COST_LIMIT, 10.0),
    maxAttempts: parseNum(process.env.LOOP_MAX_ATTEMPTS, 3),
    maxCycleMs: parseNum(process.env.LOOP_MAX_CYCLE_MS, 900000), // 15 mins
    bugHunterProbability: parseNum(process.env.BUG_HUNTER_PROBABILITY, 0.3),
    innovatorProbability: parseNum(process.env.INNOVATOR_PROBABILITY, 0.2),
  },
  dashboard: {
    port: parseNum(process.env.DASHBOARD_PORT, 8081),
    bindAddress: process.env.DASHBOARD_BIND_ADDRESS || '0.0.0.0',
    token: process.env.DASHBOARD_TOKEN,
    timezoneOffset: process.env.DASHBOARD_TIMEZONE_OFFSET || '+0 hours',
  },
  health: {
    port: parseNum(process.env.HEALTH_PORT, 9090),
  },
  system: {
    rootDir: ROOT_DIR,
    debug: parseBool(process.env.DEBUG, false),
    logLevel: process.env.LOG_LEVEL || 'info',
    logJson: parseBool(process.env.LOG_JSON, false),
    logFormat: process.env.LOG_FORMAT,
    sessionTimeoutMinutes: parseNum(process.env.SESSION_TIMEOUT_MINUTES, 1440),
    stallTimeoutMinutes: parseNum(process.env.STALL_TIMEOUT_MINUTES, 30),
    chatId: process.env.HYDRA_CHAT_ID,
  },
};

if (missingRequired.length > 0) {
  console.error(
    `\x1b[31m[CONFIG ERROR] Missing required environment variables: ${missingRequired.join(', ')}\x1b[0m`,
  );
  process.exit(1);
}

if (config.telegram.allowedUserIds.length === 0) {
  console.warn(
    `\x1b[33m[CONFIG WARNING] TELEGRAM_ALLOWED_USER_ID is invalid or empty. The bot will reject all users.\x1b[0m`,
  );
}

export default config;
