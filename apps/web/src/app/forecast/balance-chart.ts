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
import type { DailyProjection, RecurringTemplate } from '@expenses/shared';
import type { TopLevelSpec } from 'vega-lite';
import type { View as VegaView } from 'vega';

interface AnchorDatum {
  date: string;
  anchorDateLabel: string;
  anchorBalance: number;
  expectedSpending: number;
  creditCardPayments: number;
}

const CHART_WIDTH = 680;
const CHART_HEIGHT = 320;
const ANCHOR_BALANCE_LABEL = 'Anchor balance';
const EXPECTED_SPENDING_LABEL = 'Expected spending';
const SPLIT_CC_LABEL = 'Split CC @ anchor';

@Component({
  selector: 'app-balance-chart',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="chart-wrap">
      <div
        #chartHost
        class="vega-chart"
        role="img"
        aria-label="Projected balance chart with anchor balance bars and expected spending line"
      ></div>

      @if (anchors().length === 0) {
        <p class="empty-chart">No anchor periods to chart yet.</p>
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
        min-height: 320px;
        font-family: var(--md-sys-font-plain);
      }
      .vega-chart:empty {
        display: none;
      }
      :host ::ng-deep .vega-chart svg,
      :host ::ng-deep .vega-chart canvas {
        display: block;
        width: 100%;
        height: 320px;
      }
      .empty-chart {
        display: grid;
        min-height: 320px;
        margin: 0;
        place-items: center;
        color: var(--md-sys-color-on-surface-variant);
        font: var(--md-sys-typescale-body-medium);
        background: var(--md-sys-color-surface);
      }
    `,
  ],
})
export class BalanceChartComponent {
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
  readonly templates = input<readonly RecurringTemplate[]>([]);
  protected readonly anchors = computed(() => this.anchorData());
  private readonly spec = computed<TopLevelSpec>(() => buildBalanceChartSpec(this.anchors()));

  constructor() {
    afterNextRender(() => {
      effect(
        (onCleanup) => {
          const anchors = this.anchors();
          const host = this.chartHost().nativeElement;
          const renderId = ++this.renderGeneration;
          let view: VegaView | null = null;

          if (anchors.length === 0) {
            host.replaceChildren();
            return;
          }

          void this.renderChart(host, this.spec(), renderId).then((renderedView) => {
            if (this.renderGeneration === renderId) {
              view = renderedView;
            } else {
              renderedView.finalize();
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
  ): Promise<VegaView> {
    const [{ View, parse }, { compile }, { Handler }] = await this.vegaModules;
    const runtime = parse(compile(spec).spec);
    const view = new View(runtime, {
      renderer: 'svg',
      tooltip: new Handler().call,
      hover: true,
    }).initialize(host);

    await view.runAsync();

    if (this.renderGeneration !== renderId) {
      view.finalize();
    }

    return view;
  }

  private anchorData(): AnchorDatum[] {
    const templateById = new Map(this.templates().map((t) => [t.id, t]));
    const anchors: AnchorDatum[] = [];
    let spendInPeriod = 0;
    let splitCcInPeriod = 0;

    for (const day of this.days()) {
      for (const charge of day.charges) {
        if (charge.amount >= 0) continue;

        spendInPeriod += Math.abs(charge.amount);
        if (charge.source.kind === 'cc-bill') {
          for (const entry of charge.source.billedEntries) {
            const template = entry.recurringId ? templateById.get(entry.recurringId) : undefined;
            if (template && template.channel !== 'bank' && template.endDate) {
              splitCcInPeriod += Math.abs(entry.amount);
            }
          }
        } else {
          const template = charge.source.recurringId
            ? templateById.get(charge.source.recurringId)
            : undefined;
          if (template && template.channel !== 'bank' && template.endDate) {
            splitCcInPeriod += Math.abs(charge.amount);
          }
        }
      }

      if (day.isAnchor) {
        anchors.push({
          date: day.date,
          anchorDateLabel: this.formatAnchorDate(day.date),
          anchorBalance: day.balance,
          expectedSpending: spendInPeriod,
          creditCardPayments: splitCcInPeriod,
        });
        spendInPeriod = 0;
        splitCcInPeriod = 0;
      }
    }

    return anchors;
  }

  private formatAnchorDate(iso: string): string {
    const d = new Date(`${iso}T00:00:00`);
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
}

function buildBalanceChartSpec(values: readonly AnchorDatum[]): TopLevelSpec {
  const x = {
    field: 'date',
    type: 'ordinal' as const,
    title: null,
    sort: { field: 'date', order: 'ascending' as const },
    scale: { paddingInner: 0.08, paddingOuter: 0.03 },
    axis: {
      labelAngle: 0,
      labelFontSize: 12,
      labelColor: '#49454f',
      labelExpr: "timeFormat(toDate(datum.label), '%b %d')",
    },
  };
  const color = {
    type: 'nominal' as const,
    scale: {
      domain: [ANCHOR_BALANCE_LABEL, EXPECTED_SPENDING_LABEL],
      range: ['#d7c8f5', '#006d75'],
    },
    legend: {
      orient: 'top' as const,
      title: null,
      labelFontSize: 12,
      symbolType: 'stroke' as const,
    },
  };

  return {
    $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
    description:
      'Anchor balance columns with expected spending as a line, rendered directly with Vega-Lite.',
    width: CHART_WIDTH,
    height: CHART_HEIGHT,
    autosize: { type: 'fit', contains: 'padding' },
    data: { values },
    transform: [
      {
        calculate: 'datum.creditCardPayments',
        as: 'splitCcAtAnchor',
      },
    ],
    layer: [
      {
        transform: [
          { calculate: `'${ANCHOR_BALANCE_LABEL}'`, as: 'metric' },
          { calculate: 'datum.anchorBalance', as: 'metricValue' },
        ],
        mark: {
          type: 'bar',
          cornerRadiusTopLeft: 5,
          cornerRadiusTopRight: 5,
          opacity: 0.96,
          width: 56,
          stroke: '#6750a4',
          strokeWidth: 0.9,
        },
        encoding: {
          x,
          y: {
            field: 'anchorBalance',
            type: 'quantitative',
            title: 'Amount',
            axis: { format: ',.0f', labelFontSize: 11 },
          },
          color: {
            datum: ANCHOR_BALANCE_LABEL,
            ...color,
          },
          tooltip: tooltipFields(),
        },
      },
      {
        transform: [
          { calculate: `'${EXPECTED_SPENDING_LABEL}'`, as: 'metric' },
          { calculate: 'datum.expectedSpending', as: 'metricValue' },
        ],
        mark: {
          type: 'line',
          strokeWidth: 3,
          interpolate: 'monotone',
          point: false,
        },
        encoding: {
          x,
          y: {
            field: 'expectedSpending',
            type: 'quantitative',
          },
          color: {
            datum: EXPECTED_SPENDING_LABEL,
            ...color,
          },
          tooltip: tooltipFields(),
        },
      },
      {
        transform: [
          { calculate: `'${EXPECTED_SPENDING_LABEL}'`, as: 'metric' },
          { calculate: 'datum.expectedSpending', as: 'metricValue' },
        ],
        mark: {
          type: 'point',
          filled: true,
          size: 72,
          stroke: '#fffbff',
          strokeWidth: 1.5,
        },
        encoding: {
          x,
          y: {
            field: 'expectedSpending',
            type: 'quantitative',
          },
          color: {
            datum: EXPECTED_SPENDING_LABEL,
            ...color,
            legend: null,
          },
          tooltip: tooltipFields(),
        },
      },
    ],
    config: {
      background: '#fffbff',
      view: { stroke: null },
      axis: {
        grid: true,
        gridColor: '#eee8f1',
        domain: false,
        tickColor: '#d7d0dd',
        labelColor: '#49454f',
        titleColor: '#49454f',
      },
      legend: {
        labelColor: '#49454f',
      },
    },
  };
}

function tooltipFields() {
  return [
    { field: 'anchorDateLabel', type: 'nominal' as const, title: 'Anchor period' },
    { field: 'metric', type: 'nominal' as const, title: 'Metric' },
    { field: 'metricValue', type: 'quantitative' as const, title: 'Amount', format: ',.0f' },
    {
      field: 'expectedSpending',
      type: 'quantitative' as const,
      title: EXPECTED_SPENDING_LABEL,
      format: ',.0f',
    },
    {
      field: 'anchorBalance',
      type: 'quantitative' as const,
      title: ANCHOR_BALANCE_LABEL,
      format: ',.0f',
    },
    {
      field: 'splitCcAtAnchor',
      type: 'quantitative' as const,
      title: SPLIT_CC_LABEL,
      format: ',.0f',
    },
  ];
}
