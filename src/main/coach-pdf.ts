// Exports a coached call's scorecard as a PDF — the first use of Electron's
// printToPDF in this app. Renders a purpose-built, print-only HTML string
// (not a screenshot of the app UI) into a hidden BrowserWindow, so the
// output is clean regardless of the app's own theme/layout.
import { ipcMain, dialog, BrowserWindow, app } from 'electron'
import { writeFile } from 'node:fs/promises'
import { getCall } from './calls-fs'
import { join } from 'node:path'

// Mirrors coaching/meta.ts's DIMENSION_ORDER/DIMENSION_LABEL — the main
// process can't import renderer code, so this small, stable label map is
// duplicated here (same pattern as calls-fs.ts's local Call/Summary types).
const DIMENSION_LABEL: Record<string, string> = {
  discovery: 'Discovery & qualification',
  engagement: 'Engagement & listening',
  objection: 'Objection handling',
  value: 'Value articulation',
  nextStep: 'Next-step specificity',
  control: 'Call control & structure'
}
const DIMENSION_ORDER = ['discovery', 'engagement', 'objection', 'value', 'nextStep', 'control']

// Light-mode hex values pulled directly from index.css's `:root.light`
// override (a printed PDF is always on a white page, so the dark-mode
// tokens would never apply here anyway). Main can't consume CSS variables
// at printToPDF time, so these are hardcoded copies — keep in sync by hand
// if index.css's light palette ever changes.
const COLOR_ACCENT = '#6e7bf2'
const COLOR_ACCENT_SOFT = '#6e7bf21a'
const COLOR_POSITIVE = '#12855a'
const COLOR_POSITIVE_SOFT = '#12855a14'
const COLOR_WARNING = '#a76b13'
const COLOR_DANGER = '#cf3b3b'
const COLOR_INK = '#16181d'
const COLOR_MUTED = '#5b6270'
const COLOR_FAINT = '#6b7280'
const COLOR_LINE = '#e3e5e9'
const COLOR_LINE_SOFT = '#edeef1'
const COLOR_SURFACE = '#f7f7f8'

// A loose, structurally-minimal shape for what this file reads off the
// on-disk report — main can't import the renderer's CoachingReport type, and
// the JSON is untrusted (read straight off disk) anyway, so every field is
// optional/defensively accessed below rather than assumed present.
interface ReportEvidence {
  quote?: unknown
  speaker?: unknown
  verified?: unknown
}
interface ReportDimension {
  key?: unknown
  score?: unknown
  comment?: unknown
  evidence?: ReportEvidence
}
interface ReportImprovement {
  kind?: unknown
  title?: unknown
  detail?: unknown
  evidence?: ReportEvidence
}
interface ReportMetrics {
  repSpeaker?: unknown
  talkRatio?: unknown
  longestMonologueWords?: unknown
  longestMonologueMinutes?: unknown
  questionCount?: unknown
  wordsPerMinute?: unknown
  turns?: unknown
}
interface ReportDealContext {
  summary?: unknown
  lens?: unknown
}
interface ReportLike {
  overallScore?: unknown
  dealContext?: ReportDealContext
  strength?: { text?: unknown; evidence?: ReportEvidence }
  dimensions?: unknown
  improvements?: unknown
  nextAction?: unknown
  metrics?: ReportMetrics
  model?: unknown
  createdAt?: unknown
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function tierLabel(score: number): string {
  if (score >= 80) return 'Excellent'
  if (score >= 65) return 'Solid'
  if (score >= 50) return 'Developing'
  return 'Needs work'
}

// Mirrors overallTier()'s tone bands in coaching/meta.ts (good/mid/low),
// mapped onto the light-mode green/amber/red hex values above so the score
// number is color-coded the same way ScoreGauge colors the in-app ring.
function tierColor(score: number): string {
  if (score >= 65) return COLOR_POSITIVE
  if (score >= 50) return COLOR_WARNING
  return COLOR_DANGER
}

// Mirrors scoreTone()'s 1–5 dimension bands in coaching/meta.ts.
function dimensionScoreColor(score: number): string {
  if (score >= 4) return COLOR_POSITIVE
  if (score === 3) return COLOR_WARNING
  return COLOR_DANGER
}

// A tiny local stand-in for coaching/meta.ts's speakerLabel() — main can't
// import renderer code. M19 Task 2: resolved real names, keyed by
// speakerIdentityKey() (must byte-match main/calls-fs.ts's version — this
// file can't import it directly without pulling calls-fs.ts's whole surface
// into a PDF-rendering module, so the tiny key format is duplicated, same as
// this file already duplicates speakerLabel itself from the renderer's
// meta.ts — including its speakerCount>2 disambiguation, since call.speakerCount
// is already sitting right on the same `call` object registerCoachPdf reads
// identities/segments from below; there was never a reason to drop it here.
function pdfSpeakerKey(speaker: number, channel?: number): string {
  return channel === undefined ? `mono/spk${speaker}` : `ch${channel}/spk${speaker}`
}

function speakerLabel(
  speaker: number,
  repSpeaker: number | null,
  identities?: Record<string, { name: string }>,
  channel?: number,
  speakerCount?: number
): string {
  const identity = identities?.[pdfSpeakerKey(speaker, channel)]
  if (identity?.name) return identity.name
  if (repSpeaker === null) return `Speaker ${speaker + 1}`
  if (speaker === repSpeaker) return 'You'
  if (speakerCount !== undefined && speakerCount > 2) return `Speaker ${speaker + 1}`
  return 'Buyer'
}

function evidenceHtml(
  ev: ReportEvidence | undefined,
  repSpeaker: number | null,
  identities?: Record<string, { name: string }>,
  multichannel?: boolean,
  speakerCount?: number
): string {
  if (!ev || typeof ev.quote !== 'string' || !ev.quote.trim()) return ''
  const speaker = typeof ev.speaker === 'number' ? ev.speaker : null
  // Evidence doesn't carry channel directly — in multichannel mode speaker
  // IS the channel (see transcription.ts), so it doubles as one.
  const channel = multichannel && speaker !== null ? speaker : undefined
  const label =
    speaker === null ? 'Speaker' : speakerLabel(speaker, repSpeaker, identities, channel, speakerCount)
  return `
      <div class="evidence">&ldquo;${escapeHtml(ev.quote)}&rdquo; <span class="ev-speaker">— ${escapeHtml(label)}</span></div>`
}

interface MetricRow {
  label: string
  value: string
}

// Simple, defensive formatting of report.metrics — every field is
// optional/nullable per CoachMetrics, so each row is only emitted when its
// underlying value is actually a usable number. This can't reuse the
// renderer's metricRows() helper (different bundling context for main).
function metricRows(m: ReportMetrics | undefined): MetricRow[] {
  if (!m) return []
  const rows: MetricRow[] = []

  rows.push({
    label: 'You talked',
    value: typeof m.talkRatio === 'number' ? `${Math.round(m.talkRatio * 100)}%` : 'N/A'
  })

  if (typeof m.longestMonologueMinutes === 'number') {
    rows.push({ label: 'Longest monologue', value: `${m.longestMonologueMinutes}m` })
  } else if (typeof m.longestMonologueWords === 'number') {
    rows.push({ label: 'Longest monologue', value: `${m.longestMonologueWords}w` })
  }

  if (typeof m.questionCount === 'number') {
    rows.push({ label: 'Questions', value: `${m.questionCount}` })
  }

  rows.push({
    label: 'Pace',
    value: typeof m.wordsPerMinute === 'number' ? `${m.wordsPerMinute} wpm` : 'N/A'
  })

  if (typeof m.turns === 'number') {
    rows.push({ label: 'Turns', value: `${m.turns}` })
  }

  return rows
}

function buildReportHtml(
  callTitle: string,
  createdAt: string,
  report: ReportLike,
  identities?: Record<string, { name: string }>,
  multichannel?: boolean,
  speakerCount?: number
): string {
  const allDimensions = Array.isArray(report.dimensions)
    ? (report.dimensions as ReportDimension[])
    : []
  const dims = DIMENSION_ORDER.map((key) => allDimensions.find((d) => d.key === key)).filter(
    (d): d is ReportDimension => Boolean(d)
  )

  const repSpeaker =
    typeof report.metrics?.repSpeaker === 'number' ? report.metrics.repSpeaker : null

  const dimensionRows = dims
    .map((d) => {
      const key = typeof d.key === 'string' ? d.key : ''
      const score = typeof d.score === 'number' ? d.score : 0
      const comment = typeof d.comment === 'string' ? d.comment : ''
      return `
      <div class="dim">
        <div class="dim-head">
          <span class="dim-label">${escapeHtml(DIMENSION_LABEL[key] ?? key)}</span>
          <span class="dim-score" style="color:${dimensionScoreColor(score)}">${score}/5</span>
        </div>
        <p class="dim-comment">${escapeHtml(comment)}</p>
        ${evidenceHtml(d.evidence, repSpeaker, identities, multichannel, speakerCount)}
      </div>`
    })
    .join('')

  const improvementRows = Array.isArray(report.improvements)
    ? (report.improvements as ReportImprovement[])
        .map((imp) => {
          const title = typeof imp.title === 'string' ? imp.title : ''
          const detail = typeof imp.detail === 'string' ? imp.detail : ''
          return `
      <div class="improvement">
        <span class="tag">${imp.kind === 'strategic' ? 'Strategic' : 'Quick fix'}</span>
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(detail)}</p>
        ${evidenceHtml(imp.evidence, repSpeaker, identities, multichannel, speakerCount)}
      </div>`
        })
        .join('')
    : ''

  const metricCells = metricRows(report.metrics)
    .map(
      (m) => `
      <div class="metric">
        <p class="metric-label">${escapeHtml(m.label)}</p>
        <p class="metric-value">${escapeHtml(m.value)}</p>
      </div>`
    )
    .join('')

  const score = typeof report.overallScore === 'number' ? report.overallScore : 0

  const dealSummary =
    typeof report.dealContext?.summary === 'string' ? report.dealContext.summary : ''
  const dealLens = typeof report.dealContext?.lens === 'string' ? report.dealContext.lens : ''

  const model = typeof report.model === 'string' && report.model ? report.model : ''
  const reportCreatedAt = typeof report.createdAt === 'string' ? report.createdAt : ''

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: ${COLOR_INK}; margin: 40px; }
  h1 { font-size: 20px; margin-bottom: 2px; }
  .meta { color: ${COLOR_FAINT}; font-size: 12px; margin-bottom: 20px; }
  .score-row { display: flex; align-items: baseline; gap: 12px; margin-bottom: 8px; }
  .score { font-size: 40px; font-weight: 700; }
  .tier { font-size: 14px; color: ${COLOR_MUTED}; }
  .deal-context { font-size: 13px; color: ${COLOR_MUTED}; margin-bottom: 20px; }
  .deal-context .lens { font-size: 11px; color: ${COLOR_FAINT}; margin-top: 2px; }
  .metrics { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 20px; }
  .metric { flex: 1 1 110px; border: 1px solid ${COLOR_LINE}; border-radius: 8px; padding: 8px 12px; background: ${COLOR_SURFACE}; }
  .metric-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; color: ${COLOR_FAINT}; margin: 0; }
  .metric-value { font-size: 14px; font-weight: 600; margin: 2px 0 0; color: ${COLOR_INK}; }
  .strength { background: ${COLOR_POSITIVE_SOFT}; border: 1px solid ${COLOR_POSITIVE}; border-radius: 8px; padding: 12px 16px; margin-bottom: 20px; font-size: 13px; }
  .dim { margin-bottom: 14px; }
  .dim-head { display: flex; justify-content: space-between; font-size: 13px; font-weight: 600; }
  .dim-comment { font-size: 12px; color: ${COLOR_MUTED}; margin: 2px 0 0; }
  .improvement { margin-bottom: 14px; }
  .improvement .tag { font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; color: ${COLOR_ACCENT}; }
  .improvement h3 { font-size: 13px; margin: 2px 0; }
  .improvement p { font-size: 12px; color: ${COLOR_MUTED}; margin: 0; }
  .evidence { margin-top: 6px; padding: 6px 10px; border-left: 2px solid ${COLOR_LINE}; background: ${COLOR_SURFACE}; font-size: 12px; font-style: italic; color: ${COLOR_MUTED}; border-radius: 0 6px 6px 0; }
  .evidence .ev-speaker { font-style: normal; color: ${COLOR_FAINT}; }
  .next-action { border: 1px solid ${COLOR_ACCENT}; background: ${COLOR_ACCENT_SOFT}; border-radius: 8px; padding: 14px 16px; margin-top: 20px; font-size: 13px; }
  .attribution { margin-top: 24px; padding-top: 10px; border-top: 1px solid ${COLOR_LINE_SOFT}; font-size: 11px; color: ${COLOR_FAINT}; }
</style>
</head>
<body>
  <h1>${escapeHtml(callTitle)}</h1>
  <p class="meta">Coached call · ${escapeHtml(new Date(createdAt).toLocaleString())}</p>
  <div class="score-row">
    <span class="score" style="color:${tierColor(score)}">${score}</span>
    <span class="tier">/ 100 · ${tierLabel(score)} call</span>
  </div>
  ${
    dealSummary
      ? `<div class="deal-context">${escapeHtml(dealSummary)}${dealLens ? `<div class="lens">Lens: ${escapeHtml(dealLens)}</div>` : ''}</div>`
      : ''
  }
  <div class="metrics">${metricCells}</div>
  ${
    typeof report.strength?.text === 'string' && report.strength.text
      ? `<div class="strength"><strong>What worked:</strong> ${escapeHtml(report.strength.text)}${evidenceHtml(report.strength.evidence, repSpeaker, identities, multichannel)}</div>`
      : ''
  }
  <h2 style="font-size:14px;">Scorecard</h2>
  ${dimensionRows}
  <h2 style="font-size:14px;">Top improvements</h2>
  ${improvementRows}
  ${
    typeof report.nextAction === 'string' && report.nextAction
      ? `<div class="next-action"><strong>Next call:</strong> ${escapeHtml(report.nextAction)}</div>`
      : ''
  }
  ${
    model
      ? `<p class="attribution">Coached by ${escapeHtml(model)}${reportCreatedAt ? ` · ${escapeHtml(new Date(reportCreatedAt).toLocaleString())}` : ''}</p>`
      : ''
  }
</body>
</html>`
}

function callsDir(): string {
  return join(app.getPath('userData'), 'calls')
}

let registered = false

export function registerCoachPdf(): void {
  if (registered) return
  registered = true

  ipcMain.handle(
    'coach:exportPdf',
    async (
      _event,
      callId: string
    ): Promise<{ ok: true; path: string } | { ok: false; error: string }> => {
      const call = await getCall(callsDir(), callId)
      if (!call?.coaching) return { ok: false, error: 'no-report' }

      const { filePath, canceled } = await dialog.showSaveDialog({
        title: 'Export coaching report',
        defaultPath: `${call.title.replace(/[/\\:*?"<>|]/g, '_')} - coaching report.pdf`,
        filters: [{ name: 'PDF', extensions: ['pdf'] }]
      })
      if (canceled || !filePath) return { ok: false, error: 'canceled' }

      const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } })
      try {
        const html = buildReportHtml(
          call.title,
          call.createdAt,
          call.coaching,
          call.speakerIdentities,
          call.segments.some((s) => s.channel !== undefined),
          call.speakerCount
        )
        await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
        const pdf = await win.webContents.printToPDF({})
        await writeFile(filePath, pdf)
        return { ok: true, path: filePath }
      } catch {
        return { ok: false, error: 'failed' }
      } finally {
        win.destroy()
      }
    }
  )
}
