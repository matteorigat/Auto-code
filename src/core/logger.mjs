import config from '../config/index.mjs';

const LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

export class Logger {
  constructor(moduleName) {
    this.moduleName = moduleName;
    this.level = this._parseLevel(
      config.system.logLevel || (config.system.debug ? 'debug' : 'info'),
    );
    this.jsonMode = config.system.logFormat === 'json';
  }

  _parseLevel(levelStr) {
    const l = String(levelStr).toUpperCase();
    return LEVELS[l] !== undefined ? LEVELS[l] : LEVELS.INFO;
  }

  _shouldLog(levelName) {
    return LEVELS[levelName] >= this.level;
  }

  _format(level, msg, meta) {
    const time = new Date().toISOString();
    if (this.jsonMode) {
      return JSON.stringify({ time, level, module: this.moduleName, msg, meta });
    }
    const metaStr = meta ? ` | ${JSON.stringify(meta)}` : '';
    return `[${time}] [${level}] [${this.moduleName}] ${msg}${metaStr}`;
  }

  info(msg, meta) {
    if (!this._shouldLog('INFO')) return;
    console.log(this._format('INFO', msg, meta));
  }

  warn(msg, meta) {
    if (!this._shouldLog('WARN')) return;
    console.warn(this._format('WARN', msg, meta));
  }

  error(msg, errorOrMeta) {
    if (!this._shouldLog('ERROR')) return;

    let meta = errorOrMeta;
    if (errorOrMeta instanceof Error) {
      meta = { error: errorOrMeta.message, stack: errorOrMeta.stack };
    }

    if (this.jsonMode) {
      console.error(this._format('ERROR', msg, meta));
    } else {
      const time = new Date().toISOString();
      const errStr =
        errorOrMeta instanceof Error
          ? ` | ERR: ${errorOrMeta.message}\n${errorOrMeta.stack}`
          : meta
            ? ` | ${JSON.stringify(meta)}`
            : '';
      console.error(`[${time}] [ERROR] [${this.moduleName}] ${msg}${errStr}`);
    }
  }

  debug(msg, meta) {
    if (!this._shouldLog('DEBUG')) return;
    console.debug(this._format('DEBUG', msg, meta));
  }
}

export const createLogger = (moduleName) => new Logger(moduleName);
