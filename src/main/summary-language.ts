// The language AI summaries are written in. 'auto' (default) means "same
// language as the source content" — Claude is simply told to match it,
// rather than the app trying to detect the language itself.

export const SUMMARY_LANGUAGES = [
  'auto',
  'english',
  'spanish',
  'french',
  'german',
  'portuguese',
  'italian',
  'dutch',
  'polish',
  'turkish',
  'russian',
  'arabic',
  'hindi',
  'chinese',
  'japanese',
  'korean',
  'vietnamese',
  'indonesian'
] as const

export type SummaryLanguage = (typeof SUMMARY_LANGUAGES)[number]

export const SUMMARY_LANGUAGE_LABEL: Record<SummaryLanguage, string> = {
  auto: 'Same as the call',
  english: 'English',
  spanish: 'Spanish',
  french: 'French',
  german: 'German',
  portuguese: 'Portuguese',
  italian: 'Italian',
  dutch: 'Dutch',
  polish: 'Polish',
  turkish: 'Turkish',
  russian: 'Russian',
  arabic: 'Arabic',
  hindi: 'Hindi',
  chinese: 'Chinese (Simplified)',
  japanese: 'Japanese',
  korean: 'Korean',
  vietnamese: 'Vietnamese',
  indonesian: 'Indonesian'
}

const LANGUAGE_SET = new Set<SummaryLanguage>(SUMMARY_LANGUAGES)

export function sanitizeSummaryLanguage(value: unknown): SummaryLanguage {
  return typeof value === 'string' && LANGUAGE_SET.has(value as SummaryLanguage)
    ? (value as SummaryLanguage)
    : 'auto'
}

/** The instruction line added to the summarize prompt. Empty for 'auto' —
 *  Claude already defaults to matching the source language on its own. */
export function summaryLanguageInstruction(language: SummaryLanguage): string {
  if (language === 'auto') return ''
  return `Write the summary in ${SUMMARY_LANGUAGE_LABEL[language]}, regardless of what language the source content is in.`
}
