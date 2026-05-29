import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import type { DailyProjection, RecurringTemplate } from '@expenses/shared';

interface ChartTooltip {
  x: number;
  y: number;
  title: string;
  rows: readonly { label: string; value: string }[];
}

interface ChartPoint {
  x: number;
  y: number;
  ariaLabel: string;
  tooltip: Omit<ChartTooltip, 'x' | 'y'>;
}

interface ChartBar {
  x: number;
  y: number;
  width: number;
  height: number;
  ariaLabel: string;
  tooltip: Omit<ChartTooltip, 'x' | 'y'>;
}

interface LineSeries {
  key: 'spending';
  label: string;
  path: string;
  lineClass: string;
  pointClass: string;
  points: readonly ChartPoint[];
}

interface ChartModel {
  width: number;
  height: number;
  pad: { top: number; right: number; bottom: number; left: number };
  bars: readonly ChartBar[];
  lines: readonly LineSeries[];
  xLabels: readonly { x: number; key: string; label: string }[];
  yTicks: readonly { y: number; label: string }[];
  zeroY: number;
  plotBottom: number;
  legend: readonly { x: number; label: string; className: string; kind: 'bar' | 'line' }[];
}

interface AnchorDatum {
  date: string;
  anchorBalance: number;
  expectedSpending: number;
  creditCardPayments: number;
}

@Component({
  selector: 'app-balance-chart',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="chart-wrap" (pointerleave)="hideTooltip()" (blur)="hideTooltip()" tabindex="-1">
      <svg
        class="balance-chart"
        [attr.viewBox]="'0 0 ' + chart().width + ' ' + chart().height"
        preserveAspectRatio="none"
        role="img"
        aria-label="Projected balance chart with anchor balance bars and expected spending line"
      >
        <text [attr.x]="chart().pad.left" y="14" class="chart-subtitle">
          Anchor balance columns with expected spending line
        </text>

        @for (item of chart().legend; track item.label) {
          <g>
            @if (item.kind === 'bar') {
              <rect
                [attr.x]="item.x"
                y="25"
                width="22"
                height="12"
                rx="3"
                [attr.class]="item.className"
              />
            } @else {
              <line
                [attr.x1]="item.x"
                [attr.x2]="item.x + 22"
                y1="32"
                y2="32"
                [attr.class]="item.className"
              />
            }
            <text [attr.x]="item.x + 28" y="36" class="legend-label">{{ item.label }}</text>
          </g>
        }

        @for (tick of chart().yTicks; track tick.label) {
          <line
            [attr.x1]="chart().pad.left"
            [attr.x2]="chart().width - chart().pad.right"
            [attr.y1]="tick.y"
            [attr.y2]="tick.y"
            class="grid-line"
          />
          <text
            [attr.x]="chart().pad.left - 8"
            [attr.y]="tick.y + 4"
            text-anchor="end"
            class="axis-label"
          >
            {{ tick.label }}
          </text>
        }

        <line
          [attr.x1]="chart().pad.left"
          [attr.x2]="chart().width - chart().pad.right"
          [attr.y1]="chart().zeroY"
          [attr.y2]="chart().zeroY"
          class="zero-line"
        />

        @for (bar of chart().bars; track $index) {
          <rect
            [attr.x]="bar.x"
            [attr.y]="bar.y"
            [attr.width]="bar.width"
            [attr.height]="bar.height"
            rx="5"
            ry="5"
            tabindex="0"
            class="balance-bar"
            [attr.aria-label]="bar.ariaLabel"
            (pointerenter)="showPointerTooltip($event, bar.tooltip)"
            (pointermove)="showPointerTooltip($event, bar.tooltip)"
            (focus)="showChartTooltip(bar.tooltip, bar.x + bar.width / 2, bar.y)"
            (blur)="hideTooltip()"
          />
        }

        @for (line of chart().lines; track line.key) {
          <path [attr.d]="line.path" [attr.class]="line.lineClass" />
          @for (pt of line.points; track $index) {
            <circle
              [attr.cx]="pt.x"
              [attr.cy]="pt.y"
              r="4.8"
              tabindex="0"
              [attr.class]="line.pointClass"
              [attr.aria-label]="pt.ariaLabel"
              (pointerenter)="showPointerTooltip($event, pt.tooltip)"
              (pointermove)="showPointerTooltip($event, pt.tooltip)"
              (focus)="showChartTooltip(pt.tooltip, pt.x, pt.y)"
              (blur)="hideTooltip()"
            />
          }
        }

        @for (x of chart().xLabels; track x.key) {
          <text
            [attr.x]="x.x"
            [attr.y]="chart().height - 8"
            text-anchor="middle"
            class="axis-label"
          >
            {{ x.label }}
          </text>
        }

        <text
          [attr.x]="14"
          [attr.y]="chart().pad.top + (chart().plotBottom - chart().pad.top) / 2"
          transform="rotate(-90 14 160)"
          text-anchor="middle"
          class="axis-title"
        >
          Amount
        </text>
      </svg>

      @if (tooltip(); as tip) {
        <div class="chart-tooltip" role="tooltip" [style.left.px]="tip.x" [style.top.px]="tip.y">
          <div class="tooltip-title">{{ tip.title }}</div>
          @for (row of tip.rows; track row.label) {
            <div class="tooltip-row">
              <span>{{ row.label }}</span>
              <strong>{{ row.value }}</strong>
            </div>
          }
        </div>
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
      .balance-chart {
        display: block;
        width: 100%;
        height: 320px;
        font-family: var(--md-sys-font-plain);
        background: var(--md-sys-color-surface);
      }
      .chart-subtitle,
      .legend-label,
      .axis-label,
      .axis-title {
        fill: var(--md-sys-color-on-surface-variant);
      }
      .chart-subtitle {
        font-size: 12px;
      }
      .legend-label,
      .axis-label {
        font-size: 11px;
      }
      .axis-title {
        font-size: 11px;
        font-weight: 500;
      }
      .grid-line {
        stroke: var(--md-sys-color-surface-container-highest);
        stroke-width: 1;
      }
      .zero-line {
        stroke: var(--md-sys-color-outline-variant);
        stroke-width: 1.2;
      }
      .balance-bar {
        fill: var(--md-sys-color-primary-container);
        stroke: var(--md-sys-color-primary);
        stroke-width: 0.9;
        opacity: 0.96;
        cursor: pointer;
      }
      .series-spending {
        fill: none;
        stroke: var(--md-sys-color-tertiary);
        stroke-width: 3;
        stroke-linejoin: round;
        stroke-linecap: round;
      }
      .series-point {
        stroke: var(--md-sys-color-surface);
        stroke-width: 1.5;
        cursor: pointer;
      }
      .series-point-spending {
        fill: var(--md-sys-color-tertiary);
      }
      .balance-bar:focus-visible,
      .series-point:focus-visible {
        outline: none;
        stroke: var(--md-sys-color-on-surface);
        stroke-width: 2;
      }
      .chart-tooltip {
        position: absolute;
        z-index: 1;
        min-width: 180px;
        max-width: min(260px, calc(100% - 16px));
        padding: 0.65rem 0.75rem;
        border-radius: var(--md-sys-shape-corner-md);
        background: var(--md-sys-color-inverse-surface);
        color: var(--md-sys-color-inverse-on-surface);
        box-shadow: var(--md-sys-elevation-3);
        font: var(--md-sys-typescale-body-small);
        pointer-events: none;
        transform: translate(10px, calc(-100% - 10px));
      }
      .tooltip-title {
        margin-bottom: 0.45rem;
        font: var(--md-sys-typescale-label-large);
      }
      .tooltip-row {
        display: flex;
        justify-content: space-between;
        gap: 1rem;
        font-variant-numeric: tabular-nums;
      }
      .tooltip-row + .tooltip-row {
        margin-top: 0.25rem;
      }
    `,
  ],
})
export class BalanceChartComponent {
  private readonly host = inject(ElementRef<HTMLElement>);

  readonly days = input.required<readonly DailyProjection[]>();
  readonly templates = input<readonly RecurringTemplate[]>([]);
  protected readonly tooltip = signal<ChartTooltip | null>(null);

  protected readonly chart = computed<ChartModel>(() => {
    const width = 680;
    const height = 320;
    const pad = { top: 52, right: 18, bottom: 34, left: 58 };
    const plotBottom = height - pad.bottom;
    const innerW = width - pad.left - pad.right;
    const innerH = plotBottom - pad.top;
    const empty: ChartModel = {
      width,
      height,
      pad,
      bars: [],
      lines: [],
      xLabels: [],
      yTicks: [],
      zeroY: plotBottom,
      plotBottom,
      legend: [
        { x: pad.left, label: 'Anchor balance', className: 'balance-bar', kind: 'bar' },
        {
          x: pad.left + 150,
          label: 'Expected spending',
          className: 'series-spending',
          kind: 'line',
        },
      ],
    };

    const anchors = this.anchorData();
    if (anchors.length === 0) return empty;

    const xOf = (i: number): number =>
      pad.left + (anchors.length === 1 ? innerW / 2 : (i * innerW) / (anchors.length - 1));
    const maxBarWidth = 56;
    const barWidth = Math.min(
      maxBarWidth,
      Math.max(18, (innerW / Math.max(anchors.length, 1)) * 0.56),
    );

    const values = anchors.flatMap((d) => [d.anchorBalance, d.expectedSpending]);
    const domain = this.valueDomain(values);
    const yOf = (v: number): number =>
      plotBottom - ((v - domain.min) / (domain.max - domain.min)) * innerH;
    const zeroY = yOf(0);
    const yTicks = this.ticks(domain.min, domain.max).map((value) => ({
      y: yOf(value),
      label: this.formatShort(value),
    }));

    const bars = anchors.map((d, i) => {
      const x = xOf(i);
      const y = yOf(d.anchorBalance);
      const bottom = yOf(0);
      const tooltip = this.anchorTooltip(d, 'Anchor balance', d.anchorBalance);
      return {
        x: x - barWidth / 2,
        y: Math.min(y, bottom),
        width: barWidth,
        height: Math.max(2, Math.abs(bottom - y)),
        ariaLabel: `${this.formatAnchorDate(d.date)} anchor balance ${this.formatAmount(d.anchorBalance)}`,
        tooltip,
      };
    });

    const lineFor = (
      key: LineSeries['key'],
      label: string,
      value: (d: AnchorDatum) => number,
      lineClass: string,
      pointClass: string,
    ): LineSeries => {
      const points = anchors.map((d, i) => {
        const amount = value(d);
        return {
          x: xOf(i),
          y: yOf(amount),
          ariaLabel: `${this.formatAnchorDate(d.date)} ${label} ${this.formatAmount(amount)}`,
          tooltip: this.anchorTooltip(d, label, amount),
        };
      });
      return {
        key,
        label,
        path: this.linePath(points),
        lineClass,
        pointClass,
        points,
      };
    };

    return {
      width,
      height,
      pad,
      plotBottom,
      zeroY,
      bars,
      lines: [
        lineFor(
          'spending',
          'Expected spending',
          (d) => d.expectedSpending,
          'series-spending',
          'series-point series-point-spending',
        ),
      ],
      xLabels: anchors.map((d, i) => ({ x: xOf(i), key: d.date, label: this.anchorLabel(d.date) })),
      yTicks,
      legend: empty.legend,
    };
  });

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

  private valueDomain(values: readonly number[]): { min: number; max: number } {
    const minValue = Math.min(0, ...values);
    const maxValue = Math.max(0, ...values);
    if (minValue === maxValue) {
      return { min: minValue - 1, max: maxValue + 1 };
    }

    const span = maxValue - minValue;
    return {
      min: Math.floor((minValue - span * 0.08) / 100) * 100,
      max: Math.ceil((maxValue + span * 0.08) / 100) * 100,
    };
  }

  protected showPointerTooltip(event: PointerEvent, tooltip: Omit<ChartTooltip, 'x' | 'y'>): void {
    const rect = this.host.nativeElement.getBoundingClientRect();
    this.tooltip.set({
      ...tooltip,
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    });
  }

  protected showChartTooltip(
    tooltip: Omit<ChartTooltip, 'x' | 'y'>,
    chartX: number,
    chartY: number,
  ): void {
    const svg = this.host.nativeElement.querySelector('svg');
    if (!svg) return;

    const rect = svg.getBoundingClientRect();
    const model = this.chart();
    this.tooltip.set({
      ...tooltip,
      x: (chartX / model.width) * rect.width,
      y: (chartY / model.height) * rect.height,
    });
  }

  protected hideTooltip(): void {
    this.tooltip.set(null);
  }

  private anchorTooltip(
    datum: AnchorDatum,
    metricLabel: string,
    metricValue: number,
  ): Omit<ChartTooltip, 'x' | 'y'> {
    const otherRows = [
      { label: 'Expected spending', value: this.formatAmount(datum.expectedSpending) },
      { label: 'Anchor balance', value: this.formatAmount(datum.anchorBalance) },
      { label: 'Split CC @ anchor', value: this.formatAmount(datum.creditCardPayments) },
    ].filter((row) => row.label !== metricLabel);

    return {
      title: this.formatAnchorDate(datum.date),
      rows: [{ label: metricLabel, value: this.formatAmount(metricValue) }, ...otherRows],
    };
  }

  private ticks(min: number, max: number): number[] {
    const count = 5;
    const step = (max - min) / (count - 1);
    return Array.from({ length: count }, (_, i) => min + step * i);
  }

  private linePath(points: readonly ChartPoint[]): string {
    return points
      .map((pt, i) => `${i === 0 ? 'M' : 'L'}${pt.x.toFixed(1)},${pt.y.toFixed(1)}`)
      .join(' ');
  }

  protected formatShort(v: number): string {
    const abs = Math.abs(v);
    if (abs >= 1000) {
      return `${(v / 1000).toFixed(abs >= 10000 ? 0 : 1)}k`;
    }
    return v.toFixed(0);
  }

  private formatAmount(v: number): string {
    return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
  }

  private anchorLabel(iso: string): string {
    const d = new Date(`${iso}T00:00:00`);
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric' });
  }

  private formatAnchorDate(iso: string): string {
    const d = new Date(`${iso}T00:00:00`);
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
}
