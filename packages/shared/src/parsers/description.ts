/**
 * Excel anchor-sheet rows store a leading `[source]` tag on descriptions
 * — e.g. `[cal] арнона`, `[cc] groceries`. The importer preserves the
 * prefix verbatim in {@link LedgerEntry.description} and
 * {@link RecurringTemplate.description}, and the exporter
 * (`apps/api/src/graph/excelWriter.ts`) re-attaches it on round-trip.
 *
 * The SPA renders raw descriptions in several places; this helper lets
 * UI code show the human-readable label without losing the source tag
 * from underlying data.
 */
export interface ParsedDescription {
  /** The tag inside the brackets, or '' if the description had no prefix. */
  source: string;
  /** Description with the `[source]` prefix removed (or the full text if none). */
  label: string;
}

const PREFIX_RE = /^\[([^\]]+)\]\s+(.*)$/;

export const parseDescription = (desc: string): ParsedDescription => {
  const m = PREFIX_RE.exec(desc);
  if (m) return { source: m[1]!, label: m[2]! };
  return { source: '', label: desc };
};

/** Convenience for templates that only need the visible text. */
export const descriptionLabel = (desc: string): string =>
  parseDescription(desc).label;
