import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, inject, signal, viewChildren } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import type { Channel, CreditCard, LedgerEntry, RecurringTemplate } from '@expenses/shared';
import {
  descriptionLabel,
  endDateForPaymentCount,
  paymentProgress,
  scheduledPaymentCount,
  type PaymentProgress,
} from '@expenses/shared';
import { ForecastApi } from '../forecast/forecast.api';

type EditState = { kind: 'idle' } | { kind: 'edit'; id: string } | { kind: 'new' };
type LedgerEditState = { kind: 'idle' } | { kind: 'edit'; id: string };

type CadenceKind = 'monthly' | 'weekly' | 'monthly_prediction';

type SortColumn = 'description' | 'channel' | 'day' | 'amount' | 'startDate' | 'endDate';
type SortDir = 'asc' | 'desc';

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

@Component({
  selector: 'app-recurring-page',
  standalone: true,
  imports: [ReactiveFormsModule, NgTemplateOutlet],
  templateUrl: './recurring-page.html',
  styleUrl: './recurring-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RecurringPageComponent {
  private readonly api = inject(ForecastApi);
  private readonly fb = inject(FormBuilder);
  private readonly destroyRef = inject(DestroyRef);
  private readonly editorCards = viewChildren<ElementRef<HTMLElement>>('editorCard');
  private readonly descriptionInputs = viewChildren<ElementRef<HTMLInputElement>>('descriptionInput');
  private suppressWeeklyStartSync = false;
  private lastCadenceKind: CadenceKind = 'monthly';

  protected readonly templates = signal<RecurringTemplate[]>([]);
  protected readonly cards = signal<CreditCard[]>([]);
  /** All persisted one-off ledger entries (not generated from a template). */
  protected readonly ledger = signal<LedgerEntry[]>([]);
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly edit = signal<EditState>({ kind: 'idle' });
  protected readonly ledgerEdit = signal<LedgerEditState>({ kind: 'idle' });
  protected readonly sortColumn = signal<SortColumn>('day');
  protected readonly sortDir = signal<SortDir>('asc');

  /** Standalone ledger entries: excludes template-bound overrides and
   * legacy card-bill placeholders that have no useful edit semantics. */
  protected readonly oneOffLedger = computed<LedgerEntry[]>(() =>
    this.ledger()
      .filter((e) => e.recurringId == null)
      .filter((e) => !e.id.startsWith('excel:l:cardbill:'))
      .slice()
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
  );

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
        // Sort weekly templates after monthly ones, then by day-of-week.
        const rank = (t: RecurringTemplate): number =>
          t.cadence.kind === 'monthly'
            ? t.cadence.day
            : t.cadence.kind === 'weekly'
              ? 100 + t.cadence.dayOfWeek
              : 200;
        return rank(a) - rank(b);
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

  protected readonly form = this.fb.group({
    description: this.fb.nonNullable.control('', [Validators.required, Validators.maxLength(200)]),
    amount: this.fb.nonNullable.control(0, [Validators.required]),
    channel: this.fb.nonNullable.control('bank' as Channel, [Validators.required]),
    cadenceKind: this.fb.nonNullable.control('monthly' as CadenceKind, [Validators.required]),
    day: this.fb.nonNullable.control(1, [Validators.min(1), Validators.max(31)]),
    dayOfWeek: this.fb.nonNullable.control(5, [Validators.min(0), Validators.max(6)]), // default Fri
    startDate: this.fb.nonNullable.control('', [Validators.required]),
    endDate: this.fb.nonNullable.control(''),
    paymentCount: this.fb.control<number | null>(null, [Validators.min(1), Validators.max(240)]),
  });

  protected readonly weekdayOptions = WEEKDAY_LABELS.map((label, value) => ({ value, label }));

  protected readonly ledgerForm = this.fb.nonNullable.group({
    description: ['', [Validators.required, Validators.maxLength(200)]],
    amount: [0, [Validators.required]],
    channel: ['bank' as Channel, [Validators.required]],
    date: ['', [Validators.required]],
    status: ['pending' as 'pending' | 'cleared', [Validators.required]],
  });

  constructor() {
    this.form.controls.cadenceKind.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((kind) => {
        if (this.suppressWeeklyStartSync) {
          this.lastCadenceKind = kind;
          return;
        }
        const previous = this.lastCadenceKind;
        this.lastCadenceKind = kind;
        if (kind === 'weekly' && previous !== 'weekly') {
          this.syncWeeklyStartDate(todayIsoLocal());
        }
      });

    this.form.controls.dayOfWeek.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((dayOfWeek) => {
        if (this.suppressWeeklyStartSync || this.form.controls.cadenceKind.value !== 'weekly') return;
        const baseline = this.lastCadenceKind === 'weekly'
          ? this.form.controls.startDate.value || todayIsoLocal()
          : todayIsoLocal();
        this.form.controls.startDate.setValue(firstWeekdayOnOrAfter(baseline, dayOfWeek), {
          emitEvent: false,
        });
      });

    void this.load();
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const [tpls, cards, ledger] = await Promise.all([
        firstValueFrom(this.api.listRecurring()),
        firstValueFrom(this.api.listCards()),
        firstValueFrom(this.api.listLedger()),
      ]);
      this.templates.set(tpls);
      this.cards.set(cards);
      this.ledger.set(ledger);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.loading.set(false);
    }
  }

  protected startEdit(t: RecurringTemplate): void {
    this.withSuppressedWeeklyStartSync(() => this.form.reset({
      description: t.description,
      amount: t.amount,
      channel: t.channel,
      cadenceKind: t.cadence.kind,
      day: t.cadence.kind === 'monthly' ? t.cadence.day : 1,
      dayOfWeek: t.cadence.kind === 'weekly' ? t.cadence.dayOfWeek : 5,
      startDate: t.startDate,
      endDate: t.endDate ?? '',
      paymentCount:
        t.cadence.kind === 'monthly' && t.endDate ? scheduledPaymentCount(t) : null,
    }));
    this.lastCadenceKind = t.cadence.kind;
    this.edit.set({ kind: 'edit', id: t.id });
    this.focusEditor();
  }

  protected startNew(): void {
    const today = todayIsoLocal();
    this.withSuppressedWeeklyStartSync(() => this.form.reset({
      description: '',
      amount: 0,
      channel: 'bank',
      cadenceKind: 'monthly',
      day: 1,
      dayOfWeek: 5,
      startDate: today,
      endDate: '',
      paymentCount: null,
    }));
    this.lastCadenceKind = 'monthly';
    this.edit.set({ kind: 'new' });
    this.focusEditor();
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
    const cadence =
      v.cadenceKind === 'weekly'
        ? { kind: 'weekly' as const, dayOfWeek: v.dayOfWeek as 0 | 1 | 2 | 3 | 4 | 5 | 6 }
        : v.cadenceKind === 'monthly_prediction'
          ? { kind: 'monthly_prediction' as const }
          : { kind: 'monthly' as const, day: v.day, monthEndPolicy: 'clamp' as const };
    const paymentCount =
      v.cadenceKind === 'monthly' && v.paymentCount != null && v.paymentCount > 0
        ? v.paymentCount
        : null;
    const derivedEndDate = paymentCount
      ? endDateForPaymentCount({ startDate: v.startDate, cadence }, paymentCount)
      : null;
    const body = {
      description: v.description.trim(),
      amount: v.amount,
      channel: v.channel,
      cadence,
      startDate: v.startDate,
      ...((derivedEndDate ?? v.endDate) ? { endDate: derivedEndDate ?? v.endDate } : {}),
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
      if (this.isEditing(t.id)) this.edit.set({ kind: 'idle' });
    } catch (err) {
      this.templates.set(prev);
      this.error.set(err instanceof Error ? err.message : String(err));
    }
  }

  protected removeEditingTemplate(): void {
    const state = this.edit();
    if (state.kind !== 'edit') return;
    const template = this.templates().find((t) => t.id === state.id);
    if (!template) return;
    void this.remove(template);
  }

  private focusEditor(): void {
    queueMicrotask(() => {
      const editor =
        this.editorCards().find((el) => el.nativeElement.offsetParent !== null) ??
        this.editorCards()[0];
      const input =
        this.descriptionInputs().find((el) => el.nativeElement.offsetParent !== null) ??
        this.descriptionInputs()[0];
      editor?.nativeElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
      input?.nativeElement.focus();
    });
  }

  private withSuppressedWeeklyStartSync(fn: () => void): void {
    this.suppressWeeklyStartSync = true;
    try {
      fn();
    } finally {
      this.suppressWeeklyStartSync = false;
    }
  }

  private syncWeeklyStartDate(from: string): void {
    const next = firstWeekdayOnOrAfter(from, this.form.controls.dayOfWeek.value);
    this.form.controls.startDate.setValue(next, { emitEvent: false });
  }

  protected setStartDateToday(): void {
    this.form.controls.startDate.setValue(todayIsoLocal());
  }

  protected setStartDateNextScheduled(): void {
    this.form.controls.startDate.setValue(
      firstScheduledDateOnOrAfter(todayIsoLocal(), this.formCadence()),
    );
  }

  protected clearEndDate(): void {
    this.form.controls.endDate.setValue('');
  }

  protected setEndDateMonthsFromStart(months: number): void {
    const startDate = this.form.controls.startDate.value || todayIsoLocal();
    this.form.controls.endDate.setValue(addMonthsIso(startDate, months));
  }

  protected describeDateInput(date: string, emptyLabel: string): string {
    if (!date) return emptyLabel;
    return new Date(`${date}T00:00:00`).toLocaleDateString('en-GB', {
      weekday: 'short',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  }

  protected nextStartShortcutLabel(): string {
    const cadence = this.formCadence();
    if (cadence.kind === 'weekly') return WEEKDAY_LABELS[cadence.dayOfWeek] ?? 'day';
    if (cadence.kind === 'monthly_prediction') return 'anchor';
    return `day ${cadence.day}`;
  }

  private formCadence(): RecurringTemplate['cadence'] {
    const cadenceKind = this.form.controls.cadenceKind.value;
    if (cadenceKind === 'weekly') {
      return {
        kind: 'weekly',
        dayOfWeek: this.form.controls.dayOfWeek.value as 0 | 1 | 2 | 3 | 4 | 5 | 6,
      };
    }
    if (cadenceKind === 'monthly_prediction') {
      return { kind: 'monthly_prediction' };
    }
    return {
      kind: 'monthly',
      day: this.form.controls.day.value,
      monthEndPolicy: 'clamp',
    };
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

  /** Short label for the cadence column ("12" for monthly day-of-month,
   * "Fri" for weekly day-of-week). */
  protected cadenceLabel(t: RecurringTemplate): string {
    if (t.cadence.kind === 'weekly') return WEEKDAY_LABELS[t.cadence.dayOfWeek] ?? '?';
    if (t.cadence.kind === 'monthly_prediction') return 'Predicted monthly';
    return String(t.cadence.day);
  }

  /** Number of user-marked skips, for the row badge. */
  protected skipCount(t: RecurringTemplate): number {
    return t.skips?.length ?? 0;
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

  // ---------- One-off ledger entries ----------

  protected isLedgerEditing(id: string): boolean {
    const s = this.ledgerEdit();
    return s.kind === 'edit' && s.id === id;
  }
  protected isLedgerIdle(): boolean { return this.ledgerEdit().kind === 'idle'; }

  protected startEditLedger(e: LedgerEntry): void {
    this.ledgerForm.reset({
      description: e.description,
      amount: e.amount,
      channel: e.channel,
      date: e.date,
      status: e.status,
    });
    this.ledgerEdit.set({ kind: 'edit', id: e.id });
  }

  protected cancelLedger(): void {
    this.ledgerEdit.set({ kind: 'idle' });
    this.error.set(null);
  }

  protected async saveLedger(): Promise<void> {
    if (this.ledgerForm.invalid) {
      this.ledgerForm.markAllAsTouched();
      return;
    }
    const state = this.ledgerEdit();
    if (state.kind !== 'edit') return;
    const v = this.ledgerForm.getRawValue();
    const body = {
      description: v.description.trim(),
      amount: v.amount,
      channel: v.channel,
      date: v.date,
      status: v.status,
    };
    this.saving.set(true);
    this.error.set(null);
    try {
      const res = await firstValueFrom(this.api.updateLedger(state.id, body));
      this.ledger.update((arr) => arr.map((e) => (e.id === state.id ? res.entity : e)));
      this.ledgerEdit.set({ kind: 'idle' });
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.saving.set(false);
    }
  }

  protected async removeLedger(e: LedgerEntry): Promise<void> {
    if (!confirm(`Delete one-off entry “${this.displayDesc(e.description)}”?`)) return;
    const prev = this.ledger();
    this.ledger.update((arr) => arr.filter((x) => x.id !== e.id));
    try {
      await firstValueFrom(this.api.deleteLedger(e.id));
    } catch (err) {
      this.ledger.set(prev);
      this.error.set(err instanceof Error ? err.message : String(err));
    }
  }
}

function todayIsoLocal(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function firstWeekdayOnOrAfter(from: string, dayOfWeek: number): string {
  const date = new Date(`${from}T00:00:00`);
  const diff = (dayOfWeek - date.getDay() + 7) % 7;
  date.setDate(date.getDate() + diff);
  return date.toLocaleDateString('en-CA');
}

function addMonthsIso(from: string, months: number): string {
  const date = new Date(`${from}T00:00:00`);
  const year = date.getFullYear();
  const month = date.getMonth();
  const day = date.getDate();
  const target = new Date(year, month + months, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(day, lastDay));
  return target.toLocaleDateString('en-CA');
}

function firstScheduledDateOnOrAfter(from: string, cadence: RecurringTemplate['cadence']): string {
  if (cadence.kind === 'weekly') return firstWeekdayOnOrAfter(from, cadence.dayOfWeek);

  const date = new Date(`${from}T00:00:00`);
  if (cadence.kind === 'monthly_prediction') {
    const year = date.getFullYear();
    const month = date.getMonth();
    const currentAnchor = new Date(year, month, 10);
    if (currentAnchor >= date) return currentAnchor.toLocaleDateString('en-CA');
    return new Date(year, month + 1, 10).toLocaleDateString('en-CA');
  }

  const year = date.getFullYear();
  const month = date.getMonth();
  const currentLastDay = new Date(year, month + 1, 0).getDate();
  const currentCandidate = new Date(year, month, Math.min(cadence.day, currentLastDay));
  if (currentCandidate >= date) return currentCandidate.toLocaleDateString('en-CA');
  const nextYear = month === 11 ? year + 1 : year;
  const nextMonth = (month + 1) % 12;
  const nextLastDay = new Date(nextYear, nextMonth + 1, 0).getDate();
  return new Date(nextYear, nextMonth, Math.min(cadence.day, nextLastDay)).toLocaleDateString('en-CA');
}
