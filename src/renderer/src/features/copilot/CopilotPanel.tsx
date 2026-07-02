import { Sparkles, ArrowUp } from 'lucide-react'

export function CopilotPanel(): React.JSX.Element {
  return (
    <div className="flex h-full flex-col">
      {/* Header — draggable top strip. */}
      <div className="drag flex h-14 shrink-0 items-center gap-2 border-b border-line-soft px-5">
        <Sparkles className="h-4 w-4 text-accent" strokeWidth={2} />
        <span className="text-sm font-medium">AI Copilot</span>
      </div>

      {/* Body — empty state. */}
      <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
        <div className="mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-accent-soft">
          <Sparkles className="h-5 w-5 text-accent" strokeWidth={2} />
        </div>
        <p className="text-sm font-medium">Your copilot is ready</p>
        <p className="mt-1.5 text-[13px] text-muted">
          During calls, live suggestions and answers will appear here.
        </p>
      </div>

      {/* Input placeholder (disabled until we wire up the AI). */}
      <div className="border-t border-line-soft p-3">
        <div className="flex items-center gap-2 rounded-xl border border-line bg-canvas px-3 py-2.5">
          <input
            disabled
            placeholder="Ask your copilot…"
            className="no-drag flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-faint disabled:cursor-not-allowed"
          />
          <button
            type="button"
            disabled
            className="grid h-7 w-7 shrink-0 cursor-not-allowed place-items-center rounded-lg bg-elevated text-faint"
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  )
}
