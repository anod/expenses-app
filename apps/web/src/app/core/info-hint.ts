import { ChangeDetectionStrategy, Component, input } from '@angular/core';

let uid = 0;

/**
 * Small, tap-friendly info affordance: an info icon that opens a short
 * explanatory bubble. Uses the native Popover API so it works on touch
 * devices (tap to open, tap-outside / Escape to dismiss). Where the CSS
 * Anchor Positioning API is available the bubble is pinned just beneath the
 * icon (flipping on-screen as needed); otherwise it falls back to the UA's
 * viewport-centred placement so it never clips off-screen.
 */
@Component({
  selector: 'app-info-hint',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      type="button"
      class="info-hint-trigger"
      [attr.popovertarget]="popId"
      [attr.aria-label]="label()"
      [style.anchor-name]="anchorName"
    >
      <span class="material-symbols-outlined" aria-hidden="true">info</span>
    </button>
    <div
      [id]="popId"
      popover="auto"
      role="note"
      class="info-hint-pop"
      [style.position-anchor]="anchorName"
    >
      {{ text() }}
    </div>
  `,
  styleUrl: './info-hint.css',
})
export class InfoHintComponent {
  readonly text = input.required<string>();
  readonly label = input('More information');
  protected readonly popId = `info-hint-${uid++}`;
  /** Unique anchor name tying this trigger to its own popover. */
  protected readonly anchorName = `--${this.popId}`;
}
