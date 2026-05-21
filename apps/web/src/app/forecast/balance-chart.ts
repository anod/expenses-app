import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { DailyProjection, RecurringTemplate } from '@expenses/shared';

interface Lane {
  key: string;
  label: string;
  top: number;
  midY: number;
  valueLabel: string;
  path: string;
  className: string;
  pointClass?: string;
  points?: ReadonlyArray<{ x: number; y: number }>;
}

interface ChartModel {
  width: number;
  height: number;
  pad: { top: number; right: number; bottom: number; left: number };
  anchorBands: { x: number; width: number }[];
  lanes: Lane[];
  xLabels: { x: number; label: string }[];
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
      aria-label="Forecast chart with anchor balance, expenses, and debt over time"
    >
      @for (band of chart().anchorBands; track $index) {
        <rect
          [attr.x]="band.x"
          [attr.y]="0"
          [attr.width]="band.width"
          [attr.height]="chart().height - chart().pad.bottom"
          class="anchor-band"
        />
      }
      @for (lane of chart().lanes; track lane.key) {
        <g>
          <line
            [attr.x1]="chart().pad.left"
            [attr.x2]="chart().width - chart().pad.right"
            [attr.y1]="lane.top"
            [attr.y2]="lane.top"
            class="lane-rule"
          />
          <text
            [attr.x]="10"
            [attr.y]="lane.midY - 4"
            class="lane-label"
          >{{ lane.label }}</text>
          <text
            [attr.x]="chart().width - 8"
            [attr.y]="lane.midY - 4"
            text-anchor="end"
            class="lane-value"
          >{{ lane.valueLabel }}</text>
          <path [attr.d]="lane.path" [attr.class]="lane.className" />
          @if (lane.points; as pts) {
            @for (pt of pts; track $index) {
              <circle [attr.cx]="pt.x" [attr.cy]="pt.y" r="3" [attr.class]="lane.pointClass ?? 'series-point'" />
            }
          }
        </g>
      }

      @for (x of chart().xLabels; track x.label) {
        <text
          [attr.x]="x.x"
          [attr.y]="chart().height - 6"
          text-anchor="middle"
          class="axis-label"
        >{{ x.label }}</text>
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
    .lane-rule {
      stroke: var(--md-sys-color-outline-variant);
      stroke-width: 1;
    }
    .anchor-band {
      fill: var(--md-sys-color-primary);
      opacity: 0.06;
    }
    .lane-label,
    .lane-value,
    .axis-label {
      fill: var(--md-sys-color-on-surface-variant);
      font-size: 10px;
    }
    .lane-label,
    .lane-value {
      font-weight: 500;
    }
    .series-anchor {
      fill: none;
      stroke: var(--md-sys-color-primary);
      stroke-width: 2;
      stroke-linejoin: round;
      stroke-linecap: round;
    }
    .series-expenses {
      fill: none;
      stroke: var(--md-sys-color-secondary);
      stroke-width: 2;
      stroke-linejoin: round;
      stroke-linecap: round;
    }
    .series-debt {
      fill: none;
      stroke: var(--md-sys-color-tertiary);
      stroke-width: 2;
      stroke-linejoin: round;
      stroke-linecap: round;
    }
    .series-point {
      stroke: var(--md-sys-color-surface);
      stroke-width: 1.5;
    }
    .series-point-anchor {
      fill: var(--md-sys-color-primary);
    }
    .series-point-expenses {
      fill: var(--md-sys-color-secondary);
    }
    .series-point-debt {
      fill: var(--md-sys-color-tertiary);
    }
  `],
})
export class BalanceChartComponent {
  readonly days = input.required<readonly DailyProjection[]>();
  readonly templates = input<readonly RecurringTemplate[]>([]);

  protected readonly chart = computed<ChartModel>(() => {
    const days = this.days();
    const width = 800;
    const height = 240;
    const pad = { top: 14, right: 58, bottom: 24, left: 82 };
    const innerW = width - pad.left - pad.right;
    const innerH = height - pad.top - pad.bottom;
    const laneGap = 10;
    const laneCount = 3;
    const laneHeight = (innerH - laneGap * (laneCount - 1)) / laneCount;

    if (days.length === 0) {
      return { width, height, pad, anchorBands: [], lanes: [], xLabels: [] };
    }

    const n = days.length;
    const xOf = (i: number): number =>
      pad.left + (n === 1 ? innerW / 2 : (i * innerW) / (n - 1));

    const makePath = (
      values: readonly number[],
      laneTop: number,
      indices?: readonly number[],
    ): { path: string; points?: ReadonlyArray<{ x: number; y: number }> } => {
      const ids = indices ?? values.map((_, i) => i);
      if (ids.length === 0) return { path: '' };
      const subset = ids.map((i) => values[i] ?? 0);
      let min = Math.min(...subset);
      let max = Math.max(...subset);
      if (min === max) {
        min -= 1;
        max += 1;
      }
      const yOf = (v: number): number =>
        laneTop + laneHeight - ((v - min) / (max - min)) * laneHeight;
      const points = ids.map((i) => ({ x: xOf(i), y: yOf(values[i] ?? 0) }));
      return {
        path: points
          .map((pt, i) => `${i === 0 ? 'M' : 'L'}${pt.x.toFixed(1)},${pt.y.toFixed(1)}`)
          .join(' '),
        points,
      };
    };

    const anchorIndices = days
      .map((d, i) => (d.isAnchor ? i : -1))
      .filter((i) => i >= 0);
    const anchorValues = days.map((d) => d.balance);
    const anchorLaneTop = pad.top;
    const anchorSeries = makePath(anchorValues, anchorLaneTop, anchorIndices);
    const lastAnchorIdx = anchorIndices[anchorIndices.length - 1] ?? 0;
    const anchorBands = anchorIndices.map((idx) => ({ x: xOf(idx) - 10, width: 20 }));

    const templateById = new Map(this.templates().map((t) => [t.id, t]));
    let spendInPeriod = 0;
    let splitCcInPeriod = 0;
    const expenseValues = new Array<number>(days.length).fill(0);
    const debtValues = new Array<number>(days.length).fill(0);
    days.forEach((day, i) => {
      for (const charge of day.charges) {
        if (charge.amount < 0) {
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
      }
      if (day.isAnchor) {
        expenseValues[i] = spendInPeriod;
        debtValues[i] = splitCcInPeriod;
        spendInPeriod = 0;
        splitCcInPeriod = 0;
      }
    });
    const expenseTotal = expenseValues[lastAnchorIdx] ?? expenseValues[0] ?? 0;
    const expenseLaneTop = anchorLaneTop + laneHeight + laneGap;
    const expenseSeries = makePath(expenseValues, expenseLaneTop, anchorIndices);

    const debtLaneTop = expenseLaneTop + laneHeight + laneGap;
    const debtSeries = makePath(debtValues, debtLaneTop, anchorIndices);

    const lanes: Lane[] = [
      {
        key: 'anchors',
        label: 'Anchor balance',
        top: anchorLaneTop,
        midY: anchorLaneTop + laneHeight / 2,
        valueLabel: this.formatShort(anchorValues[lastAnchorIdx] ?? anchorValues[0] ?? 0),
        path: anchorSeries.path,
        className: 'series-anchor',
        pointClass: 'series-point series-point-anchor',
        points: anchorSeries.points,
      },
      {
        key: 'expenses',
        label: 'Spending @ anchor',
        top: expenseLaneTop,
        midY: expenseLaneTop + laneHeight / 2,
        valueLabel: this.formatShort(expenseTotal),
        path: expenseSeries.path,
        className: 'series-expenses',
        pointClass: 'series-point series-point-expenses',
        points: expenseSeries.points,
      },
      {
        key: 'debt',
        label: 'Split CC @ anchor',
        top: debtLaneTop,
        midY: debtLaneTop + laneHeight / 2,
        valueLabel: this.formatShort(debtValues[lastAnchorIdx] ?? debtValues[0] ?? 0),
        path: debtSeries.path,
        className: 'series-debt',
        pointClass: 'series-point series-point-debt',
        points: debtSeries.points,
      },
    ];

    const xLabels: { x: number; label: string }[] = [];
    const seenMonths = new Set<string>();
    days.forEach((d, i) => {
      const ym = d.date.slice(0, 7);
      if (seenMonths.has(ym)) return;
      seenMonths.add(ym);
      xLabels.push({ x: xOf(i), label: this.monthLabel(d.date) });
    });

    return { width, height, pad, anchorBands, lanes, xLabels };
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
