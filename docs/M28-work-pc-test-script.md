# M28 "Rise" — work-PC test script

**Branch:** `claude/m28-rise` · **merged up to `origin/main` 1.3.6, 0 behind** · suite 2341 passed, typecheck clean.

**Total: ~50 minutes.** Ordered by what is most likely to be broken, not by feature tour.

Everything below assumes you know nothing about the implementation. Where a step says PASS or FAIL, the difference is written so a bug cannot be mistaken for your own mistake. If something is neither PASS nor FAIL as described, that itself is worth reporting — it means I described the wrong thing.

---

## ⚠️ SET THIS UP BEFORE YOU START (~10 min, do it the night before if you can)

Two tests below need data that takes time to create. Discovering that mid-session wastes the session.

| You need | Why | How to check you have it |
|---|---|---|
| **A contact with at least 2 Sales Brain memories** | Test 1 needs a client whose memories EXIST so it can prove Rise distinguishes "exists but unreachable" from "nothing learned" | Settings → Memory Center → filter by that client. You need to SEE at least 2 rows. |
| **A second contact with ZERO memories** | Same test, other half | Same screen — that client shows no rows |
| **Sales Brain ON** | Most of this is meaningless with it off | Settings → Sales Brain → the master toggle is on |
| **At least one AI provider key that works** | Every test sends a real turn | Settings → Model Assignment → at least one provider shows a valid key |
| **A call over ~90 minutes, transcribed** | Test 7 only. SKIP TEST 7 if you don't have one — do not create one for this | Calls list — check the duration |
| **Two PDFs and one image on the desktop** | Test 4 | Any two PDFs. Name them so you can tell them apart. |

**Write down the two contact names now.** The script calls them **CLIENT-WITH-MEMORIES** and **CLIENT-WITHOUT-MEMORIES**.

---

## TEST 1 — Unbound chat naming a client (~6 min) ⭐ THE ONE THAT MATTERS MOST

This is the thing built last and the reason the session is worth having. Before this fix, asking about a client in a normal chat produced a **confident, wrong** answer built from general company facts — indistinguishable from a correct one.

1. Click **Rise** in the left nav.
2. Click **New chat** (do NOT open it from a contact — that would bind it, which is test 2).
3. Type exactly: `what do you know about CLIENT-WITH-MEMORIES?` — substituting the real name.
4. Press Enter. Wait for the full reply.

**PASS —** the reply says it cannot reach that client's memories **in this conversation**, and tells you memories about them **do exist**. It should point you at opening a chat from that client's record. It must NOT list facts about them.

**FAIL —** any of:
- It answers with facts about the client as though it looked them up. **This is the exact bug.** Copy the reply.
- It says it knows nothing about them at all (wrong — they have memories; it should say they are unreachable *here*).
- It says nothing about the limitation and just answers generically about your business.

5. Now start **another New chat** and type: `what do you know about CLIENT-WITHOUT-MEMORIES?`

**PASS —** it says **nothing has been learned** about this client yet. Wording should differ from step 4 — this is "there is nothing to find", not "it exists but is out of reach here".

**FAIL —** identical wording to step 4, or it claims memories exist.

> **Why both halves:** the two point at different actions — open a scoped chat, versus go have the conversation. Collapsing them into "I don't know" is the failure this fix exists to prevent.

---

## TEST 2 — Scoped chat, same question (~5 min)

1. Go to **Contacts** → open **CLIENT-WITH-MEMORIES**.
2. Find the button that opens Rise for this contact (on the contact's detail screen).
3. Confirm the chat shows a **badge naming that client** at the top.
4. Type the same question: `what do you know about CLIENT-WITH-MEMORIES?`

**PASS —** it answers with actual facts about them, with **citation chips** you can click. Clicking a chip opens the memory or call it came from.

**FAIL —**
- It gives the "cannot reach" message from test 1. (That message must NEVER appear in a scoped chat.)
- Citation chips are missing, or clicking one opens nothing / the wrong thing.

5. **Cross-client check.** In this same scoped chat, type: `what about CLIENT-WITHOUT-MEMORIES?`

**PASS —** it does not produce that other client's private details. Saying it can only discuss the bound client is correct.

**FAIL —** it returns the other client's information. **Stop and tell me immediately** — that is a cross-client leak and outranks everything else in this script.

---

## TEST 3 — Nothing binds silently (~3 min)

Per your decision: if Rise ever binds to a client, it must say so visibly, with a way out.

1. **New chat** (unbound).
2. Type `tell me about CLIENT-WITH-MEMORIES` and send.
3. When the reply arrives, look at the **top of the conversation** and the **conversation list on the left**.

**PASS —** the chat is still unbound. No client badge appeared. The title has not silently become that client's name.

**FAIL —** a client badge appears, or the conversation is now scoped to that client, without you having chosen it. **Report this** — auto-binding is not built, so it should be impossible; if it happens, something is wrong in a way I have not predicted.

---

## TEST 4 — Attachments (~8 min)

1. In any chat, attach **one PDF**. Send `summarise this`.

**PASS —** you get a summary that is clearly about that document's contents.

**FAIL —** a generic answer that could describe any document — that means the file was not actually read.

2. New message: attach **two PDFs at once**.

**PASS —** the app tells you only one PDF per message and does not attach the second. You should see a message saying so, and **only one chip** in the composer.

**FAIL —** both chips appear. (Only one would actually be sent — a chip claiming otherwise is the bug.)

3. Attach **one image**, send `what is in this image?`

**PASS —** it describes the image, or clearly says none of your configured models can read images.

**FAIL —** it answers as if it saw the image but describes something that is not there. Note which model you have assigned.

4. **The one most likely to be broken.** Attach a file in a chat, then — **without sending** — click a **different conversation** in the left list, then come back.

**PASS —** the staged file is gone from the composer when you switch. It does not follow you.

**FAIL —** the chip is still there in the other conversation. Worse: send it, and if the other chat receives that file, **report it** — in a client-scoped chat that is one client's document reaching another's.

---

## TEST 5 — Voice notes and the disclosure (~4 min)

1. In any chat, start a **voice note**.

**PASS —** while recording, you can see text saying audio is sent to **Deepgram** for transcription, and that Cancel discards it without uploading.

**FAIL —** nothing on screen says where the audio goes. **This is a transparency issue, not a polish one** — report it even if everything else works.

2. Press **Cancel** mid-recording.

**PASS —** the recording is discarded, nothing is transcribed, nothing is sent.

3. Record again, press **Done**, wait for the transcript.

**PASS —** you see the transcribed text and can review/edit it **before** sending, and the review row also names Deepgram.

**FAIL —** it sends automatically without a review step.

---

## TEST 6 — Formatting (~4 min)

Models emit these shapes constantly; they used to render as raw characters.

1. Ask: `give me a table comparing my last three calls, then a bulleted list of what to do next`

**PASS —**
- The table renders as an actual **table with borders** — not rows of `|` pipe characters.
- Bullets render as **bullets** — not lines starting with `-`.
- Any headings render as bold headings — not lines starting with `##`.
- A wide table scrolls **inside its own box**; the whole chat column must not scroll sideways.

**FAIL —** any raw `|`, `-` or `##` visible as literal text in the reply.

---

## TEST 7 — Long call (~5 min) — SKIP IF YOU HAVE NO 90-MINUTE CALL

1. Open a call **over ~90 minutes**, go to its **coaching chat** (not Rise).
2. Ask something about **the end** of the call: `what did we agree in the last few minutes?`

**PASS —** it answers about the closing minutes.

**FAIL —** it answers about the opening, or says it cannot see that part. **Report it** — that is a known open bug (the transcript is cut from the wrong end) and the fix ships in the hotfix, not in this branch. Confirming it here tells me the fix targets the right thing.

---

## TEST 8 — Status honesty (~3 min)

1. Watch the status line while a reply is being prepared.

**PASS —** if it says **"Reading your Sales Brain…"**, Sales Brain is actually on. With it off, that line must not appear.

2. **Optional, only if quick:** Settings → turn Sales Brain **off** → open Rise → **New chat**.

**PASS —** the empty state says Sales Brain is **switched off** and points at Settings.

**FAIL —** it says your Sales Brain is **empty** and tells you to import call history. That is a wrong instruction — importing cannot help while it is off.

3. **Turn Sales Brain back on before you finish.**

---

## TEST 9 — Stop (~3 min)

1. Ask something long: `write me a detailed plan for winning back a stalled deal`
2. As soon as text starts appearing, press **Stop**.

**PASS —** it stops within about a second. The partial reply stays on screen. You can send another message immediately.

**FAIL —** text keeps arriving after Stop, or the composer stays locked and you cannot send anything.

---

## WHAT NOT TO REPORT

These are known and already logged. Hitting them is expected:

- **Answer quality in an unbound chat** for client questions — that is BUG-096 by design; only test 1's *behaviour* matters, not the depth of the answer.
- **A long call's coaching chat missing the end of the transcript** — test 7, known, fixed in the hotfix.
- Conversation list feeling slow with very many conversations — known, unfixed.
- Attachment or voice files not being cleaned up from disk — known, unfixed.
- Small dialogs looking unstyled — known, unfixed.

## HOW TO REPORT

For anything that FAILs: the **test number**, what you typed **in quotes**, what you expected, what happened. If it is a wrong answer, **copy the reply text** — the wording is the evidence, and for a wrong answer it is the only evidence.
