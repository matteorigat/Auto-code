export class AppError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(
    message: string,
    status: number = 500,
    code: string = 'INTERNAL_ERROR',
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = this.constructor.name;
    this.status = status;
    this.code = code;
    Error.captureStackTrace(this, this.constructor);
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      status: this.status,
      code: this.code,
    };
  }
}

abstract class HttpAppError extends AppError {
  constructor(message: string, status: number, code: string) {
    super(message, status, code);
  }
}

export class NotFoundError extends HttpAppError {
  constructor(message: string = 'Not found') {
    super(message, 404, 'NOT_FOUND');
  }
}

export class ValidationError extends HttpAppError {
  constructor(message: string = 'Validation error') {
    super(message, 400, 'VALIDATION_ERROR');
  }
}

export class UnauthorizedError extends HttpAppError {
  constructor(message: string = 'Unauthorized') {
    super(message, 401, 'UNAUTHORIZED');
  }
}

export class NetworkTimeoutError extends HttpAppError {
  constructor(message: string = 'Network request timed out') {
    super(message, 408, 'NETWORK_TIMEOUT');
  }
}

export class AgentStagnationError extends HttpAppError {
  constructor(message: string = 'Agent reached stagnation threshold') {
    super(message, 409, 'AGENT_STAGNATION');
  }
}

export class ContextOverflowError extends HttpAppError {
  constructor(message: string = 'Context window limit reached') {
    super(message, 413, 'CONTEXT_OVERFLOW');
  }
}

export class ConfigurationError extends HttpAppError {
  constructor(message: string = 'Invalid system configuration') {
    super(message, 500, 'CONFIG_ERROR');
  }
}

export class SandboxExecutionError extends HttpAppError {
  constructor(message: string = 'Sandbox execution failed') {
    super(message, 500, 'SANDBOX_ERROR');
  }
}

export class QuotaExceededError extends HttpAppError {
  constructor(message: string = 'Quota limits exceeded') {
    super(message, 429, 'QUOTA_EXCEEDED');
  }
}

export class InvalidTelemetryError extends HttpAppError {
  constructor(message: string = 'Invalid telemetry payload') {
    super(message, 400, 'TELEMETRY_ERROR');
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

export function assertAppError(error: unknown, code?: string): asserts error is AppError {
  if (!(error instanceof AppError)) {
    throw new AppError('Expected AppError', 500, code ?? 'ASSERTION_ERROR');
  }
}
