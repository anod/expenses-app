import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  viewChild,
} from '@angular/core';
import { type DailyProjection, descriptionLabel } from '@expenses/shared';
import type { TopLevelSpec } from 'vega-lite';
import type { View as VegaView } from 'vega';

interface DayDatum {
  date: string;
  balance: number;
  delta: number;
  desc: string;
  isAnchor: boolean;
  hasCharges: boolean;
}

const CHART_WIDTH = 680;
const CHART_HEIGHT = 340;
const CHART_BG = '#211f26';
const CHART_GRID = '#49454f';
const CHART_TEXT = '#e6e0e9';
const CHART_MUTED_TEXT = '#cac4d0';
const BALANCE_LINE = '#a895c7';
const BALANCE_FILL = '#7d6d9c';
const THRESHOLD_COLOR = '#f2b8b5';
const TODAY_COLOR = '#8bd5ff';
const SPEND_COLOR = '#f6c177';
const ANCHOR_COLOR = '#d0bcff';

/**
 * Daily running bank-balance line for the *current* anchor period — the
 * forecast days from today through (and including) the next anchor day.
 * Shows the threshold, a "Today" marker, a dot on every charge day, and an
 * explicit labelled value at the final anchor.
 */
@Component({
  selector: 'app-period-balance-chart',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="chart-wrap">
      <div
        #chartHost
        class="vega-chart"
        role="img"
        aria-label="Daily bank balance for the current period with today and next-anchor markers"
      ></div>

      @if (data().length === 0) {
        <p class="empty-chart">No days in the current period to chart yet.</p>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        width: 100%;
      }
      .chart-wrap {
        position: relative;
        width: 100%;
      }
      .vega-chart {
        font-family: var(--md-sys-font-plain);
      }
      .vega-chart:empty {
        display: none;
      }
      :host ::ng-deep .vega-chart svg,
      :host ::ng-deep .vega-chart canvas {
        display: block;
        width: 100%;
        height: auto;
        border-radius: var(--md-sys-shape-corner-md);
      }
      .empty-chart {
        display: grid;
        min-height: 340px;
        margin: 0;
        place-items: center;
        color: var(--md-sys-color-on-surface-variant);
        font: var(--md-sys-typescale-body-medium);
        background: var(--md-sys-color-surface);
      }
      @media (max-width: 560px) {
        .empty-chart {
          min-height: 220px;
        }
      }
    `,
  ],
})
export class PeriodBalanceChartComponent {
  private readonly chartHost = viewChild.required<ElementRef<HTMLElement>>('chartHost');
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly vegaModules = Promise.all([
    import('vega'),
    import('vega-lite'),
    import('vega-tooltip'),
  ]);
  private renderGeneration = 0;

  readonly days = input.required<readonly DailyProjection[]>();
  readonly threshold = input<number>(0);
  readonly todayIso = input<string>('');

  protected readonly data = computed<DayDatum[]>(() =>
    this.days().map((d) => ({
      date: d.date,
      balance: d.balance,
      delta: d.delta,
      isAnchor: d.isAnchor,
      hasCharges: d.charges.length > 0,
      desc:
        d.charges.length > 0
          ? d.charges.map((c) => descriptionLabel(c.description)).join(', ')
          : 'No change',
    })),
  );

  private readonly spec = computed<TopLevelSpec>(() =>
    buildPeriodChartSpec(this.data(), this.threshold(), this.resolvedToday()),
  );

  private resolvedToday(): string {
    return this.todayIso() || this.data()[0]?.date || '';
  }

  constructor() {
    afterNextRender(() => {
      effect(
        (onCleanup) => {
          const data = this.data();
          const host = this.chartHost().nativeElement;
          const renderId = ++this.renderGeneration;
          let view: VegaView | null = null;

          if (data.length === 0) {
            host.replaceChildren();
            return;
          }

          void this.renderChart(host, this.spec(), renderId).then((renderedView) => {
            if (renderedView && this.renderGeneration === renderId) {
              view = renderedView;
            } else {
              renderedView?.finalize();
            }
          });

          onCleanup(() => {
            this.renderGeneration++;
            view?.finalize();
            host.replaceChildren();
          });
        },
        { injector: this.injector },
      );
    });

    this.destroyRef.onDestroy(() => {
      this.renderGeneration++;
    });
  }

  private async renderChart(
    host: HTMLElement,
    spec: TopLevelSpec,
    renderId: number,
  ): Promise<VegaView | null> {
    const [{ View, parse }, { compile }, { Handler }] = await this.vegaModules;
    // A newer render (or teardown) may have superseded us while the dynamic
    // vega modules were loading; bail before touching the host DOM.
    if (this.renderGeneration !== renderId) {
      return null;
    }
    const runtime = parse(compile(spec).spec);
    const view = new View(runtime, {
      renderer: 'svg',
      tooltip: new Handler().call,
      hover: true,
    }).initialize(host);

    await view.runAsync();

    if (this.renderGeneration !== renderId) {
      view.finalize();
      // We initialised into `host` after a cleanup cleared it; drop the
      // now-stale SVG so it can't linger behind the active render.
      host.replaceChildren();
      return null;
    }

    return view;
  }
}

function buildPeriodChartSpec(
  values: readonly DayDatum[],
  threshold: number,
  todayIso: string,
): TopLevelSpec {
  const chargeDays = values.filter((d) => d.hasCharges);
  const last = values[values.length - 1];
  const anchorDatum =
    last && last.isAnchor ? [{ ...last, label: formatAmount(last.balance) }] : [];

  const x = {
    field: 'date',
    type: 'temporal' as const,
    title: null,
    axis: { format: '%b %d', tickCount: 8, labelFontSize: 11, labelColor: CHART_MUTED_TEXT },
  };
  const y = {
    field: 'balance',
    type: 'quantitative' as const,
    title: 'Bank balance',
    axis: { format: ',.0f', labelFontSize: 11 },
  };
  const dayTooltip = [
    { field: 'date', type: 'temporal' as const, title: 'Date', format: '%b %d, %Y' },
    { field: 'balance', type: 'quantitative' as const, title: 'Balance', format: ',.0f' },
    { field: 'desc', type: 'nominal' as const, title: 'Charge' },
    { field: 'delta', type: 'quantitative' as const, title: 'Change', format: ',.0f' },
  ];

  const layer = [
    {
      data: { values: [{ t: threshold }] },
      mark: { type: 'rule', color: THRESHOLD_COLOR, strokeDash: [4, 4], strokeWidth: 1.5 },
      encoding: { y: { field: 't', type: 'quantitative' } },
    },
    {
      data: { values: [{ t: threshold }] },
      mark: { type: 'text', color: THRESHOLD_COLOR, align: 'left', dx: 4, dy: -6, fontSize: 10 },
      encoding: {
        y: { field: 't', type: 'quantitative' },
        text: { value: `Threshold ${formatAmount(threshold)}` },
      },
    },
    {
      mark: {
        type: 'area',
        line: { color: BALANCE_LINE, strokeWidth: 3 },
        color: BALANCE_FILL,
        opacity: 0.18,
        interpolate: 'monotone',
      },
      encoding: { x, y },
    },
    {
      mark: { type: 'point', filled: true, size: 36, opacity: 0, color: BALANCE_LINE },
      encoding: { x, y, tooltip: dayTooltip },
    },
    {
      data: { values: chargeDays },
      mark: { type: 'point', filled: true, size: 80, color: SPEND_COLOR, stroke: CHART_BG, strokeWidth: 1.5 },
      encoding: { x, y, tooltip: dayTooltip },
    },
    ...(todayIso
      ? [
          {
            data: { values: [{ d: todayIso }] },
            mark: { type: 'rule', color: TODAY_COLOR, strokeWidth: 2 },
            encoding: { x: { field: 'd', type: 'temporal' } },
          },
          {
            data: { values: [{ d: todayIso }] },
            mark: { type: 'text', color: TODAY_COLOR, dy: -160, fontSize: 11, fontWeight: 'bold' },
            encoding: { x: { field: 'd', type: 'temporal' }, text: { value: 'Today' } },
          },
        ]
      : []),
    ...(anchorDatum.length > 0
      ? [
          {
            data: { values: anchorDatum },
            mark: { type: 'point', filled: true, size: 150, color: ANCHOR_COLOR, stroke: CHART_BG, strokeWidth: 2 },
            encoding: { x, y, tooltip: dayTooltip },
          },
          {
            data: { values: anchorDatum },
            mark: { type: 'text', color: ANCHOR_COLOR, align: 'right', dx: -8, dy: -12, fontSize: 13, fontWeight: 'bold' },
            encoding: { x, y, text: { field: 'label', type: 'nominal' } },
          },
          {
            data: { values: anchorDatum },
            mark: { type: 'text', color: CHART_MUTED_TEXT, align: 'right', dx: -8, dy: 4, fontSize: 10 },
            encoding: { x, y, text: { value: 'Next anchor' } },
          },
        ]
      : []),
  ];

  return {
    $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
    description:
      'Daily running bank balance for the current anchor period with threshold, today marker and an explicit next-anchor value.',
    width: CHART_WIDTH,
    height: CHART_HEIGHT,
    autosize: { type: 'fit', contains: 'padding' },
    data: { values },
    layer,
    config: {
      background: CHART_BG,
      view: { stroke: null },
      axis: {
        grid: true,
        gridColor: CHART_GRID,
        gridOpacity: 0.55,
        domain: false,
        tickColor: CHART_GRID,
        labelColor: CHART_MUTED_TEXT,
        titleColor: CHART_TEXT,
      },
      legend: { labelColor: CHART_MUTED_TEXT },
    },
  } as TopLevelSpec;
}

function formatAmount(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value);
}
