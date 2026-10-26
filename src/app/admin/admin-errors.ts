import type { AdminErrorDetail } from '../customizer/models/admin-element-contract';
import {
  ConfigurationConflictError,
  ConfigurationInvalidError,
  ConfigurationNotFoundError,
  StorageError,
} from '../workspace/configuration-repository';
import { ApiClientError } from '../workspace/cloud/api-client.service';

export class ReadOnlyError extends Error {
  constructor() {
    super('The admin is read-only.');
    this.name = 'ReadOnlyError';
  }
}

/**
 * Turns any failure into the sanitised `admin-error` detail. Messages are fixed strings chosen by
 * error class: server messages, template names and tokens never reach the host through events.
 */
export function toAdminError(error: unknown): AdminErrorDetail {
  // The cloud repository wraps transport failures; the original status is what the host needs.
  if (error instanceof StorageError && error.cause instanceof ApiClientError) {
    return toAdminError(error.cause);
  }
  if (error instanceof ReadOnlyError)
    return { code: 'forbidden', message: 'The admin is read-only.', recoverable: true };
  if (error instanceof ConfigurationConflictError)
    return { code: 'conflict', message: 'The template was changed elsewhere.', recoverable: true };
  if (error instanceof ConfigurationInvalidError)
    return { code: 'invalid', message: 'The template has validation problems.', recoverable: true };
  if (error instanceof ConfigurationNotFoundError)
    return { code: 'not-found', message: 'The template was not found.', recoverable: true };
  if (error instanceof StorageError)
    return { code: 'storage', message: 'The change could not be stored.', recoverable: true };
  if (error instanceof ApiClientError) {
    switch (true) {
      case error.status === 0:
        return { code: 'network', message: 'The server could not be reached.', recoverable: true };
      case error.status === 401:
        return {
          code: 'auth',
          message: 'The session is missing or has expired.',
          recoverable: true,
        };
      case error.status === 403:
        return { code: 'forbidden', message: 'This action is not allowed.', recoverable: false };
      case error.status === 404:
        return { code: 'not-found', message: 'The item was not found.', recoverable: true };
      case error.status === 409:
        return { code: 'conflict', message: 'The item was changed elsewhere.', recoverable: true };
      case error.status === 422 || error.status === 400:
        return {
          code: 'invalid',
          message: 'The request was rejected as invalid.',
          recoverable: true,
        };
      case error.status === 429:
        return {
          code: 'rate-limited',
          message: 'Too many requests. Try again shortly.',
          recoverable: true,
        };
    }
  }
  return { code: 'unexpected', message: 'Something went wrong.', recoverable: true };
}
