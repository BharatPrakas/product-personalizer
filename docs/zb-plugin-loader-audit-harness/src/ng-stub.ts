// Minimal stand-ins so the REAL custom-plugins.component.ts runs unmodified outside Angular DI.
export const Component = (_: unknown) => (c: unknown) => c;
export const Injectable = (_: unknown) => (c: unknown) => c;
export const ViewChild = (_: unknown) => () => {};
export class ElementRef {}
export class Renderer2 {}
export class ChangeDetectorRef {}
export class ActivatedRoute {}
export class HttpClient {}
export class EnvService {}
export class ZbaLoaderComponent {}
export const CommonModule = {};
export type OnInit = unknown; export type OnDestroy = unknown;
export const providers = new Map<unknown, unknown>();
export function inject(token: unknown) {
  if (!providers.has(token)) throw new Error('NullInjector: ' + (token as {name?: string}).name);
  return providers.get(token);
}
