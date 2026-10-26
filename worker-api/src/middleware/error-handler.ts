/**
 * Centralised error handling. Every thrown value becomes a consistent error envelope. 5xx details
 * (messages, stacks, causes) are logged server-side but never sent to the client; 4xx errors keep
 * their client-safe message and structured details.
 */

import type { Context, ErrorHandler, NotFoundHandler } from 'hono';
import { ZodError } from 'zod';
import { ApiError, NotFoundError, ValidationError, toApiError } from '../shared/errors';
import type { AppEnv } from '../shared/context';
import { errorResponse } from '../shared/responses';
import type { Logger } from '../shared/logger';

function zodToValidationError(error: ZodError): ValidationError {
  const issues = error.issues.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    code: issue.code,
    message: issue.message,
  }));
  return new ValidationError(issues);
}

export const onError: ErrorHandler<AppEnv> = (err, c: Context<AppEnv>) => {
  const logger = c.get('logger') as Logger | undefined;
  const apiError =
    err instanceof ZodError ? zodToValidationError(err) : toApiError(err);

  if (apiError.status >= 500) {
    logger?.error('unhandled error', {
      code: apiError.code,
      // Internal only — never serialised to the client.
      detail: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  } else {
    logger?.warn('request rejected', { code: apiError.code, status: apiError.status });
  }
  return errorResponse(c, apiError instanceof ApiError ? apiError : toApiError(apiError));
};

export const notFound: NotFoundHandler<AppEnv> = (c) =>
  errorResponse(c, new NotFoundError('No route matches this path.'));
