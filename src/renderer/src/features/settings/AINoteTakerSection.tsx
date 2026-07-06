import { useEffect, useState } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import { Card } from '@renderer/components/Card'
import { ToggleSwitch } from '@renderer/components/ToggleSwitch'
import { cn } from '@renderer/lib/cn'
import { SettingRow } from './SettingRow'
import { useAutoStartListening } from './useAutoStartListening'
import {
  getAutoOpenMeetingPage,
  setAutoOpenMeetingPage,
  getAutoSummarize,
  setAutoSummarize,
  getAutoGenerateTitle,
  setAutoGenerateTitle,
  getExcludedApps,
  setExcludedApps,
  getSeenApps
} from './prefs'

export function AINoteTakerSection(): React.JSX.Element {
  const [autoStart, setAutoStart] = useAutoStartListening()
  const [autoOpen, setAutoOpenState] = useState(() => getAutoOpenMeetingPage())
  const [autoSummarize, setAutoSummarizeState] = useState(() => getAutoSummarize())
  const [autoTitle, setAutoTitleState] = useState(() => getAutoGenerateTitle())
  const [excluded, setExcludedState] = useState<string[]>(() => getExcludedApps())
  const [seenApps] = useState<string[]>(() => getSeenApps())
  const [detectionAvailable, setDetectionAvailable] = useState<boolean | null>(null)

  useEffect(() => {
    void window.api.app.getActiveApp().then((name) => setDetectionAvailable(name !== null))
  }, [])

  const toggleExcluded = (app: string): void => {
    const next = excluded.includes(app) ? excluded.filter((a) => a !== app) : [...excluded, app]
    setExcludedApps(next)
    setExcludedState(next)
  }

  return (
    <>
      <Card className="mb-5">
        <div className="space-y-4 divide-y divide-line-soft">
          <SettingRow
            title="Auto-start listening"
            description="Start transcription automatically when you open Live Calls, instead of clicking Start yourself."
            control={
              <ToggleSwitch
                checked={autoStart}
                onChange={setAutoStart}
                label="Auto-start listening"
              />
            }
          />
          <div className="pt-4">
            <SettingRow
              title="Automatically open meeting page"
              description="Jump to the saved call's detail page as soon as it's saved."
              control={
                <ToggleSwitch
                  checked={autoOpen}
                  onChange={(v) => {
                    setAutoOpenMeetingPage(v)
                    setAutoOpenState(v)
                  }}
                  label="Automatically open meeting page"
                />
              }
            />
          </div>
          <div className="pt-4">
            <SettingRow
              title="Automatically summarize meeting notes"
              description="Run the AI summary as soon as a call is saved, instead of clicking Summarize yourself. Sends the transcript to Claude automatically on every saved call."
              control={
                <ToggleSwitch
                  checked={autoSummarize}
                  onChange={(v) => {
                    setAutoSummarize(v)
                    setAutoSummarizeState(v)
                  }}
                  label="Automatically summarize meeting notes"
                />
              }
            />
          </div>
          <div className="pt-4">
            <SettingRow
              title="Automatically generate AI meeting title"
              description="Rename a saved call using AI once it's saved, instead of the default date-based title."
              control={
                <ToggleSwitch
                  checked={autoTitle}
                  onChange={(v) => {
                    setAutoGenerateTitle(v)
                    setAutoTitleState(v)
                  }}
                  label="Automatically generate AI meeting title"
                />
              }
            />
          </div>
        </div>
      </Card>

      <Card className="mb-5">
        <p className="text-sm font-medium">Exclude these apps from auto-start</p>
        <p className="mt-1 mb-3 text-[12px] text-muted">
          Prevent auto-start listening when these apps are in the foreground.
        </p>

        {detectionAvailable === false && (
          <div className="mb-3 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 px-3.5 py-2.5 text-[13px] text-amber-300">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="flex-1">
              CallRise AI needs the Accessibility permission to detect the app you&rsquo;re using.
            </span>
            <button
              type="button"
              onClick={() => void window.api.app.openAccessibilitySettings()}
              className="shrink-0 rounded-lg border border-amber-500/40 px-2.5 py-1 text-xs font-medium text-amber-200 hover:bg-amber-500/10"
            >
              Open Settings
            </button>
          </div>
        )}

        {seenApps.length === 0 ? (
          <p className="text-[12px] text-faint">
            Apps will appear here once they&rsquo;ve been in the foreground during a Live Calls
            session at least once.
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {seenApps.map((app) => {
              const isExcluded = excluded.includes(app)
              return (
                <button
                  key={app}
                  type="button"
                  onClick={() => toggleExcluded(app)}
                  className={cn(
                    'flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[13px] font-medium transition',
                    isExcluded
                      ? 'border-accent/40 bg-accent-soft text-ink'
                      : 'border-line text-muted hover:text-ink'
                  )}
                >
                  {app}
                  {isExcluded && <X className="h-3 w-3" />}
                </button>
              )
            })}
          </div>
        )}
      </Card>
    </>
  )
}
