import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { HttpClient } from '@angular/common/http';
import type {
  AmountCell,
  ExpenseRow,
  WorkbookSnapshot,
} from '@expenses/shared';
import { AuthService } from '../auth/auth.service';

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; snapshot: WorkbookSnapshot };

@Component({
  selector: 'app-expenses-table',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './expenses-table.html',
  styleUrl: './expenses-table.css',
})
export class ExpensesTableComponent {
  private readonly http = inject(HttpClient);
  protected readonly auth = inject(AuthService);

  protected readonly state = signal<LoadState>({ status: 'idle' });

  protected readonly formatter = computed(() => {
    const s = this.state();
    if (s.status !== 'ready') return null;
    const { code, locale } = s.snapshot.workbook.currency;
    const opts: Intl.NumberFormatOptions = {
      style: code ? 'currency' : 'decimal',
      maximumFractionDigits: 0,
      minimumFractionDigits: 0,
    };
    if (code) opts.currency = code;
    return new Intl.NumberFormat(locale ?? undefined, opts);
  });

  constructor() {
    // Reload when auth status changes (sign-in or sign-out).
    effect(() => {
      const enabled = this.auth.enabled();
      const signedIn = this.auth.isSignedIn();
      if (enabled && !signedIn) {
        this.state.set({ status: 'idle' });
        return;
      }
      this.load();
    });
  }

  protected reload(): void {
    this.load();
  }

  protected formatAmount(cell: AmountCell | undefined): string {
    if (!cell || cell.value === null) return '';
    const fmt = this.formatter();
    return fmt ? fmt.format(cell.value) : String(cell.value);
  }

  protected isFormula(cell: AmountCell | undefined): boolean {
    return !!cell?.isFormula;
  }

  protected rowClass(row: ExpenseRow): string {
    return `row row-${row.kind}`;
  }

  protected amountClass(cell: AmountCell | undefined): string {
    if (!cell || cell.value === null) return 'amt amt-empty';
    const sign = cell.value < 0 ? 'neg' : cell.value > 0 ? 'pos' : 'zero';
    return `amt amt-${sign}${cell.isFormula ? ' amt-formula' : ''}`;
  }

  private load(): void {
    this.state.set({ status: 'loading' });
    this.http.get<WorkbookSnapshot>('/api/expenses').subscribe({
      next: (snapshot) => this.state.set({ status: 'ready', snapshot }),
      error: (err: unknown) => {
        const message =
          err && typeof err === 'object' && 'message' in err
            ? String((err as { message: unknown }).message)
            : 'Failed to load expenses';
        this.state.set({ status: 'error', message });
      },
    });
  }
}
