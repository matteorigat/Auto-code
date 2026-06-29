import config from '../config/index.js';
const LEVELS = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
};
export class Logger {
    moduleName;
    level;
    jsonMode;
    constructor(moduleName) {
        this.moduleName = moduleName;
        this.level = parseLevel(config.system.logFormat === 'json'
            ? config.system.logLevel
            : config.system.debug
                ? 'debug'
                : 'info');
        this.jsonMode = config.system.logFormat === 'json';
    }
    format(level, msg, meta) {
        const time = new Date().toISOString();
        if (this.jsonMode) {
            return JSON.stringify({ time, level, module: this.moduleName, msg, meta });
        }
        const metaStr = meta !== undefined ? ` | ${JSON.stringify(meta)}` : '';
        return `[${time}] [${level}] [${this.moduleName}] ${msg}${metaStr}`;
    }
    debug(msg, meta) {
        if (!this.shouldLog('DEBUG'))
            return;
        console.debug(this.format('DEBUG', msg, meta));
    }
    info(msg, meta) {
        if (!this.shouldLog('INFO'))
            return;
        console.log(this.format('INFO', msg, meta));
    }
    warn(msg, meta) {
        if (!this.shouldLog('WARN'))
            return;
        console.warn(this.format('WARN', msg, meta));
    }
    error(msg, errorOrMeta) {
        if (!this.shouldLog('ERROR'))
            return;
        if (errorOrMeta instanceof Error) {
            const errMeta = {
                error: errorOrMeta.message,
                stack: errorOrMeta.stack,
            };
            if (this.jsonMode) {
                console.error(this.format('ERROR', msg, errMeta));
            }
            else {
                const time = new Date().toISOString();
                console.error(`[${time}] [ERROR] [${this.moduleName}] ${msg} | ERR: ${errorOrMeta.message}\n${errorOrMeta.stack}`);
            }
            return;
        }
        console.error(this.format('ERROR', msg, errorOrMeta));
    }
    shouldLog(levelName) {
        return LEVELS[levelName] >= this.level;
    }
}
function parseLevel(levelStr) {
    if (typeof levelStr === 'number')
        return levelStr;
    const l = levelStr.toUpperCase();
    return LEVELS[l] ?? LEVELS.INFO;
}
export const createLogger = (moduleName) => new Logger(moduleName);
