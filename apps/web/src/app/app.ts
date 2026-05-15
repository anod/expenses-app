import { ChangeDetectionStrategy, Component } from '@angular/core';
import { ExpensesTableComponent } from './expenses/expenses-table';

@Component({
  selector: 'app-root',
  imports: [ExpensesTableComponent],
  templateUrl: './app.html',
  styleUrl: './app.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {}
