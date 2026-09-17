# CallRise AI

Desktop AI assistant for sales calls — built with Electron, React, TypeScript, Vite, and Tailwind CSS.

Currently a static UI shell. See [`CLAUDE.md`](CLAUDE.md) for the project guide and conventions, and [`docs/VISION.md`](docs/VISION.md) for the product vision.

## Develop

```bash
npm install      # one-time, installs dependencies
npm run dev      # start the app (opens a window, hot-reloads on save)
```

Build a production bundle with `npm run build`.

### ⚠ `npm install` may leave you with no Electron binary — and the error blames the wrong thing

**Not platform-specific.** This is an npm 11 behaviour, so it applies to any machine doing a
clean install; a machine whose `node_modules` predates the npm upgrade simply hasn't hit it yet.
Found on macOS on 2026-09-17 (M40); it cost about an hour of investigating the wrong thing.

npm 11 gates package lifecycle scripts. `npm install` **succeeds, exit 0**, and prints among
ordinary noise:

```
npm warn allow-scripts   electron@39.8.10 (postinstall: node install.js)
npm warn allow-scripts   Run `npm approve-scripts --allow-scripts-pending` to review
```

Electron's binary is therefore never downloaded, and `npm run dev` dies with:

```
Error: Electron failed to install correctly, please delete node_modules/electron and try installing again
```

which points at a corrupt install rather than at a blocked postinstall. `node_modules/electron/`
looks populated — `dist/` even exists — so the message is believable and wrong.

**The actual tell** (two seconds, and it is unambiguous):

```bash
ls node_modules/electron/path.txt         # missing -> the postinstall never ran
cat node_modules/electron/dist/version    # missing -> nothing was ever extracted
```

**The second-order failure is the one to worry about.** The same gate also blocks this repo's own
`postinstall` (`electron-builder install-app-deps`), which is what rebuilds `better-sqlite3`,
`active-win` and `sharp` against **Electron's** ABI rather than system Node's. Nothing errors. The
addons simply never load in the packaged app — the silent-never-loads failure
[`CLAUDE.md`](CLAUDE.md) already documents for the detection addons, arriving through a door
nobody was watching. **After any install, re-run it explicitly:**

```bash
npx electron-builder install-app-deps
```

Expect it to name each module and the Electron version it built against:

```
• executing @electron/rebuild  electronVersion=39.8.10 arch=arm64
• finished  moduleName=better-sqlite3 arch=arm64
```

**If Electron's binary is missing**, approve the scripts and reinstall, or extract the cached
download directly (the zip is usually already in `~/Library/Caches/electron/<hash>/` on macOS):

```bash
unzip -q -o ~/Library/Caches/electron/<hash>/electron-v<version>-darwin-arm64.zip \
  -d node_modules/electron/dist
```

then write `node_modules/electron/path.txt` containing exactly
`Electron.app/Contents/MacOS/Electron` **with no trailing newline** — `electron/index.js` uses the
file's contents verbatim as a path component, so a stray `\n` yields a path that does not exist.
Verify with `node -p "require('fs').existsSync(require('electron'))"` → `true`.

**Open:** running `node node_modules/electron/install.js` directly *also* exits 0 and does nothing
— no output, no extraction, no `path.txt`. It is not `ELECTRON_SKIP_BINARY_DOWNLOAD` (unset),
`isInstalled()` correctly returns false, and `@electron/get` and `extract-zip` both require
cleanly. **Cause undetermined.** The manual extract above sidesteps it.

> **Note:** the description at the top of this file ("Currently a static UI shell") is badly stale
> — the app is at 1.13.0 with live transcription, CRM, calendar sync and cloud backup. Left for the
> founder to reword rather than silently rewritten.
