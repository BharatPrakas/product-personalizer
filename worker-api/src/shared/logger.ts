/**
 * Structured logging. One JSON line per event, always carrying the request id and (when known) the
 * plugin id and store id. Sensitive values — tokens, secrets, raw config payloads, file bytes — are
 * never logged; callers pass only identifiers and counts.
 */

import type { LogLevel } from '../config/environment';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogFields {
  requestId: string;
  plugin?: string;
  storeId?: string;
  [key: string]: unknown;
}

export class Logger {
  constructor(
    private readonly level: LogLevel,
    private readonly base: LogFields,
  ) {}

  child(fields: Partial<LogFields>): Logger {
    return new Logger(this.level, { ...this.base, ...fields });
  }

  private write(level: LogLevel, message: string, extra?: Record<string, unknown>): void {
    if (ORDER[level] < ORDER[this.level]) return;
    const line = JSON.stringify({
      level,
      time: new Date().toISOString(),
      message,
      ...this.base,
      ...extra,
    });
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }

  debug(message: string, extra?: Record<string, unknown>): void {
    this.write('debug', message, extra);
  }
  info(message: string, extra?: Record<string, unknown>): void {
    this.write('info', message, extra);
  }
  warn(message: string, extra?: Record<string, unknown>): void {
    this.write('warn', message, extra);
  }
  error(message: string, extra?: Record<string, unknown>): void {
    this.write('error', message, extra);
  }
}
