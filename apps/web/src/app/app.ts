import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { HeaderComponent } from './header/header';
import { AuthService } from './auth/auth.service';
import { LoginLandingComponent } from './auth/login-landing';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, HeaderComponent, LoginLandingComponent],
  templateUrl: './app.html',
  styleUrl: './app.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  protected readonly auth = inject(AuthService);
  /** Show the sign-in landing when auth is enabled (graph mode) and the
   *  user has not yet authenticated. In demo / dump mode `auth.enabled()`
   *  is false, so the app renders normally. */
  protected readonly showLanding = computed(
    () => this.auth.enabled() && !this.auth.isSignedIn(),
  );
  protected readonly initError = computed(() => this.auth.initError());
}
