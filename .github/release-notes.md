## CallRise AI __TAG__ for Windows

CallRise AI listens to your sales calls on your own PC, transcribes them, and coaches you live and afterwards. Your calls stay on your machine.

### New in 1.13.0

- **Update every machine you use.** A backup bug re-uploaded every record on every sync, and an edit made on one machine could be overwritten by another machine's older copy. Fixed — but only once every machine on your account runs this version. Until then, keep edits to one machine.
- **You can now switch off what live coaching remembers.** Since 1.12.0, when a call is matched to a known contact, live coaching now includes what that contact has told you before, sent to your AI provider with the transcript (it applies to some contacts and not others — 30 of 50 on the tested profile). There is now a switch for it: **Voice AI → "Use what this client told you before"**, or **Turn off** on the call itself. It is on by default.
- **The name check is cleaner.** The "who are you talking to?" prompt no longer shows the previous call's name for the first seconds of a new call, and when two of your contacts share a name it lists both so you can pick — it never offers to create a duplicate.
- **Saving a call no longer changes your calendar.** Linking a call to the meeting it happened in is app bookkeeping; it no longer pushes that meeting to Outlook or Google.
- Fixed: the dots on a contact's timeline were half hidden.
- Carried over from 1.12.0: "Since your last call" (deliberately rare — 5 of 50 contacts on the tested profile) and cue timing in support bundles (percentiles and counts only).

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
