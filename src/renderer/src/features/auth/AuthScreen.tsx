import { useState, type FormEvent } from 'react'
import { AudioLines, Loader2 } from 'lucide-react'

type Mode = 'login' | 'signup' | 'confirm'

// Supabase's email OTP length is configurable from 6 to 10 digits, so accept
// the whole numeric code rather than locking the field to one exact length.
const OTP_MIN = 6
const OTP_MAX = 10

const inputClass =
  'w-full rounded-lg border border-line bg-canvas px-3 py-2.5 text-sm text-ink placeholder:text-faint transition focus:border-accent focus:outline-none'

const primaryBtn =
  'flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-3.5 py-2.5 text-sm font-medium text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60'

function Brand(): React.JSX.Element {
  return (
    <div className="mb-6 flex flex-col items-center gap-3 text-center">
      <div className="grid h-11 w-11 place-items-center rounded-xl bg-brand shadow-sm">
        <AudioLines className="h-5 w-5 text-white" strokeWidth={2.25} />
      </div>
      <div>
        <h1 className="text-lg font-semibold tracking-tight">CallRise AI</h1>
        <p className="mt-0.5 text-[13px] text-muted">Your AI assistant for sales calls</p>
      </div>
    </div>
  )
}

/** Shown when the Supabase keys are missing from .env. */
function NotConfigured(): React.JSX.Element {
  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200">
      <p className="font-medium">Accounts aren’t set up yet</p>
      <p className="mt-1 text-amber-200/80">
        Add <code className="rounded bg-canvas px-1 py-0.5 text-amber-100">SUPABASE_URL</code> and{' '}
        <code className="rounded bg-canvas px-1 py-0.5 text-amber-100">SUPABASE_ANON_KEY</code> to
        your <code className="rounded bg-canvas px-1 py-0.5 text-amber-100">.env</code> file, then
        fully restart the app (stop{' '}
        <code className="rounded bg-canvas px-1 py-0.5 text-amber-100">npm run dev</code> and start
        it again).
      </p>
    </div>
  )
}

export function AuthScreen({ configured }: { configured: boolean }): React.JSX.Element {
  const [mode, setMode] = useState<Mode>('login')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  const clearMessages = (): void => {
    setError(null)
    setInfo(null)
  }

  const go = (next: Mode): void => {
    clearMessages()
    setMode(next)
  }

  const submitLogin = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    setBusy(true)
    clearMessages()
    try {
      const res = await window.api.auth.signIn(email.trim(), password)
      if (res.ok) return // success — the gate swaps to the app via the broadcast
      if (res.error === 'email-not-confirmed') {
        setMode('confirm')
        setInfo('Enter the code we emailed you to finish setting up your account.')
        setBusy(false)
        return
      }
      setError(res.message)
      setBusy(false)
    } catch {
      setError('Something went wrong. Please try again.')
      setBusy(false)
    }
  }

  const submitSignup = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    setBusy(true)
    clearMessages()
    try {
      const res = await window.api.auth.signUp(email.trim(), password, name.trim() || undefined)
      if (res.ok) {
        // If confirmations are off, we're already logged in — the gate swaps to
        // the app, so leave the button busy and let it unmount.
        if (res.status === 'signed-in') return
        setBusy(false)
        setCode('')
        setMode('confirm')
        setInfo(`We sent a code to ${email.trim()}. Enter it below to finish.`)
        return
      }
      setBusy(false)
      setError(res.message)
    } catch {
      setBusy(false)
      setError('Something went wrong. Please try again.')
    }
  }

  const submitConfirm = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    setBusy(true)
    clearMessages()
    try {
      const res = await window.api.auth.verifyOtp(email.trim(), code.trim())
      if (res.ok) return // success — the gate swaps to the app
      setError(res.message)
      setBusy(false)
    } catch {
      setError('Something went wrong. Please try again.')
      setBusy(false)
    }
  }

  const resend = async (): Promise<void> => {
    clearMessages()
    try {
      const res = await window.api.auth.resendCode(email.trim())
      if (res.ok) setInfo('A new code is on its way — check your email (and spam folder).')
      else setError(res.message)
    } catch {
      setError('Could not resend the code. Please try again.')
    }
  }

  return (
    <div className="relative flex h-screen w-screen items-center justify-center bg-canvas px-6 text-ink">
      {/* Draggable strip so the window can still be moved. */}
      <div className="drag absolute inset-x-0 top-0 h-10" />

      <div className="w-full max-w-sm">
        <Brand />

        {!configured ? (
          <NotConfigured />
        ) : (
          <div className="rounded-2xl border border-line-soft bg-surface p-7">
            {mode === 'confirm' ? (
              <form onSubmit={submitConfirm} className="space-y-4">
                <div>
                  <h2 className="text-sm font-semibold">Confirm your email</h2>
                  <p className="mt-1 text-[13px] text-muted">
                    Enter the code we emailed to{' '}
                    <span className="text-ink">{email.trim() || 'your inbox'}</span>.
                  </p>
                </div>
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={OTP_MAX}
                  value={code}
                  autoFocus
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, OTP_MAX))}
                  placeholder="Enter the code"
                  className={`${inputClass} text-center text-lg tracking-[0.3em]`}
                />
                {error && <p className="text-[13px] text-rose-300">{error}</p>}
                {info && <p className="text-[13px] text-emerald-300">{info}</p>}
                <button
                  type="submit"
                  disabled={busy || code.length < OTP_MIN}
                  className={primaryBtn}
                >
                  {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                  {busy ? 'Confirming…' : 'Confirm & log in'}
                </button>
                <div className="flex items-center justify-between text-[13px]">
                  <button
                    type="button"
                    onClick={resend}
                    disabled={busy}
                    className="text-muted transition hover:text-ink disabled:opacity-50"
                  >
                    Resend code
                  </button>
                  <button
                    type="button"
                    onClick={() => go('login')}
                    className="text-muted transition hover:text-ink"
                  >
                    Back to log in
                  </button>
                </div>
              </form>
            ) : mode === 'signup' ? (
              <form onSubmit={submitSignup} className="space-y-4">
                <h2 className="text-sm font-semibold">Create your account</h2>
                <div className="space-y-3">
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Name (optional)"
                    className={inputClass}
                  />
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@company.com"
                    className={inputClass}
                  />
                  <input
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Password (at least 6 characters)"
                    className={inputClass}
                  />
                </div>
                {error && <p className="text-[13px] text-rose-300">{error}</p>}
                <button
                  type="submit"
                  disabled={busy || !email || password.length < 6}
                  className={primaryBtn}
                >
                  {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                  {busy ? 'Creating account…' : 'Create account'}
                </button>
                <p className="text-center text-[13px] text-muted">
                  Already have an account?{' '}
                  <button
                    type="button"
                    onClick={() => go('login')}
                    className="font-medium text-accent transition hover:brightness-110"
                  >
                    Log in
                  </button>
                </p>
              </form>
            ) : (
              <form onSubmit={submitLogin} className="space-y-4">
                <h2 className="text-sm font-semibold">Log in</h2>
                <div className="space-y-3">
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@company.com"
                    className={inputClass}
                  />
                  <input
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Password"
                    className={inputClass}
                  />
                </div>
                {error && <p className="text-[13px] text-rose-300">{error}</p>}
                {info && <p className="text-[13px] text-emerald-300">{info}</p>}
                <button type="submit" disabled={busy || !email || !password} className={primaryBtn}>
                  {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                  {busy ? 'Logging in…' : 'Log in'}
                </button>
                <p className="text-center text-[13px] text-muted">
                  New here?{' '}
                  <button
                    type="button"
                    onClick={() => go('signup')}
                    className="font-medium text-accent transition hover:brightness-110"
                  >
                    Create an account
                  </button>
                </p>
              </form>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
