/**
 * Shared input styling — one class string for every text input / textarea /
 * select, with a real accent focus ring (border + soft ring) instead of the
 * near-invisible `focus:border-line` inputs used to carry. Import and spread
 * onto any field so forms look and focus identically app-wide.
 */
export const fieldClass =
  'w-full rounded-lg border border-line-soft bg-canvas px-3 py-2 text-sm text-ink outline-none transition placeholder:text-faint focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60'
