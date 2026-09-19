## CallRise AI __TAG__ for Windows and Mac

CallRise AI listens to your sales calls on your own computer, transcribes them, and coaches you live and afterwards. Your calls stay on your machine.

### New in 1.15.0

- **CallRise now runs on Mac.** Same app, same features, and the noise-cancellation denoiser ships with it — a "Sales OS Microphone" device you can turn on from the Home screen to clean up your audio before it reaches the call. This is the first Mac release; if anything looks or behaves differently than the Windows app, that's worth reporting.
- **Live coaching now knows who you're talking to.** When your call's meeting matches a contact you've spoken to before, live coaching now includes what that contact has told you before, sent to your AI provider with the transcript — past objections, promises made and kept, where the deal stands, and what's changed since you last spoke. This needs earlier calls with that contact, so it applies to some contacts and not others: on the tested profile, 30 of 50 contacts got this; "since your last call" specifically — deliberately rare — showed on 5 of 50. The switch: **Voice AI → "Use what this client told you before"**, or **Turn off** on the call itself. It is on by default.
- **The live call screen has a new look.** A redesigned instrument panel: a chip that shows who CallRise thinks you're talking to, a deal-intelligence panel that stays in view as the transcript scrolls, and a coaching-cue rail that no longer gets covered by the transcript or scrolls out of sight mid-call.
- Carried over from 1.14.0: dated contact facts that remember when they were true, the backup fix that stops one machine's edit from overwriting another's, a cleaner name check, and the contact timeline dots.

### Which file to download

**Windows**

- **`CallRise-AI-Windows.exe`** — the installer. This is the one to take. It installs for your user only, no administrator rights needed.
- `CallRise-AI-Windows-Portable.exe` — runs without installing; nothing else is different.

**Mac**

- **`CallRise-AI-Mac.dmg`** — open it and drag CallRise AI into Applications. This is the one to take.
- Needs an Apple Silicon Mac (M1 or later) on macOS 13 (Ventura) or newer. There is no Intel build; on an Intel Mac macOS will refuse to open it.

The other files (`.zip`, `.blockmap`, `latest.yml`, `latest-mac.yml`) are for the app's own updater. You don't need them.

### The warning you will see on Windows, and why

The Windows installer is not yet code-signed, so Edge and Windows treat it as unknown. This is expected and will go away once signing is in place. To get past it in Edge:

1. In the Downloads panel the file shows **"isn't commonly downloaded"**. Right-click it and choose **Keep**.
2. On the **"Make sure you trust CallRise-AI-Windows.exe"** panel, open the small arrow beside **Delete** and choose **Keep anyway**.
3. Click **Open file**. If Windows then shows **"Windows protected your PC"**, click **More info**, then **Run anyway**.

The Mac app is signed and notarized with Apple, so macOS opens it without a warning. If you ever see "CallRise AI is damaged and can't be opened", the download was interrupted — delete it and download again.

### First start

The first start after installing takes up to half a minute before a window appears. Wait for it rather than double-clicking again.

You will be asked to create an account and to confirm it by email, then a short setup runs. Live transcription needs a free **Deepgram** key and coaching needs one **AI provider** key; the setup and the Settings page tell you where to get each. Both are optional to look around, and required for a call to be transcribed.

**On a Mac**, two prompts come from macOS itself, not from us: microphone access (needed to hear you at all) and, when you switch on **Noise cancellation** from the Home screen, an administrator password — that step installs the "Sales OS Microphone" audio device, which is what removes background noise before your voice reaches the call. Both are one-time.

Needs Windows 10 or 11, 64-bit, or macOS 13 (Ventura) or newer on Apple Silicon. Questions and problems: open an issue on this repository.
