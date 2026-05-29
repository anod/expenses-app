import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { DailyProjection, RecurringTemplate } from '@expenses/shared';

interface ChartPoint {
  x: number;
  y: number;
  title: string;
}

interface ChartBar {
  x: number;
  y: number;
  width: number;
  height: number;
  title: string;
}

interface LineSeries {
  key: 'required' | 'cc';
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
  legend: readonly { x: number; label: string; className: string }[];
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
    <svg
      class="balance-chart"
      [attr.viewBox]="'0 0 ' + chart().width + ' ' + chart().height"
      preserveAspectRatio="none"
      role="img"
      aria-label="Projected balance chart with expected spending bars and payment lines"
    >
      <text [attr.x]="chart().pad.left" y="14" class="chart-subtitle">
        Spending columns with balance and split-card payment lines
      </text>

      @for (item of chart().legend; track item.label) {
        <g>
          <line
            [attr.x1]="item.x"
            [attr.x2]="item.x + 22"
            y1="32"
            y2="32"
            [attr.class]="item.className"
          />
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
        >{{ tick.label }}</text>
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
          class="spending-bar"
        >
          <title>{{ bar.title }}</title>
        </rect>
      }

      @for (line of chart().lines; track line.key) {
        <path [attr.d]="line.path" [attr.class]="line.lineClass" />
        @for (pt of line.points; track $index) {
          <circle [attr.cx]="pt.x" [attr.cy]="pt.y" r="4.8" [attr.class]="line.pointClass">
            <title>{{ pt.title }}</title>
          </circle>
        }
      }

      @for (x of chart().xLabels; track x.key) {
        <text
          [attr.x]="x.x"
          [attr.y]="chart().height - 8"
          text-anchor="middle"
          class="axis-label"
        >{{ x.label }}</text>
      }

      <text
        [attr.x]="14"
        [attr.y]="chart().pad.top + (chart().plotBottom - chart().pad.top) / 2"
        transform="rotate(-90 14 160)"
        text-anchor="middle"
        class="axis-title"
      >Amount</text>
    </svg>
  `,
  styles: [`
    :host { display: block; width: 100%; }
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
    .spending-bar {
      fill: #d7c8f5;
      opacity: 0.92;
    }
    .series-required,
    .series-cc {
      fill: none;
      stroke-width: 3;
      stroke-linejoin: round;
      stroke-linecap: round;
    }
    .series-required {
      stroke: var(--md-sys-color-primary);
    }
    .series-cc {
      stroke: var(--md-sys-color-error);
    }
    .series-point {
      stroke: var(--md-sys-color-surface);
      stroke-width: 1.5;
    }
    .series-point-required {
      fill: var(--md-sys-color-primary);
    }
    .series-point-cc {
      fill: var(--md-sys-color-error);
    }
  `],
})
export class BalanceChartComponent {
  readonly days = input.required<readonly DailyProjection[]>();
  readonly templates = input<readonly RecurringTemplate[]>([]);

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
        { x: pad.left, label: 'Anchor balance', className: 'series-required' },
        { x: pad.left + 150, label: 'Split CC @ anchor', className: 'series-cc' },
      ],
    };

    const anchors = this.anchorData();
    if (anchors.length === 0) return empty;

    const xOf = (i: number): number =>
      pad.left + (anchors.length === 1 ? innerW / 2 : (i * innerW) / (anchors.length - 1));
    const maxBarWidth = 56;
    const barWidth = Math.min(maxBarWidth, Math.max(18, innerW / Math.max(anchors.length, 1) * 0.56));

    const values = anchors.flatMap((d) => [
      d.anchorBalance,
      d.expectedSpending,
      d.creditCardPayments,
    ]);
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
      const y = yOf(d.expectedSpending);
      const bottom = yOf(0);
      return {
        x: x - barWidth / 2,
        y: Math.min(y, bottom),
        width: barWidth,
        height: Math.max(2, Math.abs(bottom - y)),
        title: `${this.formatAnchorDate(d.date)} expected spending: ${this.formatAmount(d.expectedSpending)}`,
      };
    });

    const lineFor = (
      key: LineSeries['key'],
      label: string,
      value: (d: AnchorDatum) => number,
      lineClass: string,
      pointClass: string,
    ): LineSeries => {
      const points = anchors.map((d, i) => ({
        x: xOf(i),
        y: yOf(value(d)),
        title: `${this.formatAnchorDate(d.date)} ${label}: ${this.formatAmount(value(d))}`,
      }));
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
          'required',
          'Anchor balance',
          (d) => d.anchorBalance,
          'series-required',
          'series-point series-point-required',
        ),
        lineFor(
          'cc',
          'Split CC @ anchor',
          (d) => d.creditCardPayments,
          'series-cc',
          'series-point series-point-cc',
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
