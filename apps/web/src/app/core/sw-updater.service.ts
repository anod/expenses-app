import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { SwUpdate } from '@angular/service-worker';
import { filter } from 'rxjs/operators';

const UPDATE_CHECK_INTERVAL_MS = 60_000;

/**
 * Detect Angular SW updates as soon as a new build is published. The shell
 * asks before reloading so the current session stays stable.
 *
 * Why this exists: by default Angular's SW only checks for updates 30s after
 * the app becomes stable, and new versions sit in the "waiting" state until
 * every tab is closed. Polling keeps deploy detection prompt.
 */
@Injectable({ providedIn: 'root' })
export class SwUpdaterService {
  private readonly updates = inject(SwUpdate, { optional: true });
  private readonly destroyRef = inject(DestroyRef);
  readonly updateReady = signal(false);
  private pollHandle: ReturnType<typeof setInterval> | null = null;

  start(): void {
    if (!this.updates || !this.updates.isEnabled) return;

    this.updates.versionUpdates
      .pipe(
        filter((evt) => evt.type === 'VERSION_READY'),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => {
        this.updateReady.set(true);
      });

    this.pollHandle = setInterval(() => {
      void this.updates!.checkForUpdate().catch(() => undefined);
    }, UPDATE_CHECK_INTERVAL_MS);

    this.destroyRef.onDestroy(() => {
      if (this.pollHandle) clearInterval(this.pollHandle);
    });
  }

  async reloadUpdate(): Promise<void> {
    if (!this.updateReady() || !this.updates) return;
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
