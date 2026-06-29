import config from '../config/index.js';

type LogLevel = keyof typeof LEVELS;

const LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
} as const;

type LogMeta = Record<string, unknown> | undefined;

export class Logger {
  readonly moduleName: string;
  readonly level: number;
  readonly jsonMode: boolean;

  constructor(moduleName: string) {
    this.moduleName = moduleName;
    this.level = parseLevel(
      config.system.logFormat === 'json'
        ? config.system.logLevel
        : config.system.debug
          ? 'debug'
          : 'info',
    );
    this.jsonMode = config.system.logFormat === 'json';
  }

  private format(level: LogLevel, msg: string, meta?: LogMeta): string {
    const time = new Date().toISOString();
    if (this.jsonMode) {
      return JSON.stringify({ time, level, module: this.moduleName, msg, meta });
    }
    const metaStr = meta !== undefined ? ` | ${JSON.stringify(meta)}` : '';
    return `[${time}] [${level}] [${this.moduleName}] ${msg}${metaStr}`;
  }

  debug(msg: string, meta?: LogMeta): void {
    if (!this.shouldLog('DEBUG')) return;
    console.debug(this.format('DEBUG', msg, meta));
  }

  info(msg: string, meta?: LogMeta): void {
    if (!this.shouldLog('INFO')) return;
    console.log(this.format('INFO', msg, meta));
  }

  warn(msg: string, meta?: LogMeta): void {
    if (!this.shouldLog('WARN')) return;
    console.warn(this.format('WARN', msg, meta));
  }

  error(msg: string, errorOrMeta?: Error | LogMeta): void {
    if (!this.shouldLog('ERROR')) return;

    if (errorOrMeta instanceof Error) {
      const errMeta: Record<string, unknown> = {
        error: errorOrMeta.message,
        stack: errorOrMeta.stack,
      };
      if (this.jsonMode) {
        console.error(this.format('ERROR', msg, errMeta));
      } else {
        const time = new Date().toISOString();
        console.error(
          `[${time}] [ERROR] [${this.moduleName}] ${msg} | ERR: ${errorOrMeta.message}\n${errorOrMeta.stack}`,
        );
      }
      return;
    }

    console.error(this.format('ERROR', msg, errorOrMeta));
  }

  private shouldLog(levelName: LogLevel): boolean {
    return LEVELS[levelName] >= this.level;
  }
}

function parseLevel(levelStr: string | number): number {
  if (typeof levelStr === 'number') return levelStr;
  const l = levelStr.toUpperCase() as keyof typeof LEVELS;
  return LEVELS[l] ?? LEVELS.INFO;
}

export const createLogger = (moduleName: string): Logger => new Logger(moduleName);
