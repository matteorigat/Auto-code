import { describe, it, expect } from 'vitest';
import {
  AppError,
  NotFoundError,
  ValidationError,
  UnauthorizedError,
} from '../../src/core/errors.mjs';

describe('Error Hierarchy', () => {
  it('AppError has correct properties', () => {
    const err = new AppError('test error', 501, 'TEST_ERR');
    expect(err.message).toBe('test error');
    expect(err.status).toBe(501);
    expect(err.code).toBe('TEST_ERR');
    expect(err.name).toBe('AppError');
  });

  it('NotFoundError sets defaults', () => {
    const err = new NotFoundError();
    expect(err.message).toBe('Not found');
    expect(err.status).toBe(404);
    expect(err.code).toBe('NOT_FOUND');
    expect(err.name).toBe('NotFoundError');
  });

  it('ValidationError sets defaults', () => {
    const err = new ValidationError();
    expect(err.message).toBe('Validation error');
    expect(err.status).toBe(400);
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.name).toBe('ValidationError');
  });

  it('UnauthorizedError sets defaults', () => {
    const err = new UnauthorizedError();
    expect(err.message).toBe('Unauthorized');
    expect(err.status).toBe(401);
    expect(err.code).toBe('UNAUTHORIZED');
    expect(err.name).toBe('UnauthorizedError');
  });
});
