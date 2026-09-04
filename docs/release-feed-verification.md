# Release feed verification — the five checks

**Run these after every tagged release, before telling anyone it shipped.**

Written down 2026-08-30 because they had been run verbally, every release, from
the founder's memory. A session asked "what is the five-check feed
verification?" and could not find it anywhere in the repo or the vault — which
is the same failure mode as any other undocumented gate: it works exactly as
long as one person is available and remembers.

These verify the **auto-update feed** — the thing `electron-updater` reads to
decide whether a user's app should update itself. A release can look perfect on
the GitHub releases page and still serve nobody, or serve the wrong bytes.

---

## The checks

### 1. The release is LIVE — not a draft, not a prerelease

A draft is invisible to `electron-updater`. A prerelease is invisible unless the
channel is configured for it. Both look completely normal in the web UI when
you are the one who created them.

```bash
gh release view v1.5.2 --json isDraft,isPrerelease,publishedAt
```

Expect `isDraft: false`, `isPrerelease: false`, and a real `publishedAt`.

### 2. The tag names the commit CI built and hashed

**The property is: the tag points at the commit whose bytes CI built and check 4
hashed.** `tag == HEAD == origin/main` is a PROXY for that, and the proxy is what
the automated check compares — cheaper, and usually equivalent.

But they can diverge without the property being violated. **v1.9.1 (2026-09-03):**
a docs-only commit was pushed to `main` AFTER the release was dispatched, so the
tag stayed correctly on the built commit while `origin/main` moved one ahead.
Check 2 went red; the property held. Confirmed by hand: the delta was a single
non-shipped `docs/` file, the tagged commit contained the fix, and check 4
independently proved the served installer's bytes.

```bash
git fetch origin --tags && git rev-parse v1.9.1^{commit} HEAD origin/main
# If they differ, do NOT retag to make this green. Retagging moves the tag OFF
# the commit CI built and hashed -- it makes the check pass by breaking the
# thing the check protects. Instead ask: is the tagged commit the one that was
# built (yes if CI tagged it at dispatch), and is main ahead only by
# non-shipped files? If both, the property holds and the red is a proxy
# artefact -- record why, and note check 4 is the real guarantee of the bytes.
git diff --name-only v1.9.1 origin/main   # must be docs/ or other non-shipped only
```

**And the process rule that avoids the red entirely: push nothing after
dispatching a release until the tag lands.**

### 3. All four assets are attached

Installer, portable, blockmap, and `latest.yml`. A missing `latest.yml` means no
user ever learns the release exists. A missing blockmap means every user
downloads the full installer instead of a delta.

```bash
gh release view v1.5.2 --json assets --jq '.assets[].name'
```

Expect all of: `CallRise-AI-Windows.exe`, `CallRise-AI-Windows-Portable.exe`,
`CallRise-AI-Windows.exe.blockmap`, `latest.yml`.

**GitHub HYPHENATES asset names.** What electron-builder writes locally as
`CallRise AI Windows.exe` is served as `CallRise-AI-Windows.exe`. This document's
first version listed the spaced names, and the first real run of these checks
looked for those, 404'd, and then **hashed the 404 page** — reporting
"downloaded 0.0 MB" and a mismatching sha512 that read exactly like a corrupt
feed. Three of five checks failed on a release that was perfectly fine.

So don't hardcode the name at all: **take it from `latest.yml`'s own `path:`
field.** That is the file electron-updater actually fetches, which makes it both
the robust choice and the correct thing to be verifying.

### 4. `latest.yml` from the PUBLIC URL, and its hash checked against the REAL installer

Fetch the manifest from the actual public URL — not from `dist/`, not from the
API — because what matters is what a user's app downloads. Then **download the
installer and hash it yourself.**

**Do not trust the manifest against itself.** A manifest whose `sha512` matches
the file it was generated from is self-consistent and proves nothing; the
question is whether the manifest matches the bytes actually being served. If
they disagree, every update fails signature validation and users see a silent
no-op or a scary error.

```bash
curl -sL https://github.com/nirtsur1998-bot/callrise-ai/releases/latest/download/latest.yml
```

Read `version` (must equal the tag) and `sha512`. Then:

```bash
curl -sL -o /tmp/installer.exe "https://github.com/nirtsur1998-bot/callrise-ai/releases/latest/download/CallRise-AI-Windows.exe" && openssl dgst -sha512 -binary /tmp/installer.exe | openssl base64 -A
```

The output must equal the manifest's `sha512` exactly.

### 5. `/releases/latest` resolves to the new tag, the installer URL returns 200, and the staging percentage is right

`/releases/latest` is what the updater follows. It can lag, or point at an older
release if this one is a prerelease or draft (see check 1).

```bash
curl -sI -o /dev/null -w '%{http_code} %{url_effective}\n' -L https://github.com/nirtsur1998-bot/callrise-ai/releases/latest
```

Expect `200` and a URL ending in the new tag.

```bash
curl -sI -o /dev/null -w '%{http_code}\n' -L "https://github.com/nirtsur1998-bot/callrise-ai/releases/latest/download/CallRise-AI-Windows.exe"
```

Expect `200`.

**And `stagingPercentage` in `latest.yml`:** present and correct for a staged
rollout, or **correctly absent** for a 100% release. Present-but-wrong ships to
the wrong fraction; absent-when-you-meant-staged ships to everyone. The default
for a tag push is 10% (see M29's staged-rollout work), so a 100% release is the
case that needs the deliberate check.

---

## Why check 4 is the one that catches real problems

Checks 1–3 and 5 catch a release that is *missing or mislabelled*, which is
usually obvious within a day because nobody updates. Check 4 catches a release
that is **present, correct-looking, and serving bytes that do not match its own
manifest** — which fails per-user, silently, inside the updater, and gets
reported as "the app never updates for me" weeks later.

It is also the only one of the five that cannot be answered by looking at a
page. You have to download the file and hash it.
