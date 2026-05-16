import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { AuthService } from './auth.service';
import { ForecastApi } from '../forecast/forecast.api';

@Component({
  selector: 'app-login-landing',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './login-landing.html',
  styleUrl: './login-landing.css',
})
export class LoginLandingComponent {
  protected readonly auth = inject(AuthService);
  private readonly api = inject(ForecastApi);

  protected readonly signingIn = signal(false);
  protected readonly enteringDemo = signal(false);
  protected readonly error = signal<string | null>(null);

  protected async signIn(): Promise<void> {
    this.signingIn.set(true);
    this.error.set(null);
    try {
      await this.auth.signIn();
      // Page navigates away to Microsoft.
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
      this.signingIn.set(false);
    }
  }

  protected async tryDemo(): Promise<void> {
    if (this.enteringDemo()) return;
    this.enteringDemo.set(true);
    this.error.set(null);
    try {
      await firstValueFrom(this.api.setDemo(true));
      // Reload so /api/config reflects demo mode and MSAL stops mounting.
      window.location.reload();
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
      this.enteringDemo.set(false);
    }
  }
}
