import { ChangeDetectionStrategy, Component } from '@angular/core';
import { ExpensesTableComponent } from './expenses/expenses-table';
import { HeaderComponent } from './header/header';

@Component({
  selector: 'app-root',
  imports: [ExpensesTableComponent, HeaderComponent],
  templateUrl: './app.html',
  styleUrl: './app.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {}
