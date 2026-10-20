import { Service, signal } from '@angular/core';

export type ToastKind = 'success' | 'error' | 'info';

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

/** Short confirmations and failures. Errors stay longer; none carries a technical dump. */
@Service()
export class ToastService {
  readonly toasts = signal<readonly Toast[]>([]);
  private nextId = 1;

  show(kind: ToastKind, message: string): void {
    const toast: Toast = { id: this.nextId++, kind, message };
    this.toasts.update((list) => [...list.slice(-3), toast]);
    setTimeout(() => this.dismiss(toast.id), kind === 'error' ? 9000 : 4500);
  }

  success(message: string): void {
    this.show('success', message);
  }

  error(message: string): void {
    this.show('error', message);
  }

  dismiss(id: number): void {
    this.toasts.update((list) => list.filter((t) => t.id !== id));
  }
}
