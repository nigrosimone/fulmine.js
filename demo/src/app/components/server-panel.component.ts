import { Component, afterNextRender, signal } from '@angular/core';

interface Hello {
  message: string;
  fulmine: string;
  node: string;
  uptimeSeconds: number;
  requestsSinceBoot: number;
  cache: { hit: number; miss: number; stale: number; stored: number; entries: number };
}

interface Probe {
  mark: string;
  ms: number;
  bytes: number;
}

/**
 * The half of the page that is about the server rather than the weather. Everything it shows is
 * asked for from the browser, so a visitor can open DevTools and see the same numbers.
 */
@Component({
  selector: 'app-server-panel',
  template: `
    <section class="panel">
      <h2 class="section-title">Served by Fulmine</h2>

      @if (hello(); as h) {
        <dl class="panel__facts">
          <div>
            <dt>Fulmine</dt>
            <dd>{{ h.fulmine }}</dd>
          </div>
          <div>
            <dt>Node</dt>
            <dd>{{ h.node }}</dd>
          </div>
          <div>
            <dt>Uptime</dt>
            <dd>{{ h.uptimeSeconds }}s</dd>
          </div>
          <div>
            <dt>Requests</dt>
            <dd>{{ h.requestsSinceBoot }}</dd>
          </div>
          <div>
            <dt>Pages cached</dt>
            <dd>{{ h.cache.entries }}</dd>
          </div>
          <div>
            <dt>Hits / misses</dt>
            <dd>{{ h.cache.hit }} / {{ h.cache.miss }}</dd>
          </div>
        </dl>
      } @else {
        <p class="panel__muted">asking the server…</p>
      }

      <p class="panel__muted">
        This page is rendered on the server and kept by
        <a href="https://www.npmjs.com/package/ng-ssr-caching" target="_blank" rel="noopener"
          >ng-ssr-caching</a
        >. Ask for it again and watch the mark: a MISS renders it, a HIT replays it.
      </p>

      <div class="panel__buttons">
        <button type="button" class="search-button" (click)="probe()" [disabled]="busy()">
          Ask for this page again
        </button>
        <button type="button" class="panel__ghost" (click)="purge()" [disabled]="busy()">
          Purge the cache
        </button>
        <button type="button" class="panel__ghost" (click)="visit()" [disabled]="busy()">
          Session visits: {{ visits() ?? '?' }}
        </button>
      </div>

      @if (probes().length) {
        <ul class="panel__probes">
          @for (p of probes(); track $index) {
            <li>
              <span class="panel__mark" [class.panel__mark--hit]="p.mark === 'HIT'">{{
                p.mark
              }}</span>
              <span>{{ p.ms.toFixed(1) }} ms</span>
              <span class="panel__muted">{{ (p.bytes / 1024).toFixed(1) }} KB</span>
            </li>
          }
        </ul>
      }
    </section>
  `,
  styles: `
    .panel {
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-lg);
      padding: var(--space-lg);
      margin-bottom: var(--space-lg);
    }
    .panel__facts {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
      gap: var(--space-sm);
      margin: 0 0 var(--space-md);
    }
    .panel__facts dt {
      color: var(--color-text-muted);
      font-size: var(--font-size-xs);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .panel__facts dd {
      margin: 0;
      font-size: var(--font-size-base);
      font-variant-numeric: tabular-nums;
    }
    .panel__muted {
      color: var(--color-text-muted);
      font-size: var(--font-size-sm);
      margin: 0 0 var(--space-md);
    }
    /* the browser default link blue is 1.61:1 against this panel, which fails at any size */
    .panel a {
      color: var(--color-primary);
    }
    .panel__buttons {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-sm);
    }
    .panel__ghost {
      background: transparent;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      color: var(--color-text-secondary);
      cursor: pointer;
      font-family: inherit;
      font-size: var(--font-size-sm);
      padding: 0 var(--space-md);
    }
    .panel__ghost:hover:not(:disabled) {
      border-color: var(--color-primary);
      color: var(--color-primary);
    }
    .panel__probes {
      list-style: none;
      margin: var(--space-md) 0 0;
      padding: 0;
      font-size: var(--font-size-sm);
    }
    .panel__probes li {
      display: flex;
      gap: var(--space-md);
      padding: 0.15rem 0;
      font-variant-numeric: tabular-nums;
    }
    .panel__mark {
      font-weight: 700;
      min-width: 4.5rem;
      color: var(--color-warning);
    }
    .panel__mark--hit {
      color: var(--color-success);
    }
  `,
})
export class ServerPanelComponent {
  protected readonly hello = signal<Hello | null>(null);
  protected readonly probes = signal<Probe[]>([]);
  protected readonly visits = signal<number | null>(null);
  protected readonly busy = signal(false);

  constructor() {
    // never on the server: this panel is about what the browser can see for itself
    afterNextRender(() => this.refresh());
  }

  private async refresh(): Promise<void> {
    try {
      this.hello.set(await (await fetch('/api/hello')).json());
    } catch {
      // a demo panel that cannot reach its own server has nothing useful to say about it
    }
  }

  protected async probe(): Promise<void> {
    this.busy.set(true);
    try {
      const at = performance.now();
      const response = await fetch(location.pathname, { cache: 'no-store' });
      const body = await response.text();
      this.probes.update((list) =>
        [
          {
            mark: response.headers.get('x-ssr-cache') ?? 'none',
            ms: performance.now() - at,
            bytes: new Blob([body]).size,
          },
          ...list,
        ].slice(0, 6),
      );
      await this.refresh();
    } finally {
      this.busy.set(false);
    }
  }

  protected async purge(): Promise<void> {
    this.busy.set(true);
    try {
      await fetch('/api/cache/purge', { method: 'POST' });
      await this.refresh();
    } finally {
      this.busy.set(false);
    }
  }

  protected async visit(): Promise<void> {
    this.busy.set(true);
    try {
      const body = await (await fetch('/api/visits')).json();
      this.visits.set(body.visits);
    } finally {
      this.busy.set(false);
    }
  }
}
