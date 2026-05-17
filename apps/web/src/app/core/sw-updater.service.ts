import { DestroyRef, Injectable, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { SwUpdate } from '@angular/service-worker';
import { filter } from 'rxjs/operators';

const UPDATE_CHECK_INTERVAL_MS = 60_000;

/**
 * Auto-activate Angular SW updates as soon as a new build is published, then
 * reload the page once so the user gets the new bundle without having to close
 * every tab. Also polls ngsw.json every minute to detect server-side deploys
 * while the app is open.
 *
 * Why this exists: by default Angular's SW only checks for updates 30s after
 * the app becomes stable, and new versions sit in the "waiting" state until
 * every tab is closed. That makes deploys feel broken ("I reloaded, still
 * old version"). This service collapses that into a single auto-reload.
 */
@Injectable({ providedIn: 'root' })
export class SwUpdaterService {
  private readonly updates = inject(SwUpdate, { optional: true });
  private readonly destroyRef = inject(DestroyRef);
  private reloading = false;
  private pollHandle: ReturnType<typeof setInterval> | null = null;

  start(): void {
    if (!this.updates || !this.updates.isEnabled) return;

    this.updates.versionUpdates
      .pipe(
        filter((evt) => evt.type === 'VERSION_READY'),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => {
        void this.activateAndReload();
      });

    this.pollHandle = setInterval(() => {
      void this.updates!.checkForUpdate().catch(() => undefined);
    }, UPDATE_CHECK_INTERVAL_MS);

    this.destroyRef.onDestroy(() => {
      if (this.pollHandle) clearInterval(this.pollHandle);
    });
  }

  private async activateAndReload(): Promise<void> {
    if (this.reloading || !this.updates) return;
    this.reloading = true;
    try {
      await this.updates.activateUpdate();
    } catch {
      // If activate fails, still try to reload — the SW will pick the new
      // version on next navigation.
    }
    if (typeof location !== 'undefined') {
      location.reload();
    }
  }
}
