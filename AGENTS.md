You are an expert in TypeScript, Angular, and scalable web application development. You write functional, maintainable, performant, and accessible code following Angular and TypeScript best practices.

## TypeScript Best Practices

- Use strict type checking
- Prefer type inference when the type is obvious
- Avoid the `any` type; use `unknown` when type is uncertain

## Angular Best Practices

- Always use standalone components over NgModules
- Must NOT set `standalone: true` inside Angular decorators. It's the default in Angular v20+.
- Do NOT set `changeDetection: ChangeDetectionStrategy.OnPush` explicitly. `OnPush` is the default in Angular v22+.
- Use signals for state management
- Implement lazy loading for feature routes
- Do NOT use the `@HostBinding` and `@HostListener` decorators. Put host bindings inside the `host` object of the `@Component` or `@Directive` decorator instead
- Use `NgOptimizedImage` for all static images.
  - `NgOptimizedImage` does not work for inline base64 images.

## Accessibility Requirements

- It MUST pass all AXE checks.
- It MUST follow all WCAG AA minimums, including focus management, color contrast, and ARIA attributes.

### Components

- Keep components small and focused on a single responsibility
- Use `input()` and `output()` functions instead of decorators
- Use `model()` for two-way bound properties with `[(prop)]` syntax instead of pairing `input()` with `output()`
- Use `computed()` for derived state
- Use `linkedSignal()` for state derived from multiple reactive sources that must stay synchronized
- Prefer inline templates for small components
- Prefer Signal Forms (`@angular/forms/signals`) for new forms. They are stable in Angular v22+ and provide signal-based state, type-safe field access, and schema-based validation
- When not using Signal Forms, prefer Reactive forms instead of Template-driven ones
- Do NOT use `ngClass`, use `class` bindings instead
- Do NOT use `ngStyle`, use `style` bindings instead
- Do NOT import `CommonModule`, import only the directives and pipes the template uses, such as `AsyncPipe` or `DatePipe`
- When using external templates/styles, use paths relative to the component TS file.

## State Management

- Use signals for local component state
- Use `computed()` for derived state
- Keep state transformations pure and predictable
- Do NOT use `mutate` on signals, use `update` or `set` instead

## Templates

- Keep templates simple and avoid complex logic
- Use native control flow (`@if`, `@for`, `@switch`) instead of `*ngIf`, `*ngFor`, `*ngSwitch`
- Use the async pipe to handle observables
- Do not assume globals like (`new Date()`) are available.

## Services

- Design services around a single responsibility
- Use the `providedIn: 'root'` option for singleton services
- Prefer the `@Service` decorator over `@Injectable({providedIn: 'root'})` for new singleton services (Angular v22+)
- Use the `inject()` function instead of constructor injection

## Repository working instructions

- Before changes, read `docs/PROJECT_CONTEXT.md` and inspect the relevant implementation and tests. Current source, including existing working-tree changes, is authoritative; README comments can lag behind it.
- This repository has two separate npm packages: the Angular 22 / TypeScript 6 frontend at the root, and the Hono / PostgreSQL Cloudflare Worker in `worker-api/`. Run commands in the appropriate directory.
- Preserve both embeddable elements and their public contracts in `src/app/customizer/models/{element-contract,admin-element-contract,events.models}.ts`. Keep the storefront download graph free of admin/editor code.
- Use existing pure transformations in `editor/util/config-edit.ts` and the shared resolution/evaluation/rendering pipeline. Keep production-canvas pixels separate from normalized mockup placements.
- Keep persistence behind the configuration, mapping, and markup repository contracts. Preserve draft/published separation, version progression, optimistic concurrency, and honest storage/error reporting.
- Preserve component-scoped customizer/editor services (`@Service({ autoProvided: false })` plus component providers); ordinary shared services use `@Service()` as established here.
- Admin strings use typed English keys and `I18n`/`TranslatePipe`; preserve locale fallback, RTL, focus handling, Shadow DOM isolation, and memory-only embedded navigation.
- Backend tenant ownership comes from verified credentials; preserve store-scoped parameterized SQL, the known-store check on public routes, private customer assets, and signed callback/token validation. Keep object-storage I/O outside database transactions.
- Database migrations in `worker-api/migrations/` are append-only (the one-time reset to the `0001_baseline.sql` baseline is the only exception). Never edit an applied migration or run migration/deployment commands as an incidental code check.
- Frontend checks: `npm run test:ci`, `npm run build`; element/contract changes: `npm run build:element`, `npm run test:types`, and relevant browser specs via `tests/browser/vitest.config.mts`. Browser tests require Chrome (`CHROME_PATH` overrides `/usr/bin/google-chrome`).
- Backend checks from `worker-api/`: `npm run typecheck`, `npm test`. Integration tests migrate/truncate a real database: use only a disposable `TEST_DATABASE_URL`, never a shared/staging/production database. Test suites intentionally disable file parallelism.
- Do not inspect secret files or generated/dependency directories for project context. Preserve unrelated user changes; check `git status` before editing.
