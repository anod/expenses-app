import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../auth/auth.service';
import { ForecastApi } from '../forecast/forecast.api';
import { SwUpdaterService } from '../core/sw-updater.service';

@Component({
  selector: 'app-header',
  imports: [RouterLink, RouterLinkActive],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './header.html',
  styleUrl: './header.css',
})
export class HeaderComponent {
  protected readonly auth = inject(AuthService);
  protected readonly swUpdater = inject(SwUpdaterService);
  private readonly api = inject(ForecastApi);
  protected readonly demoBusy = signal(false);

  protected readonly initials = computed(() => {
    const name = this.auth.displayName();
    if (!name) return '?';
    const parts = name.trim().split(/\s+/).slice(0, 2);
    return parts.map((p) => p[0]?.toUpperCase() ?? '').join('') || '?';
  });

  protected async signIn(): Promise<void> {
    try {
      await this.auth.signIn();
    } catch (err) {
      console.error('sign-in failed', err);
    }
  }

  protected async signOut(): Promise<void> {
    try {
      await this.auth.signOut();
    } catch (err) {
      console.error('sign-out failed', err);
    }
  }

  protected async exitDemo(): Promise<void> {
    if (this.demoBusy()) return;
    this.demoBusy.set(true);
    try {
      await firstValueFrom(this.api.setDemo(false));
      window.location.reload();
    } catch (err) {
      this.demoBusy.set(false);
      console.error('exit demo failed', err);
    }
  }
}
