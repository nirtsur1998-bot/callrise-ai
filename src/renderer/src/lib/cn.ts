/**
 * Tiny helper to join class names, dropping any falsy values.
 * Lets us write conditional Tailwind classes cleanly:
 *   cn('px-3', isActive && 'text-accent')
 */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}
