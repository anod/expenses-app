import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { DailyProjection } from '@expenses/shared';

interface ChartPoint {
  x: number;
  y: number;
  date: string;
  balance: number;
}

interface LegendItem {
  key: string;
  label: string;
  className: string;
}

interface ChartModel {
  width: number;
  height: number;
  pad: { top: number; right: number; bottom: number; left: number };
  innerW: number;
  innerH: number;
  legend: LegendItem[];
  points: ChartPoint[];
  linePath: string;
  areaPath: string;
  anchorTrendPath?: string;
  expenseTrendPath?: string;
  creditPaymentsPath?: string;
  minBalance: number;
  maxBalance: number;
  threshold?: number;
  thresholdY?: number;
  anchors: ChartPoint[];
  minPoint?: ChartPoint;
  xLabels: { x: number; label: string }[];
  yLabels: { y: number; label: string }[];
}

@Component({
  selector: 'app-balance-chart',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (chart().legend.length > 0) {
      <div class="chart-legend" aria-label="Chart legend">
        @for (item of chart().legend; track item.key) {
          <span class="legend-item">
            <span class="legend-swatch" [class]="item.className"></span>
            {{ item.label }}
          </span>
        }
      </div>
    }
    <svg
      class="balance-chart"
      [attr.viewBox]="'0 0 ' + chart().width + ' ' + chart().height"
      preserveAspectRatio="none"
      role="img"
      aria-label="Projected balance over horizon"
    >
      <defs>
        <linearGradient id="balance-area-gradient" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stop-color="var(--md-sys-color-primary)" stop-opacity="0.28" />
          <stop offset="100%" stop-color="var(--md-sys-color-primary)" stop-opacity="0" />
        </linearGradient>
      </defs>

      <!-- Y grid lines -->
      @for (g of chart().yLabels; track g.label) {
        <line
          [attr.x1]="chart().pad.left"
          [attr.x2]="chart().width - chart().pad.right"
          [attr.y1]="g.y"
          [attr.y2]="g.y"
          class="grid"
        />
        <text
          [attr.x]="chart().pad.left - 6"
          [attr.y]="g.y + 4"
          text-anchor="end"
          class="axis-label"
        >{{ g.label }}</text>
      }

      <!-- X labels -->
      @for (x of chart().xLabels; track x.label) {
        <text
          [attr.x]="x.x"
          [attr.y]="chart().height - 6"
          text-anchor="middle"
          class="axis-label"
        >{{ x.label }}</text>
      }

      <!-- Threshold line -->
      @if (chart().thresholdY != null) {
        <line
          [attr.x1]="chart().pad.left"
          [attr.x2]="chart().width - chart().pad.right"
          [attr.y1]="chart().thresholdY"
          [attr.y2]="chart().thresholdY"
          class="threshold"
        />
        <text
          [attr.x]="chart().width - chart().pad.right - 4"
          [attr.y]="chart().thresholdY! - 4"
          text-anchor="end"
          class="threshold-label"
        >threshold {{ formatShort(chart().threshold!) }}</text>
      }

      <!-- Area -->
      <path [attr.d]="chart().areaPath" fill="url(#balance-area-gradient)" />
      @if (chart().anchorTrendPath; as ap) {
        <path [attr.d]="ap" class="anchor-trend" />
      }
      @if (chart().expenseTrendPath; as ep) {
        <path [attr.d]="ep" class="expense-trend" />
      }
      @if (chart().creditPaymentsPath; as cp) {
        <path [attr.d]="cp" class="credit-payments-trend" />
      }
      <!-- Line -->
      <path [attr.d]="chart().linePath" class="line" />

      <!-- Anchor markers (10th of month) -->
      @for (a of chart().anchors; track a.date) {
        <circle [attr.cx]="a.x" [attr.cy]="a.y" r="3.5" class="anchor" />
      }

      <!-- Min balance marker -->
      @if (chart().minPoint; as mp) {
        <circle [attr.cx]="mp.x" [attr.cy]="mp.y" r="5" class="min-marker" />
        <text
          [attr.x]="mp.x"
          [attr.y]="mp.y - 10"
          text-anchor="middle"
          class="min-label"
        >min {{ formatShort(mp.balance) }}</text>
      }
    </svg>
  `,
  styles: [`
    :host { display: block; width: 100%; }
    .chart-legend {
      display: flex;
      flex-wrap: wrap;
      gap: 0.75rem 1rem;
      margin: 0 0 0.35rem;
      color: var(--md-sys-color-on-surface-variant);
      font-size: 12px;
    }
    .legend-item {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      white-space: nowrap;
    }
    .legend-swatch {
      width: 18px;
      height: 0;
      border-top-width: 2px;
      border-top-style: solid;
      border-radius: 999px;
      opacity: 0.95;
    }
    .legend-swatch.balance-line { border-top-color: var(--md-sys-color-primary); }
    .legend-swatch.anchor-line { border-top-color: var(--md-sys-color-tertiary); }
    .legend-swatch.expense-line {
      border-top-color: var(--md-sys-color-secondary);
      border-top-style: dashed;
    }
    .legend-swatch.credit-line {
      border-top-color: var(--md-sys-color-error);
      border-top-style: dashed;
    }
    .balance-chart {
      display: block;
      width: 100%;
      height: 240px;
      font-family: var(--md-sys-font-plain);
    }
    .grid {
      stroke: var(--md-sys-color-outline-variant);
      stroke-width: 1;
      stroke-dasharray: 2 3;
    }
    .axis-label {
      fill: var(--md-sys-color-on-surface-variant);
      font-size: 10px;
    }
    .line {
      fill: none;
      stroke: var(--md-sys-color-primary);
      stroke-width: 2;
      stroke-linejoin: round;
      stroke-linecap: round;
    }
    .anchor-trend {
      fill: none;
      stroke: var(--md-sys-color-tertiary);
      stroke-width: 1.75;
      stroke-linejoin: round;
      stroke-linecap: round;
      opacity: 0.75;
    }
    .expense-trend {
      fill: none;
      stroke: var(--md-sys-color-secondary);
      stroke-width: 1.5;
      stroke-dasharray: 6 4;
      opacity: 0.9;
    }
    .credit-payments-trend {
      fill: none;
      stroke: var(--md-sys-color-error);
      stroke-width: 1.5;
      stroke-dasharray: 3 4;
      opacity: 0.8;
    }
    .threshold {
      stroke: var(--md-sys-color-error);
      stroke-width: 1.25;
      stroke-dasharray: 4 4;
      opacity: 0.7;
    }
    .threshold-label {
      fill: var(--md-sys-color-error);
      font-size: 10px;
      font-weight: 500;
    }
    .anchor {
      fill: var(--md-sys-color-tertiary);
      stroke: var(--md-sys-color-surface);
      stroke-width: 1.5;
    }
    .min-marker {
      fill: var(--md-sys-color-error);
      stroke: var(--md-sys-color-surface);
      stroke-width: 2;
    }
    .min-label {
      fill: var(--md-sys-color-on-surface);
      font-size: 11px;
      font-weight: 600;
    }
  `],
})
export class BalanceChartComponent {
  readonly days = input.required<readonly DailyProjection[]>();
  readonly threshold = input<number | null>(null);
  readonly minBalanceDate = input<string | null>(null);

  protected readonly chart = computed<ChartModel>(() => {
    const days = this.days();
    const width = 800;
    const height = 240;
    const pad = { top: 24, right: 16, bottom: 24, left: 56 };
    const innerW = width - pad.left - pad.right;
    const innerH = height - pad.top - pad.bottom;

    if (days.length === 0) {
      return {
        width, height, pad, innerW, innerH,
        legend: [],
        points: [], linePath: '', areaPath: '',
        minBalance: 0, maxBalance: 0,
        anchors: [], xLabels: [], yLabels: [],
      };
    }

    const balances = days.map((d) => d.balance);
    const threshold = this.threshold();
    const n = days.length;
    const xOf = (i: number) =>
      pad.left + (n === 1 ? innerW / 2 : (i * innerW) / (n - 1));

    const openingBalance = balances[0]!;
    let expenseBalance = openingBalance;
    let creditPaymentsBalance = openingBalance;
    let hasExpenseTrend = false;
    let hasCreditPayments = false;
    const expenseTrendValues: number[] = [];
    const creditPaymentsValues: number[] = [];
    for (const day of days) {
      let expenseOutflow = 0;
      let creditPaymentOutflow = 0;
      for (const charge of day.charges) {
        if (charge.amount >= 0) continue;
        const outflow = Math.abs(charge.amount);
        if (charge.source.kind === 'cc-bill') {
          creditPaymentOutflow += outflow;
        } else {
          expenseOutflow += outflow;
        }
      }
      if (expenseOutflow > 0) hasExpenseTrend = true;
      if (creditPaymentOutflow > 0) hasCreditPayments = true;
      expenseBalance -= expenseOutflow;
      creditPaymentsBalance -= creditPaymentOutflow;
      expenseTrendValues.push(expenseBalance);
      creditPaymentsValues.push(creditPaymentsBalance);
    }

    const overlayCandidates = [
      ...balances,
      ...(hasExpenseTrend ? expenseTrendValues : []),
      ...(hasCreditPayments ? creditPaymentsValues : []),
      ...(threshold != null ? [threshold] : []),
      0,
    ];
    let minB = Math.min(...overlayCandidates);
    let maxB = Math.max(...overlayCandidates);
    if (minB === maxB) { minB -= 1; maxB += 1; }
    const padR = (maxB - minB) * 0.1;
    minB -= padR;
    maxB += padR;

    const yOf = (v: number) =>
      pad.top + innerH - ((v - minB) / (maxB - minB)) * innerH;

    const points: ChartPoint[] = days.map((d, i) => ({
      x: xOf(i),
      y: yOf(d.balance),
      date: d.date,
      balance: d.balance,
    }));

    const linePath = points
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
      .join(' ');

    const bottom = pad.top + innerH;
    const first = points[0]!;
    const last = points[points.length - 1]!;
    const areaPath =
      `M${first.x.toFixed(1)},${bottom.toFixed(1)} ` +
      points.map((p) => `L${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ') +
      ` L${last.x.toFixed(1)},${bottom.toFixed(1)} Z`;

    const anchors = points.filter((_, i) => days[i]!.isAnchor);
    const pathOf = (vals: readonly number[]): string =>
      vals
        .map((v, i) => `${i === 0 ? 'M' : 'L'}${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`)
        .join(' ');
    const anchorTrendPath = anchors.length >= 2
      ? anchors
          .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
          .join(' ')
      : undefined;
    const expenseTrendPath = hasExpenseTrend ? pathOf(expenseTrendValues) : undefined;
    const creditPaymentsPath = hasCreditPayments ? pathOf(creditPaymentsValues) : undefined;

    const minDate = this.minBalanceDate();
    const minPoint = minDate ? points.find((p) => p.date === minDate) : undefined;

    // Y axis labels (4 ticks)
    const yLabels = [0, 1, 2, 3].map((k) => {
      const v = maxB - ((maxB - minB) * k) / 3;
      return { y: yOf(v), label: this.formatShort(v) };
    });

    // X axis labels: first day of each month present in the series
    const xLabels: { x: number; label: string }[] = [];
    const seenMonths = new Set<string>();
    points.forEach((p, i) => {
      const ym = p.date.slice(0, 7);
      if (!seenMonths.has(ym)) {
        seenMonths.add(ym);
        xLabels.push({ x: p.x, label: this.monthLabel(p.date) });
      }
      // Suppress unused var warnings
      void i;
    });

    return {
      width, height, pad, innerW, innerH,
      legend: [
        { key: 'balance', label: 'balance', className: 'balance-line' },
        ...(anchorTrendPath ? [{ key: 'anchors', label: 'anchors', className: 'anchor-line' }] : []),
        ...(expenseTrendPath ? [{ key: 'expenses', label: 'expenses', className: 'expense-line' }] : []),
        ...(creditPaymentsPath ? [{ key: 'credit', label: 'credit payments', className: 'credit-line' }] : []),
      ],
      points, linePath, areaPath,
      ...(anchorTrendPath ? { anchorTrendPath } : {}),
      ...(expenseTrendPath ? { expenseTrendPath } : {}),
      ...(creditPaymentsPath ? { creditPaymentsPath } : {}),
      minBalance: Math.min(...balances),
      maxBalance: Math.max(...balances),
      ...(threshold != null ? { threshold, thresholdY: yOf(threshold) } : {}),
      anchors,
      ...(minPoint ? { minPoint } : {}),
      xLabels,
      yLabels,
    };
  });

  protected formatShort(v: number): string {
    const abs = Math.abs(v);
    if (abs >= 1000) {
      return `${(v / 1000).toFixed(abs >= 10000 ? 0 : 1)}k`;
    }
    return v.toFixed(0);
  }

  protected monthLabel(iso: string): string {
    const d = new Date(`${iso}T00:00:00`);
    return d.toLocaleString('en-US', { month: 'short' });
  }
}
