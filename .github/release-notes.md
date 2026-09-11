## CallRise AI __TAG__ for Windows

CallRise AI listens to your sales calls on your own PC, transcribes them, and coaches you live and afterwards. Your calls stay on your machine.

### New in 1.12.0

- **Live coaching remembers who you're talking to.** When a call is matched to a known contact, live coaching now includes what that contact has told you before, sent to your AI provider with the transcript. It needs earlier calls with that contact, so it applies to some contacts and not others — on the profile it was tested on, 30 of 50.
- **"Since your last call."** When something moved since you last spoke — the deal changed stage, you kept a promise, or what they push back on shifted — the coach knows. This is deliberately rare: 5 of 50 contacts on the tested profile. Most calls will not show it, and that is expected.
- **Checks who you're talking to.** If the name a buyer gives doesn't match the contact your meeting is linked to, CallRise asks during the call instead of after.
- **Support bundles include cue timing** — percentiles and counts only, no call ids and no samples.
- Fixed: the "we found a call that was never saved" prompt now shows its warning colour.

### Which file to download

- **`CallRise-AI-Windows.exe`** — the installer. This is the one to take. It installs for your user only, no administrator rights needed.
- `CallRise-AI-Windows-Portable.exe` — runs without installing; nothing else is different.
- The other files (`.blockmap`, `latest.yml`) are for the app's own updater. You don't need them.

### The warning you will see, and why

The installer is not yet code-signed, so Edge and Windows treat it as unknown. This is expected and will go away once signing is in place. To get past it in Edge:

1. In the Downloads panel the file shows **"isn't commonly downloaded"**. Right-click it and choose **Keep**.
2. On the **"Make sure you trust CallRise-AI-Windows.exe"** panel, open the small arrow beside **Delete** and choose **Keep anyway**.
3. Click **Open file**. If Windows then shows **"Windows protected your PC"**, click **More info**, then **Run anyway**.

### First start

The first start after installing takes up to half a minute before a window appears. Wait for it rather than double-clicking again.

You will be asked to create an account and to confirm it by email, then a short setup runs. Live transcription needs a free **Deepgram** key and coaching needs one **AI provider** key; the setup and the Settings page tell you where to get each. Both are optional to look around, and required for a call to be transcribed.

Needs Windows 10 or 11, 64-bit. Questions and problems: open an issue on this repository.
