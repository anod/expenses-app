import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import type { Channel, CreditCard, RecurringTemplate } from '@expenses/shared';
import { descriptionLabel, paymentProgress, type PaymentProgress } from '@expenses/shared';
import { ForecastApi } from '../forecast/forecast.api';

type EditState = { kind: 'idle' } | { kind: 'edit'; id: string } | { kind: 'new' };

type SortColumn = 'description' | 'channel' | 'day' | 'amount' | 'startDate' | 'endDate';
type SortDir = 'asc' | 'desc';

@Component({
  selector: 'app-recurring-page',
  standalone: true,
  imports: [ReactiveFormsModule],
  templateUrl: './recurring-page.html',
  styleUrl: './recurring-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RecurringPageComponent {
  private readonly api = inject(ForecastApi);
  private readonly fb = inject(FormBuilder);

  protected readonly templates = signal<RecurringTemplate[]>([]);
  protected readonly cards = signal<CreditCard[]>([]);
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly edit = signal<EditState>({ kind: 'idle' });
  protected readonly sortColumn = signal<SortColumn>('day');
  protected readonly sortDir = signal<SortDir>('asc');

  /** Templates sorted by the current column / direction. Channel sorts by
   * the resolved label so CC cards group naturally with their bank name. */
  protected readonly sortedTemplates = computed<RecurringTemplate[]>(() => {
    const col = this.sortColumn();
    const dir = this.sortDir() === 'asc' ? 1 : -1;
    const arr = this.templates().slice();
    arr.sort((a, b) => dir * this.compareBy(col, a, b));
    return arr;
  });

  protected toggleSort(col: SortColumn): void {
    if (this.sortColumn() === col) {
      this.sortDir.set(this.sortDir() === 'asc' ? 'desc' : 'asc');
    } else {
      this.sortColumn.set(col);
      this.sortDir.set('asc');
    }
  }

  protected sortIcon(col: SortColumn): string {
    if (this.sortColumn() !== col) return 'unfold_more';
    return this.sortDir() === 'asc' ? 'arrow_upward' : 'arrow_downward';
  }

  private compareBy(col: SortColumn, a: RecurringTemplate, b: RecurringTemplate): number {
    switch (col) {
      case 'description':
        return a.description.localeCompare(b.description);
      case 'channel':
        return this.channelLabel(a.channel).localeCompare(this.channelLabel(b.channel));
      case 'day': {
        const ad = a.cadence.kind === 'monthly' ? a.cadence.day : 0;
        const bd = b.cadence.kind === 'monthly' ? b.cadence.day : 0;
        return ad - bd;
      }
      case 'amount':
        return a.amount - b.amount;
      case 'startDate':
        return a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0;
      case 'endDate': {
        // null end-date sorts last in ascending order.
        const ax = a.endDate ?? '\uffff';
        const bx = b.endDate ?? '\uffff';
        return ax < bx ? -1 : ax > bx ? 1 : 0;
      }
    }
  }

  /** Channel options for the form select: bank + every card. */
  protected readonly channelOptions = computed<Array<{ value: Channel; label: string }>>(() => [
    { value: 'bank', label: 'Bank' },
    ...this.cards().map((c) => ({ value: `cc:${c.id}` as Channel, label: c.name })),
  ]);

  protected readonly form = this.fb.nonNullable.group({
    description: ['', [Validators.required, Validators.maxLength(200)]],
    amount: [0, [Validators.required]],
    channel: ['bank' as Channel, [Validators.required]],
    day: [1, [Validators.required, Validators.min(1), Validators.max(31)]],
    startDate: ['', [Validators.required]],
    endDate: [''],
  });

  constructor() { void this.load(); }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const [tpls, cards] = await Promise.all([
        firstValueFrom(this.api.listRecurring()),
        firstValueFrom(this.api.listCards()),
      ]);
      this.templates.set(tpls);
      this.cards.set(cards);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.loading.set(false);
    }
  }

  protected startEdit(t: RecurringTemplate): void {
    this.form.reset({
      description: t.description,
      amount: t.amount,
      channel: t.channel,
      day: t.cadence.kind === 'monthly' ? t.cadence.day : 1,
      startDate: t.startDate,
      endDate: t.endDate ?? '',
    });
    this.edit.set({ kind: 'edit', id: t.id });
  }

  protected startNew(): void {
    const today = new Date().toISOString().slice(0, 10);
    this.form.reset({
      description: '',
      amount: 0,
      channel: 'bank',
      day: 1,
      startDate: today,
      endDate: '',
    });
    this.edit.set({ kind: 'new' });
  }

  protected cancel(): void {
    this.edit.set({ kind: 'idle' });
    this.error.set(null);
  }

  protected async save(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const state = this.edit();
    if (state.kind === 'idle') return;
    const v = this.form.getRawValue();
    const body = {
      description: v.description.trim(),
      amount: v.amount,
      channel: v.channel,
      day: v.day,
      startDate: v.startDate,
      monthEndPolicy: 'clamp' as const,
      ...(v.endDate ? { endDate: v.endDate } : {}),
    };
    this.saving.set(true);
    this.error.set(null);
    try {
      if (state.kind === 'new') {
        const res = await firstValueFrom(this.api.createRecurring(body));
        this.templates.update((arr) => [...arr, res.entity]);
      } else {
        const res = await firstValueFrom(this.api.updateRecurring(state.id, body));
        this.templates.update((arr) => arr.map((t) => (t.id === state.id ? res.entity : t)));
      }
      this.edit.set({ kind: 'idle' });
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.saving.set(false);
    }
  }

  protected async remove(t: RecurringTemplate): Promise<void> {
    if (!confirm(`Delete recurring template “${t.description}”?`)) return;
    const prev = this.templates();
    this.templates.update((arr) => arr.filter((x) => x.id !== t.id));
    try {
      await firstValueFrom(this.api.deleteRecurring(t.id));
    } catch (err) {
      this.templates.set(prev);
      this.error.set(err instanceof Error ? err.message : String(err));
    }
  }

  protected channelLabel(channel: Channel): string {
    if (channel === 'bank') return 'Bank';
    const id = channel.slice(3);
    return this.cards().find((c) => c.id === id)?.name ?? channel;
  }

  /** Strip any `[source]` Excel-import prefix from the stored description. */
  protected displayDesc(desc: string): string {
    return descriptionLabel(desc);
  }

  /** Day-of-month for monthly templates; null for non-monthly. */
  protected dayOfMonth(t: RecurringTemplate): number | null {
    return t.cadence.kind === 'monthly' ? t.cadence.day : null;
  }

  /**
   * Progress on a fixed-term schedule, computed off `today` so the UI
   * label refreshes naturally when the component re-renders. Returns
   * `null` for open-ended (no endDate) templates.
   */
  protected paymentProgressFor(t: RecurringTemplate): PaymentProgress | null {
    const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD local
    return paymentProgress(t, today);
  }

  protected isEditing(id: string): boolean {
    const s = this.edit();
    return s.kind === 'edit' && s.id === id;
  }

  protected isNew(): boolean { return this.edit().kind === 'new'; }
  protected isIdle(): boolean { return this.edit().kind === 'idle'; }
}
