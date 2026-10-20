import { Service, signal } from '@angular/core';

export interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** Styles the confirm button as destructive. */
  danger?: boolean;
}

interface Pending extends ConfirmRequest {
  resolve: (confirmed: boolean) => void;
}

/** Promise-based confirmation dialogs, rendered by `<app-confirm-host>` in the application shell. */
@Service()
export class ConfirmService {
  readonly pending = signal<Pending | null>(null);

  confirm(request: ConfirmRequest): Promise<boolean> {
    // A second request while one is open cancels the first rather than stacking dialogs.
    this.pending()?.resolve(false);
    return new Promise((resolve) => this.pending.set({ ...request, resolve }));
  }

  answer(confirmed: boolean): void {
    const current = this.pending();
    this.pending.set(null);
    current?.resolve(confirmed);
  }
}
