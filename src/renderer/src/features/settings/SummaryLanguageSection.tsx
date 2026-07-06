import { Card } from '@renderer/components/Card'
import { useAppSettings, type SummaryLanguage } from './useAppSettings'
import { SUMMARY_LANGUAGES, SUMMARY_LANGUAGE_LABEL } from './summaryLanguages'
import { SettingRow } from './SettingRow'

export function SummaryLanguageSection(): React.JSX.Element {
  const { settings, loading, update } = useAppSettings()

  return (
    <Card className="mb-5">
      <SettingRow
        title="Summary language"
        description="The language AI-generated summaries are written in — separate from whatever language the call itself was in."
        control={
          <select
            value={settings.summaryLanguage}
            disabled={loading}
            onChange={(e) => void update({ summaryLanguage: e.target.value as SummaryLanguage })}
            className="rounded-lg border border-line-soft bg-canvas px-3 py-2 text-sm text-ink outline-none transition focus:border-line"
          >
            {SUMMARY_LANGUAGES.map((lang) => (
              <option key={lang} value={lang}>
                {SUMMARY_LANGUAGE_LABEL[lang]}
              </option>
            ))}
          </select>
        }
      />
    </Card>
  )
}
