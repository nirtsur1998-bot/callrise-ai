# Apple signing certificates — the exact clicks, in order

**For the founder. ~20 minutes, one sitting.** Everything in M40 Stage 2 and Stage 3 is blocked
on this. Written 2026-09-17.

**Nothing here should ever be sent to anyone, including me.** The private keys stay in your
keychain and the notarization secret goes straight into your keychain via a command you run
yourself. At the end you tell me "done" and I verify by listing identity *names* — which are
public information, printed inside every signed app on your machine.

---

## Before you start

- **You must be the Account Holder** of the Apple Developer Program. Developer ID certificates
  cannot be created by a member or admin — the option simply will not appear. If you do not see
  "Developer ID Application" in step 2, that is why.
- Apple caps Developer ID certificates (historically **5 of each type per account**, revocable).
  You are creating one of each. Don't create spares "just in case".
- Your existing keychain has exactly one identity, `Apple Development: nirtsur1998@gmail.com
  (X7C2XR7YZ7)`. That is a **development** certificate and cannot sign anything for distribution.
  You are adding two more; it stays where it is.

---

## Part 1 — Create one CSR (Certificate Signing Request)

This generates a private key **in your keychain** and a request file to upload. One CSR is reused
for both certificates.

1. Open **Keychain Access** (⌘-Space → "Keychain Access").
2. Menu bar: **Keychain Access → Certificate Assistant → Request a Certificate From a Certificate
   Authority…**
3. Fill in:
   - **User Email Address:** `nirtsur1998@gmail.com`
   - **Common Name:** `Nir Tsur Developer ID`
   - **CA Email Address:** leave **empty**
   - Select **Saved to disk**
   - Tick **Let me specify key pair information**
4. **Continue** → save as `CallRiseDeveloperID.certSigningRequest` (Desktop is fine).
5. Key pair settings: **Key Size 2048**, **Algorithm RSA** → **Continue** → **Done**.

> The private key is now in your login keychain. **Do not delete it, and do not move the keychain.**
> Without it the downloaded certificates are useless — this is the single most common way people
> lose a Developer ID and have to revoke and start over.

---

## Part 2 — Developer ID **Application** certificate

Signs the `.driver` bundle, the `.app`, and the helper binaries.

1. Go to <https://developer.apple.com/account/resources/certificates/list>
2. Click the blue **+** (Create a Certificate).
3. Under the **Software** heading, select **Developer ID Application**.
4. If asked which intermediate to use, choose **G2 Sub-CA (Xcode 11.4.1 or later)** — the current one.
5. **Continue** → **Choose File** → select `CallRiseDeveloperID.certSigningRequest` → **Continue**.
6. **Download** the `.cer`.
7. **Double-click the downloaded file** to install it into your login keychain.

---

## Part 3 — Developer ID **Installer** certificate

Signs the `.pkg`. **This is a different certificate type** — it is the one people get to the end
without and discover at the worst moment.

Repeat Part 2 exactly, but at step 3 select **Developer ID Installer**. Upload the **same** CSR
file. Download, double-click to install.

---

## Part 4 — A notarization credential

Notarization uploads the signed artifact to Apple for automated checks. `notarytool` needs
credentials. **Choose ONE.**

### Option A — App Store Connect API key (recommended)

Better for CI later: no dependency on your Apple ID password, no 2FA prompt, independently
revocable.

1. <https://appstoreconnect.apple.com/access/integrations/api>
2. **Team Keys** tab → **+**
3. Name: `CallRise notarization`. Access role: **Developer**.
4. **Generate**, then **download the `.p8` file — you can only download it once.** Keep it
   somewhere safe and out of the repo.
5. Note the **Key ID** (next to the key) and the **Issuer ID** (at the top of the page).

Then store it in your keychain — **run this yourself; the secret never leaves your machine**:

```bash
xcrun notarytool store-credentials "callrise-notary" \
  --key /path/to/AuthKey_XXXXXXXXXX.p8 \
  --key-id <KEY_ID> \
  --issuer <ISSUER_ID>
```

### Option B — App-specific password (simpler, fine to start)

1. <https://account.apple.com> → **Sign-In and Security** → **App-Specific Passwords** → **+**
2. Name it `CallRise notarization`, generate, copy the password.

```bash
xcrun notarytool store-credentials "callrise-notary" \
  --apple-id nirtsur1998@gmail.com \
  --team-id X7C2XR7YZ7 \
  --password <the-app-specific-password>
```

Either way the profile is now named **`callrise-notary`** in your keychain, and every later build
refers to it **by that name**. The secret itself is never in the repo, never in CI logs, and never
in a message to me.

---

## What to send me afterwards

**Just the word "done".**

I will verify by running:

```bash
security find-identity -v
```

and confirming three identities are present, including `Developer ID Application: … (X7C2XR7YZ7)`
and `Developer ID Installer: … (X7C2XR7YZ7)`. Identity names and Team IDs are public — they are
printed inside every signed application on your Mac (Krisp's reads
`Developer ID Application: Krisp Technologies, Inc. (U5R26XM5Z2)`).

### Never send, to me or anyone

- The `.p8` file or its contents
- The app-specific password
- A `.p12` export, or any private key
- Your Apple ID password

If a CI setup later needs the certificate (Stage 3), that is done by exporting a `.p12` and adding
it as an encrypted **GitHub secret** — pasted directly into GitHub's own secret field, never into
a chat, a file, or a commit.

---

## Troubleshooting

**"Developer ID Application" is not in the list.** You are not signed in as the Account Holder, or
the membership has lapsed. Check <https://developer.apple.com/account> → Membership.

**The certificate installs but `security find-identity -v` doesn't show it.** The private key from
Part 1 is missing or in a different keychain. In Keychain Access, find the certificate under
**login → My Certificates** — it must have a **disclosure triangle** revealing a private key
beneath it. No triangle means no key, and the certificate must be revoked and re-created from a
fresh CSR.

**`xcrun notarytool` is not found.** Xcode command line tools are missing:
`xcode-select --install`.
