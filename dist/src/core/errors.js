export class AppError extends Error {
    status;
    code;
    constructor(message, status = 500, code = 'INTERNAL_ERROR', options) {
        super(message, options);
        this.name = this.constructor.name;
        this.status = status;
        this.code = code;
        Error.captureStackTrace(this, this.constructor);
    }
    toJSON() {
        return {
            name: this.name,
            message: this.message,
            status: this.status,
            code: this.code,
        };
    }
}
class HttpAppError extends AppError {
    constructor(message, status, code) {
        super(message, status, code);
    }
}
export class NotFoundError extends HttpAppError {
    constructor(message = 'Not found') {
        super(message, 404, 'NOT_FOUND');
    }
}
export class ValidationError extends HttpAppError {
    constructor(message = 'Validation error') {
        super(message, 400, 'VALIDATION_ERROR');
    }
}
export class UnauthorizedError extends HttpAppError {
    constructor(message = 'Unauthorized') {
        super(message, 401, 'UNAUTHORIZED');
    }
}
export class NetworkTimeoutError extends HttpAppError {
    constructor(message = 'Network request timed out') {
        super(message, 408, 'NETWORK_TIMEOUT');
    }
}
export class AgentStagnationError extends HttpAppError {
    constructor(message = 'Agent reached stagnation threshold') {
        super(message, 409, 'AGENT_STAGNATION');
    }
}
export class ContextOverflowError extends HttpAppError {
    constructor(message = 'Context window limit reached') {
        super(message, 413, 'CONTEXT_OVERFLOW');
    }
}
export class ConfigurationError extends HttpAppError {
    constructor(message = 'Invalid system configuration') {
        super(message, 500, 'CONFIG_ERROR');
    }
}
export class SandboxExecutionError extends HttpAppError {
    constructor(message = 'Sandbox execution failed') {
        super(message, 500, 'SANDBOX_ERROR');
    }
}
export class QuotaExceededError extends HttpAppError {
    constructor(message = 'Quota limits exceeded') {
        super(message, 429, 'QUOTA_EXCEEDED');
    }
}
export class InvalidTelemetryError extends HttpAppError {
    constructor(message = 'Invalid telemetry payload') {
        super(message, 400, 'TELEMETRY_ERROR');
    }
}
export function isAppError(error) {
    return error instanceof AppError;
}
export function assertAppError(error, code) {
    if (!(error instanceof AppError)) {
        throw new AppError('Expected AppError', 500, code ?? 'ASSERTION_ERROR');
    }
}
