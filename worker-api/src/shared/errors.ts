/**
 * Typed API errors. Every handler throws one of these; the error-handler middleware turns it into a
 * consistent JSON envelope. Clients never see stack traces or internal messages for 5xx errors.
 */

export interface FieldIssue {
  path: string;
  code: string;
  message: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Structured, client-safe detail (e.g. validation issues). Omitted for opaque 5xx. */
    readonly details?: unknown,
    /** When false, the message is replaced by a generic one before reaching the client. */
    readonly clientSafe = true,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class BadRequestError extends ApiError {
  constructor(message = 'The request was malformed.', details?: unknown) {
    super(400, 'bad_request', message, details);
  }
}

export class UnauthorizedError extends ApiError {
  constructor(message = 'Authentication is required.') {
    super(401, 'unauthorized', message);
  }
}

export class ForbiddenError extends ApiError {
  constructor(message = 'You do not have access to this resource.') {
    super(403, 'forbidden', message);
  }
}

export class NotFoundError extends ApiError {
  constructor(message = 'The requested resource was not found.') {
    super(404, 'not_found', message);
  }
}

export class ConflictError extends ApiError {
  constructor(message = 'The resource was modified since it was loaded.', details?: unknown) {
    super(409, 'conflict', message, details);
  }
}

export class ValidationError extends ApiError {
  constructor(issues: readonly FieldIssue[], message = 'The payload failed validation.') {
    super(422, 'validation_failed', message, { issues });
  }
}

export class PayloadTooLargeError extends ApiError {
  constructor(message = 'The payload is too large.') {
    super(413, 'payload_too_large', message);
  }
}

export class UnsupportedMediaTypeError extends ApiError {
  constructor(message = 'The media type is not supported.') {
    super(415, 'unsupported_media_type', message);
  }
}

export class RateLimitError extends ApiError {
  constructor(
    readonly retryAfterSeconds: number,
    message = 'Too many requests. Slow down.',
  ) {
    super(429, 'rate_limited', message);
  }
}

/** A feature whose required secret / binding is not configured on this environment. */
export class ServiceUnavailableError extends ApiError {
  constructor(code = 'service_unavailable', message = 'This feature is not available right now.') {
    super(503, code, message);
  }
}

export class InternalError extends ApiError {
  constructor(cause?: unknown) {
    super(500, 'internal_error', 'An unexpected error occurred.', undefined, false);
    if (cause instanceof Error) this.cause = cause;
  }
}

/** Normalise any thrown value into an ApiError. Unknown throwables become an opaque 500. */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  return new InternalError(error);
}
