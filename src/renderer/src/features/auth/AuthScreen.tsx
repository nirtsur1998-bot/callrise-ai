import { useEffect, useState, type FormEvent } from 'react'
import { AudioLines, Loader2, AlertCircle, CheckCircle2, Eye, EyeOff } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { fieldClass } from '@renderer/components/field'
import { IconButton } from '@renderer/components/IconButton'
import { isMac } from '@renderer/lib/platform'

type Mode = 'login' | 'signup' | 'confirm'

// Supabase's email OTP length is configurable from 6 to 10 digits, so accept
// the whole numeric code rather than locking the field to one exact length.
const OTP_MIN = 6
const OTP_MAX = 10

const primaryBtn =
  'flex w-full items-center justify-center gap-2 rounded-lg bg-accent-fill px-3.5 py-2.5 text-sm font-medium text-on-accent transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60'

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

function ErrorAlert({ message }: { message: string }): React.JSX.Element {
  return (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-danger"
    >
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
      {message}
    </p>
  )
}

function InfoAlert({ message }: { message: string }): React.JSX.Element {
  return (
    <p
      aria-live="polite"
      className="flex items-start gap-2 rounded-lg border border-positive/30 bg-positive-soft px-3 py-2 text-[13px] text-positive"
    >
      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
      {message}
    </p>
  )
}

/** Shown when the Supabase keys are missing from .env. Wording adapts to
 *  dev-vs-packaged (no `npm run dev` to restart in an installed app) and
 *  points at the actual .env location a packaged build reads from, since
 *  that's not a project folder the way it is in dev. */
function NotConfigured(): React.JSX.Element {
  const [packaged, setPackaged] = useState<boolean | null>(null)

  useEffect(() => {
    window.api.app
      .isPackaged()
      .then(setPackaged)
      .catch(() => setPackaged(null))
  }, [])

  const envLocation = isMac
    ? '~/Library/Application Support/sales-os/.env'
    : 'the app’s install folder (next to CallRiseAI.exe), as .env'

  return (
    <div className="rounded-xl border border-warning/30 bg-warning-soft p-4 text-sm text-warning">
      <p className="font-medium">Accounts aren’t set up yet</p>
      <p className="mt-1 text-warning/80">
        Add <code className="rounded bg-canvas px-1 py-0.5 text-warning">SUPABASE_URL</code> and{' '}
        <code className="rounded bg-canvas px-1 py-0.5 text-warning">SUPABASE_ANON_KEY</code> to{' '}
        {packaged ? (
          <>
            a <code className="rounded bg-canvas px-1 py-0.5 text-warning">.env</code> file at{' '}
            <code className="rounded bg-canvas px-1 py-0.5 text-warning">{envLocation}</code>, then
            quit and reopen the app.
          </>
        ) : (
          <>
            your <code className="rounded bg-canvas px-1 py-0.5 text-warning">.env</code> file, then
            fully restart the app (stop{' '}
            <code className="rounded bg-canvas px-1 py-0.5 text-warning">npm run dev</code> and
            start it again).
          </>
        )}
      </p>
    </div>
  )
}

export function AuthScreen({
  configured,
  initialMode = 'login',
  onSample
}: {
  configured: boolean
  /** M36 — the guest sample page hands back 'signup' so "Create an account"
   *  from the sample lands on the form, not on Log in. */
  initialMode?: Mode
  /** M36 — "See a sample call first": the stranger's way past the wall
   *  without an account (the founder's decision, 2026-09-06). Absent → no
   *  link, so any other host of this screen is unchanged. */
  onSample?: () => void
}): React.JSX.Element {
  const [mode, setMode] = useState<Mode>(initialMode)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [showPw, setShowPw] = useState(false)

  const clearMessages = (): void => {
    setError(null)
    setInfo(null)
  }

  const go = (next: Mode): void => {
    clearMessages()
    setMode(next)
  }

  const doLogin = async (): Promise<void> => {
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

  const submitLogin = (e: FormEvent): void => {
    e.preventDefault()
    void doLogin()
  }

  const doSignup = async (): Promise<void> => {
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

  const submitSignup = (e: FormEvent): void => {
    e.preventDefault()
    void doSignup()
  }

  const doConfirm = async (): Promise<void> => {
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

  const submitConfirm = (e: FormEvent): void => {
    e.preventDefault()
    void doConfirm()
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
    <div className="relative flex h-screen w-screen items-center justify-center overflow-y-auto bg-canvas px-6 py-8 text-ink">
      {/* Draggable strip so the window can still be moved. */}
      <div className="drag absolute inset-x-0 top-0 h-10" />

      <div className="w-full max-w-sm">
        <Brand />

        {!configured ? (
          <NotConfigured />
        ) : (
          <div className="animate-view rounded-2xl border border-line-soft bg-surface p-7">
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
                  aria-label="Enter the code"
                  maxLength={OTP_MAX}
                  value={code}
                  autoFocus
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, OTP_MAX))}
                  placeholder="Enter the code"
                  className={cn(fieldClass, 'text-center text-lg tracking-[0.3em]')}
                />
                {error && <ErrorAlert message={error} />}
                {info && <InfoAlert message={info} />}
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
                    autoComplete="name"
                    aria-label="Name (optional)"
                    placeholder="Name (optional)"
                    className={fieldClass}
                  />
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="email"
                    aria-label="you@company.com"
                    placeholder="you@company.com"
                    className={fieldClass}
                  />
                  <div className="relative">
                    <input
                      type={showPw ? 'text' : 'password'}
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoComplete="new-password"
                      aria-label="Password (at least 6 characters)"
                      placeholder="Password (at least 6 characters)"
                      className={cn(fieldClass, 'pr-10')}
                    />
                    <IconButton
                      icon={showPw ? EyeOff : Eye}
                      label={showPw ? 'Hide password' : 'Show password'}
                      onClick={() => setShowPw((v) => !v)}
                      className="absolute top-1/2 right-1 -translate-y-1/2"
                    />
                  </div>
                </div>
                {error && <ErrorAlert message={error} />}
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
                    autoComplete="email"
                    aria-label="you@company.com"
                    placeholder="you@company.com"
                    className={fieldClass}
                  />
                  <div className="relative">
                    <input
                      type={showPw ? 'text' : 'password'}
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoComplete="current-password"
                      aria-label="Password"
                      placeholder="Password"
                      className={cn(fieldClass, 'pr-10')}
                    />
                    <IconButton
                      icon={showPw ? EyeOff : Eye}
                      label={showPw ? 'Hide password' : 'Show password'}
                      onClick={() => setShowPw((v) => !v)}
                      className="absolute top-1/2 right-1 -translate-y-1/2"
                    />
                  </div>
                </div>
                {error && <ErrorAlert message={error} />}
                {info && <InfoAlert message={info} />}
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

        {configured && onSample && mode !== 'confirm' && (
          // M36 — the door past the wall. A stranger who has not decided yet
          // can see what the app does with a call before giving it anything.
          <p className="mt-4 text-center text-[13px] text-muted">
            Not sure yet?{' '}
            <button
              type="button"
              onClick={onSample}
              data-testid="auth-see-sample"
              className="font-medium text-accent transition hover:brightness-110"
            >
              See a sample call first
            </button>
            <span className="block text-[12px] text-faint">No account needed — nothing is saved.</span>
          </p>
        )}
      </div>
    </div>
  )
}
