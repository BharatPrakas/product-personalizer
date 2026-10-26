import type { Markup, MarkupKind, MarkupPayload } from './markup.models';

export interface MarkupQuery {
  kind?: MarkupKind;
  search?: string;
}

/** Where the markup library lives: the browser, or the personalization API (per store). */
export abstract class MarkupRepository {
  abstract list(query?: MarkupQuery): Promise<Markup[]>;
  /** Rejects with `MarkupNameTakenError` when the name exists for that kind (case-insensitive). */
  abstract create(input: {
    name: string;
    kind: MarkupKind;
    payload: MarkupPayload;
  }): Promise<Markup>;
  abstract rename(id: string, name: string): Promise<Markup>;
  abstract delete(id: string): Promise<void>;
}
