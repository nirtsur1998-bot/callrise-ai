// Renderer-side mirror of src/main/summary-language.ts, kept in sync manually
// (same convention as the app's other renderer/main type mirrors).
import type { SummaryLanguage } from './useAppSettings'

export const SUMMARY_LANGUAGES: SummaryLanguage[] = [
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
]

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
