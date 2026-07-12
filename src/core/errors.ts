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

export class QuotaExceededError extends HttpAppError {
  constructor(message: string = 'Quota limits exceeded') {
    super(message, 429, 'QUOTA_EXCEEDED');
  }
}
