import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { DailyProjection } from '@expenses/shared';

interface ChartPoint {
  x: number;
  y: number;
  date: string;
  balance: number;
}

interface ChartModel {
  width: number;
  height: number;
  pad: { top: number; right: number; bottom: number; left: number };
  innerW: number;
  innerH: number;
  points: ChartPoint[];
  linePath: string;
  areaPath: string;
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
        >threshold</text>
      }

      <!-- Area -->
      <path [attr.d]="chart().areaPath" fill="url(#balance-area-gradient)" />
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
        points: [], linePath: '', areaPath: '',
        minBalance: 0, maxBalance: 0,
        anchors: [], xLabels: [], yLabels: [],
      };
    }

    const balances = days.map((d) => d.balance);
    const threshold = this.threshold();
    const candidates = threshold != null ? [...balances, threshold, 0] : [...balances, 0];
    let minB = Math.min(...candidates);
    let maxB = Math.max(...candidates);
    if (minB === maxB) { minB -= 1; maxB += 1; }
    const padR = (maxB - minB) * 0.1;
    minB -= padR;
    maxB += padR;

    const n = days.length;
    const xOf = (i: number) =>
      pad.left + (n === 1 ? innerW / 2 : (i * innerW) / (n - 1));
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
      points, linePath, areaPath,
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
