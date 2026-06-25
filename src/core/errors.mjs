export class AppError extends Error {
  constructor(message, status = 500, code = 'INTERNAL_ERROR') {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
    this.code = code;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super(message, 404, 'NOT_FOUND');
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Validation error') {
    super(message, 400, 'VALIDATION_ERROR');
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, 401, 'UNAUTHORIZED');
  }
}

export class NetworkTimeoutError extends AppError {
  constructor(message = 'Network request timed out') {
    super(message, 408, 'NETWORK_TIMEOUT');
  }
}

export class AgentStagnationError extends AppError {
  constructor(message = 'Agent reached stagnation threshold') {
    super(message, 409, 'AGENT_STAGNATION');
  }
}

export class ContextOverflowError extends AppError {
  constructor(message = 'Context window limit reached') {
    super(message, 413, 'CONTEXT_OVERFLOW');
  }
}

export class ConfigurationError extends AppError {
  constructor(message = 'Invalid system configuration') {
    super(message, 500, 'CONFIG_ERROR');
  }
}

export class SandboxExecutionError extends AppError {
  constructor(message = 'Sandbox execution failed') {
    super(message, 500, 'SANDBOX_ERROR');
  }
}

export class QuotaExceededError extends AppError {
  constructor(message = 'Quota limits exceeded') {
    super(message, 429, 'QUOTA_EXCEEDED');
  }
}

export class InvalidTelemetryError extends AppError {
  constructor(message = 'Invalid telemetry payload') {
    super(message, 400, 'TELEMETRY_ERROR');
  }
}
