import type { CustomizerErrorCode } from '../models/events.models';

/** A failure with a code and a message that is safe to show and to emit (no shopper content). */
export class CustomizerError extends Error {
  constructor(
    readonly code: CustomizerErrorCode,
    message: string,
    readonly recoverable = false,
  ) {
    super(message);
    this.name = 'CustomizerError';
  }
}

/** A shopper's file was rejected; the message explains what to do. */
export class UploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UploadError';
  }
}

/** Thrown by `prepareForCart` with a message that is safe to show the shopper as-is. */
export class PrepareError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrepareError';
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/** Short origin-or-path label for messages; never includes query strings or credentials. */
export function describeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const file = parsed.pathname.split('/').filter(Boolean).pop() ?? parsed.pathname;
    return `${file} (${parsed.origin})`;
  } catch {
    return 'an asset';
  }
}
