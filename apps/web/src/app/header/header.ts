import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { AuthService } from '../auth/auth.service';

@Component({
  selector: 'app-header',
  imports: [RouterLink, RouterLinkActive],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './header.html',
  styleUrl: './header.css',
})
export class HeaderComponent {
  protected readonly auth = inject(AuthService);

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
}
