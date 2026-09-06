import { AudioLines, ArrowRight } from 'lucide-react'
import { SampleCallView } from './SampleCallView'

/**
 * M36 Stage 1 — THE SAMPLE CALL BEFORE THE ACCOUNT (the founder's decision,
 * 2026-09-06: "Move the wall. A stranger should reach the sample call without
 * an account.").
 *
 * The re-walk on the clean VM showed the login wall as a stranger's first
 * screen, with the sample call — which stores nothing, needs no key, and is
 * the whole argument for setting the app up — three clicks behind it. This
 * page is the sample call rendered OUTSIDE the signed-in tree: no session,
 * no LiveCallProvider, no MainApp. SampleCallView reads only from
 * sampleCall.ts and touches no IPC, so nothing here can reach a store.
 *
 * Sign-in stays required for everything that stores data — a real call, a
 * key, the Sales Brain — which is why both of the sample's calls to action
 * ("Start my first call", "Add a key") lead to Create an account here, one
 * click, and the bar keeps Log in one click away for someone who has one.
 */
export function GuestSampleCall({
  onCreateAccount,
  onLogin
}: {
  onCreateAccount: () => void
  onLogin: () => void
}): React.JSX.Element {
  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-canvas text-ink">
      {/* Draggable strip so the window can still be moved. */}
      <div className="drag absolute inset-x-0 top-0 h-10" />
      <header
        data-testid="guest-sample-bar"
        className="no-drag relative z-10 flex items-center justify-between gap-3 border-b border-line-soft bg-surface px-5 py-3 pt-10"
      >
        <div className="flex items-center gap-2.5">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-brand">
            <AudioLines className="h-4 w-4 text-white" strokeWidth={2.25} />
          </div>
          <div>
            <p className="text-sm font-semibold leading-tight">CallRise AI</p>
            <p className="text-[12px] text-muted">A sample call — nothing here is saved, and no account is needed to look.</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button type="button" onClick={onLogin} className="text-[13px] text-muted transition hover:text-ink">
            Log in
          </button>
          <button
            type="button"
            onClick={onCreateAccount}
            className="flex items-center gap-1.5 rounded-lg bg-accent-fill px-3.5 py-2 text-sm font-medium text-on-accent transition hover:brightness-110"
          >
            Create an account
            <ArrowRight className="h-4 w-4" />
          </button>
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
        <SampleCallView onStartCall={onCreateAccount} onAddKey={onCreateAccount} />
      </main>
    </div>
  )
}
