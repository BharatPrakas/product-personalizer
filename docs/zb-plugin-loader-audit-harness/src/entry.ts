import * as ng from './ng-stub';
import { Observable, BehaviorSubject } from 'rxjs';
import { ZbService } from './zb-service-stub';
import { CustomPluginsComponent } from '/home/centizen/Documents/Centizen Apps/zb-app/apps/zb-storeadmin/src/app/apps/components/custom-plugins.component';

type Env = Record<string, unknown>;
// HttpClient.get(url) analogue: JSON body, errors on non-2xx / network / bad JSON (same observable contract).
const http = { get: (url: string) => new Observable((s) => {
  fetch(url).then(async (r) => { if (!r.ok) throw new Error('HTTP ' + r.status); s.next(await r.json()); s.complete(); }).catch((e) => s.error(e));
}) };
const renderer = {
  createElement: (n: string) => document.createElement(n),
  appendChild: (p: Node, c: Node) => p.appendChild(c),
  removeChild: (p: Node, c: Node) => p.removeChild(c),
};
(window as any).__events = [];
const origDispatch = EventTarget.prototype.dispatchEvent;
EventTarget.prototype.dispatchEvent = function (e: Event) {
  if (/^(admin-|view-change|config-|mapping-)/.test(e.type)) (window as any).__events.push({ type: e.type, detail: (e as CustomEvent).detail, t: performance.now() });
  return origDispatch.call(this, e);
};
(window as any).host = {
  mount(env: Env, pluginName: string, zb?: unknown) {
    const params = new BehaviorSubject({ get: (k: string) => (k === 'pluginName' ? pluginName : null) });
    ng.providers.set(ng.ActivatedRoute, { paramMap: params });
    ng.providers.set(ng.HttpClient, http);
    ng.providers.set(ng.EnvService, { getEnvironment: () => env });
    ng.providers.set(ng.Renderer2, renderer);
    ng.providers.set(ng.ChangeDetectorRef, { detectChanges() {} });
    ng.providers.set(ZbService, zb ?? new ZbService());
    const c: any = new CustomPluginsComponent();
    const container = document.createElement('div'); container.id = 'plugin-container';
    document.getElementById('host')!.appendChild(container);
    c.pluginContainer = { nativeElement: container };
    c.ngOnInit();
    return { c, params, container };
  },
};
