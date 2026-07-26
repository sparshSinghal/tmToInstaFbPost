# Social Poster — Telegram → Activepieces → Google Apps Script

A no-server, low-cost automation that lets a small group of authorized Telegram users **draft, AI-caption, approve, and publish** Facebook Page + Instagram posts — all from their phone, without ever touching a spreadsheet or a dashboard.

---

## What is this?

Running social media for an organization or public figure usually involves:

1. Someone in the field captures a photo or records what happened.
2. They send raw content (a few words + images) to a content manager.
3. The content manager writes a polished caption, gets approval, and posts.

This project replaces steps 2 and 3 with a Telegram bot pipeline:

- **Field operator** sends a Telegram message (text + optional photos/videos) to a private bot.
- **Sarvam AI** (Indian multilingual LLM API) auto-generates a clean, polished caption.
- An **approval card** with inline buttons lands in Telegram for the reviewer to approve or edit.
- On approval, the post goes live on **Facebook Page + Instagram** (and optionally mirrors to the linked FB Profile) in ~10 seconds.
- A **confirmation message** with the live post link is sent back on Telegram.

There is no app to install, no server to run, and no dashboard to open. The entire state machine lives in a Google Sheet, the AI and posting logic runs in Google Apps Script, and Activepieces Cloud handles the Telegram I/O and orchestration.

### Who is it for?

Anyone who needs to publish regularly to Facebook/Instagram from a team in the field — political offices, NGOs, small businesses, community organizations — and wants a cheap, reliable, auditable pipeline with a mobile-first UX.

### Stack overview

| Layer | Tool | Cost |
|---|---|---|
| Messaging & approval | Telegram Bot API | Free |
| Orchestration | Activepieces Cloud | Free tier |
| AI captioning | Sarvam AI API | Pay-per-token |
| Publishing | Meta Graph API (FB + IG) | Free |
| State & storage | Google Sheets + Drive | Free (Google account) |
| Business logic | Google Apps Script | Free |

### Key features

- **Multi-media batching** — send several photos over 60 seconds; they land as one carousel post.
- **Interactive approval** — Telegram inline-button card (Approve & Post / Edit Caption). Falls back to text `1`/`2` for older clients.
- **Idempotent design** — every action is safe to retry; deduplication at webhook and row level.
- **Dual ingestion path** — Telegram for mobile field use; original Google Form for desktop use. Both coexist on one sheet.
- **Auto Stories** — every approved post also publishes to Instagram Stories automatically.
- **IG retry** — rows that land at "Posted (FB only)" are retried on Instagram every 30 min for 6 hours.
- **Writer bot** — a separate Telegram bot for stateless Hindi text rewriting and article generation (no posting, no sheet writes).
- **Daily archival** — rows older than 30 days are moved to an Archive tab automatically.

---

## Quick Start

> Full details for each step are in [§4 Setup](#4-setup).

1. **Copy the `.gs` files** into a new Google Apps Script project bound to your Google Spreadsheet.
2. **Fill in secrets** — open `Setup.gs`, paste your real keys into `initScriptProperties()`, run it once, then restore the placeholder values.
3. **Run `ensureHeaders()`** to write column headers I–R on the sheet.
4. **Run `setup()`** to install all time-based triggers.
5. **Deploy as Web App** (Execute as: Me, Who has access: Anyone). Copy the `/exec` URL — this is your `APPS_SCRIPT_URL`.
6. **Create a Telegram bot** via `@BotFather`. Note the token.
7. **Create an Activepieces Cloud account** and add connections for Telegram Bot, Google Sheets, and Google Drive.
8. **Build the inbound flow** following `activepieces-inbound-flow.md`. Paste `<WEBAPP_URL>`, `<SHARED_SECRET>`, and your whitelist inline.
9. **Build the polling flow** following `activepieces-polling-flow.md`.
10. *(Optional)* Build the writer bot flow following `activepieces-writer-flow.md`.
11. **Share your Drive media folder** as "Anyone with the link can view" (see [§4.7](#47-drive-folder-must-be-permanently-shared)).
12. Send a test message to your bot and verify the end-to-end flow.

---

# Telegram → Activepieces → Apps Script — Social Posting Pipeline (v4)

A production-grade automation that lets a small group of authorized Telegram users draft, review, and publish Facebook Page + Instagram posts without ever opening a spreadsheet. The Google Apps Script project remains the AI processing and posting engine — Activepieces is a thin orchestration layer in front of it that handles Telegram I/O, the 60-second media-collection window, approval cards, reminders, and post-success confirmations.

**v4 changes:** swapped messaging-app integration from WhatsApp Cloud API → Telegram Bot API (free, no Meta Business verification, simpler whitelisting), swapped orchestration from n8n → Activepieces Cloud (managed, no self-hosting), and added automatic image aspect-ratio normalization for Instagram (carousels were failing on mixed portrait/landscape sources).

The behavioral changes from v3 are unchanged: multi-media batching via a "Collecting" state, native messaging-app buttons for approval, automatic deduplication of retried webhooks, auto-supersede of stale drafts, polite rejection of "approve"/"edit" without an open draft, daily archival, 30-second polling, retry-on-fail on every external HTTP call.

---

## 1. Pipeline at a glance

```
Telegram message(s) ─┐
                     │  (whitelisted; update_id-deduped)
                     ▼
        Activepieces Inbound Flow
                     │
        ┌────────────┴──────────────┐
        │                           │
  New content                  Button tap
  (text +/- media,             (Approve / Edit inline keyboard)
   possibly multiple                │
   messages in a row)               │
        │                           ▼
        ▼                       Apps Script
  Drive upload                  approve / setStatus
   (per message)                     │
        │                            ▼
        ▼                   Synchronous postRow
  Apps Script                  → FB Page + IG (which mirrors to FB Profile)
  add_to_draft                       │
   (creates or appends                │
    Collecting row)                   │
        │                              │
        ▼                              │
  Status=Collecting (60s window)       │
        │                              │
        │  Activepieces polling (30s)  │
        ▼                              │
  finalize_collecting ─────► Sarvam ──► Draft
                                       │
                          AP polling sees Draft + no Approval_Requested
                                       │
                                       ▼
                          Send Telegram inline-keyboard card
                                       │
                                       └──► (loops back to top)

   Status = Posted / Posted (FB only) / Failed
                  │
                  │  AP polling
                  ▼
           Send Telegram confirmation
```

Two Activepieces flows make this work:

1. **Inbound flow** — Telegram Bot piece's New Message trigger; routes every inbound message/button-tap to the right Apps Script action.
2. **Polling flow** — Schedule trigger every 30 seconds, four sweeps: finalize collecting drafts past their 60-second window, send approval cards for new drafts, send 2-hour reminders, send confirmations after posting.

The Apps Script remains the source of truth for caption generation and FB/IG posting. Activepieces never talks to Sarvam, Facebook, or Instagram directly — only to the Apps Script web app and to Telegram.

**Three-place mirror (FB Page + IG + FB Profile).** The code explicitly posts to FB Page and IG. The user's FB Profile is mirrored from IG via Meta's IG↔FB Profile linking (configured in the IG app's Account Center, not in code). Net result: every approved post lands on all three surfaces.

---

## 2. Design decisions and rationale

### 2.1 Sheet strategy — extend, don't fork

**Decision:** Keep one sheet. Columns A-H are byte-identical to v1 so the legacy Google Form keeps working. Columns I-R are added for the Telegram / Activepieces integration.

**Why:** A second "automation" sheet would mean two sources of truth, two sets of triggers, and synchronization headaches. The existing `processRow()` / `postRow()` / `checkScheduledPosts()` / `checkApprovedPosts()` / `checkPendingIgContainers()` functions all read column constants from `COL.*`, so leaving A-H untouched means none of them needed to change.

A Telegram-sourced row and a form-sourced row are distinguished by whether column J (`Telegram_User_Id`) is populated. The polling workflow keys on this — form rows are ignored by the Telegram confirmation logic, and Telegram rows skip the email reviewer notification (`sendDraftNotification` is gated on the absence of a WA number — see `Processing.gs`).

### 2.2 Media handling — Google Drive links, not Form upload

**Decision:** Activepieces downloads the Telegram media binary, uploads it to a configured Drive folder, and writes the Drive URL into column C in the same `https://drive.google.com/file/d/{id}/view` format the existing `extractAllDriveFileIds()` already parses.

**Why:** The Forms upload field requires an authenticated Google session — there is no public API for it, and headless submission (cookies, hidden form fields) is brittle. Direct Drive upload via Activepieces's Google Drive node is officially supported, faster, and auditable. The downstream code is unchanged because `extractAllDriveFileIds()` already handles arbitrary Drive URLs.

A hidden bonus: Telegram's media URLs **expire in roughly 5 minutes**. Activepieces downloads immediately on receipt, so by the time Apps Script needs the file, it's safely on Drive with no expiry.

### 2.3 Form strategy — keep for backward compatibility, bypass for Telegram

**Decision:** Don't touch the Google Form. Keep `onFormSubmitTrigger` running. Activepieces inserts rows directly via the Google Sheets API and triggers Apps Script via the new Web App endpoint.

**Why:** Two ingestion paths is a feature, not a bug. The reviewer can keep using the form for desktop-driven entry; field operators can use Telegram. Removing the form would force every contributor onto Telegram and would break any existing bookmarks / links your team has.

### 2.4 Approval channel — Telegram interactive, not email

**Decision:** For Telegram-sourced rows, the email reviewer notification is suppressed and the polling workflow sends an approval card on Telegram instead. Form-sourced rows still get the email path.

**Why:** Sending both would be noisy. Telegram users expect Telegram replies; email users have email muscle memory.

### 2.5 Posting trigger — call Apps Script directly, don't wait for the cron

**Decision:** When the user approves on Telegram, Activepieces calls `action=approve` on the Apps Script Web App, which runs `postRow()` synchronously. The existing 4-hour `checkApprovedPosts` trigger is kept as a backstop.

**Why:** A 4-hour worst-case latency is fine for the email path but feels broken on Telegram. Calling synchronously gives ~10-second posting latency. The 4-hour trigger still runs and acts as a safety net for any Approved row that the synchronous call somehow missed (e.g. Apps Script Web App was down).

### 2.6 Conversation state — store on the row, not in Activepieces

**Decision:** "Awaiting Edit" is a sheet status, not Activepieces workflow state.

**Why:** Activepieces workflow static data is workflow-scoped and gets cleared on redeployment. Storing the state on the row makes it durable, observable, and lets multiple replies arrive out of order safely. It also means a single Telegram user can only have one open draft at a time — which is the intended behavior (see edge cases below).

### 2.7 Idempotency — every action is safe to retry

Three layers protect against duplicate processing:

1. The existing `busyOrDone[]` guard in `processRow()` already prevents Sarvam from running twice on the same row. We added `Awaiting Edit` to that list.
2. Each Web App handler checks the row's current status before acting and returns `noop: true` for invalid transitions.
3. A `LockService` script lock wraps the entire `doPost()` so two simultaneous Activepieces calls can't race.

The `Approval_Requested`, `Reminder_Sent`, and `Confirmation_Sent` boolean columns make every poll-driven action idempotent at the Activepieces layer too — once a flag is `TRUE`, the polling sweep skips that row.

---

## 3. Final schema

| # | Letter | Header | Source | Purpose |
|---|--------|--------|--------|---------|
| 1 | A | Timestamp | Form / Activepieces | Original arrival time |
| 2 | B | Caption | Form / Activepieces | Raw input from user (Hindi or mixed) |
| 3 | C | Image/Video Upload | Form / Activepieces | Comma-separated Drive URLs |
| 4 | D | Schedule Date and Time | Form / Activepieces | Optional future schedule |
| 5 | E | PCaption | Apps Script | Sarvam-generated caption (editable) |
| 6 | F | GHeadline | Apps Script | Sarvam-generated headline |
| 7 | G | Status | All | State machine value (see below) |
| 8 | H | Logs | All | Timestamped audit trail |
| 9 | I | Row_ID | Activepieces / Apps Script | UUID; cross-system stable key |
| 10 | J | Telegram_User_Id | Activepieces | Telegram numeric user id (string) |
| 11 | K | Approval_Requested | Polling flow | TRUE once approval card sent |
| 12 | L | Approval_Sent_At | Polling flow | When card was sent (drives reminder) |
| 13 | M | Reminder_Sent | Polling flow | TRUE once 2-hour reminder sent |
| 14 | N | Confirmation_Sent | Polling flow | TRUE once final confirmation sent |
| 15 | O | Posted_At | Apps Script | Timestamp of successful publish |
| 16 | P | FB_Post_ID | Apps Script | Facebook post ID |
| 17 | Q | IG_Post_ID | Apps Script | Instagram media ID |
| 18 | R | Error_Message | Apps Script / Activepieces | Latest one-line error (full history in Logs) |

### Status state machine

```
        ┌───────────────────┐
        │ Telegram message  │ ── form submit ──────────┐
        └─────────┬─────────┘                          │
                  ▼                                    │
        ┌───────────────────┐                          │
        │    Collecting     │  (each new message       │
        │                   │   from same user resets  │
        │                   │   the 60-second window)  │
        └─────────┬─────────┘                          │
                  │ window expires                     │
                  ▼                                    ▼
        ┌───────────────────┐               ┌───────────────────┐
        │       New         │               │       New         │
        │  (form-sourced)   │               │  (Telegram-sourced)│
        └─────────┬─────────┘               └─────────┬─────────┘
                  └─────────────┬─────────────────────┘
                                ▼
                     ┌───────────────────┐
                     │    Processing     │  Sarvam call in flight
                     └─────────┬─────────┘
                               │
              ┌────────────────┴────────────────┐
              │ success                         │ failure
              ▼                                 ▼
      ┌────────────────┐                 ┌────────────┐
      │     Draft      │                 │   Error    │
      └────┬───────────┘                 └────────────┘
           │  user taps Edit button
           ├──────────────►  ┌────────────────┐
           │                 │ Awaiting Edit  │
           │                 └───────┬────────┘
           │                         │ next text msg
           │  ◄──────────────────────┘
           │  user taps Approve OR sends edit
           ▼
      ┌────────────┐
      │  Approved  │
      └─────┬──────┘
            │ if scheduleTime > now (kept for future use; not used by Telegram flow)
            ├──► Scheduled (handled by 4-hour trigger)
            │
            ▼  (immediate)
      Posting (FB) ─► Posting (IG) ─► Posted
                              │
                              ├─► Pending (IG)  if video still encoding
                              │       │
                              │       └─► Posted (after 15-min trigger)
                              │
                              └─► Posted (FB only)  if IG fails

      Failed     = FB posting itself failed (rare; FB API usually succeeds)
      Superseded = a newer draft from the same user replaced this one
                   (set automatically by processRow when finalizing)
```

---

## 4. Setup

You will need:

- A Google Spreadsheet bound to the existing Apps Script project
- A Google Form (optional — backward-compat ingestion path)
- A Google Drive folder dedicated to Telegram media uploads, **shared as "Anyone with the link can view"** (one-time setting in Drive UI — see §4.7)
- A Telegram bot token (created free via @BotFather — no payment, no business verification)
- A Meta for Developers app with the **Instagram Graph API** product enabled, **two Meta access tokens** (a never-expiring Page Access Token for Facebook writes and a long-lived User Access Token for Instagram operations — see §4.4 for why we need both), and a Business/Creator IG account linked to the FB Page
- An Activepieces Cloud account (cloud.activepieces.com — free tier works for personal volume)

### 4.1 Apps Script

1. **Files in the project.** `Config.gs`, `Setup.gs`, `Processing.gs`, `Posting.gs`, `Telegram.gs`, `FormSubmit.gs`, `Archive.gs`. Make sure `WhatsApp.gs` is gone if upgrading from v3 (it's been replaced by `Telegram.gs`).

2. **Set Script Properties.** Open `Setup.gs` → `initScriptProperties()`. The function bakes in `FB_PAGE_ID` and `IG_USER_ID` (public, not secrets). Fill in the real values for the rest:
   - `SARVAM_API_KEY`
   - `FB_PAGE_ACCESS_TOKEN` — never-expiring **Page** Access Token, used for Facebook Page writes only (see §4.4)
   - `IG_USER_ACCESS_TOKEN` — long-lived **User** Access Token, used for Instagram operations only (see §4.4); rotates every ~60 days
   - `NOTIFY_EMAIL` — reviewer email for form-submitted rows (Telegram rows skip email)
   - `ORCHESTRATOR_SHARED_SECRET` — generate a 32+ char random string with a password manager
   - `TELEGRAM_DRIVE_FOLDER_ID` — the Drive folder ID where Activepieces will upload Telegram media
   - `LOG_LEVEL` — `INFO` (default) or `DEBUG`. Flip to `DEBUG` via the Script Properties UI when investigating FB/IG issues; per-step diagnostics land in the Logs column. Set back to `INFO` for steady-state.

   Run `initScriptProperties` once, then immediately replace the secret values with placeholders so they aren't committed to source. (FB_PAGE_ID and IG_USER_ID can stay literal — they're public.)

3. **Add the new headers.** Run `ensureHeaders()` once. It writes column headers I–R if they aren't already present, leaving A–H untouched.

4. **Re-run `setup()`.** Re-installs the form-submit trigger, the 4-hour `checkApprovedPosts`, the 4-hour `checkScheduledPosts`, and the daily `archiveOldPosts`. Safe to re-run.

5. **Deploy the Web App.** Editor → Deploy → New deployment → Type: **Web app**.
   - Description: "Telegram/Activepieces endpoint v4"
   - Execute as: **Me**
   - Who has access: **Anyone** (required so Activepieces can call without OAuth — the shared secret provides authentication)
   - Click Deploy.
   - Copy the `/exec` URL — this is your `APPS_SCRIPT_URL`.

6. **Smoke test.**

   First, hit the `/exec` URL in a browser (GET → `doGet`). You should see:
   ```json
   {"ok":true,"service":"social-poster","version":"v4-telegram"}
   ```
   That confirms the deployment is reachable.

   For a POST smoke test, **do not use plain `curl`**. Apps Script answers POST requests with a 302 redirect to a `script.googleusercontent.com/macros/echo?key=...` URL where the pre-computed response sits. That second-hop endpoint **only accepts GET** — modern curl (8.x+) preserves POST across redirects by default, so it 405s on the second hop and you get a confusing Drive 404 HTML page back. (Activepieces' HTTP piece uses a proper HTTP client and handles this correctly, so your real integration is unaffected — this is only a CLI testing nuisance.)

   Use Python's `requests` instead, which downgrades POST→GET on 302 per RFC 7231:
   ```bash
   URL="$APPS_SCRIPT_URL"
   SECRET="<your_ORCHESTRATOR_SHARED_SECRET>"

   python3 -c "
   import requests
   r = requests.post('$URL', json={'token':'$SECRET','action':'check_update_id','update_id':'smoke-1'})
   print(r.status_code, r.text)
   "
   ```
   Expect: `200 {"ok":true,"seen":false}`.

   To smoke-test the writer-bot action without going through Telegram:
   ```bash
   python3 -c "
   import requests
   r = requests.post('$URL', json={'token':'$SECRET','action':'rewrite_text','input':'आज लीना सिंघल जी ने नज़ीबाबाद में किसानों से मिले'})
   print(r.status_code, r.text)
   "
   ```
   Expect: `200 {"ok":true,"output":"<cleaned-up Hindi>"}`.

   If you must use `curl`, use the manual two-step pattern (POST to capture the Location header, then GET that URL):
   ```bash
   LOC=$(curl -s -o /dev/null -D - -X POST "$URL" \
     -H "Content-Type: application/json" \
     -d "{\"token\":\"$SECRET\",\"action\":\"check_update_id\",\"update_id\":\"smoke-1\"}" \
     | awk 'BEGIN{IGNORECASE=1} /^location:/ {print $2}' | tr -d '\r\n')
   curl -s "$LOC"
   ```

### 4.2 Telegram Bot (free)

1. **Create the bot.** In Telegram, open a chat with `@BotFather` → send `/newbot` → pick a display name → pick a handle ending in `bot` (must be globally unique). BotFather replies with your bot token, shape `1234567890:ABCDEFGHIJKLMN...`. **Save it as the Telegram Bot connection token in Activepieces** (next section).

2. **Find your Telegram user_id.** Open `@userinfobot` in Telegram → it replies with your numeric user id (e.g. `26555995744020286`). This is the value to whitelist in Activepieces. The id is permanent — it never changes even if you change your username.

3. **Start a chat with the bot.** Send `/start` to your bot from your account. Telegram requires the user to message the bot at least once before the bot can DM that user — this is its anti-spam rule.

4. **Optional — configure privacy in BotFather.** Send `/setprivacy` to BotFather → pick your bot → "Disable" if you ever want the bot to read all messages in groups. Default ("Enable") is fine for 1:1 DM use.

5. **No webhook setup needed manually.** Activepieces handles the Telegram `setWebhook` call automatically when you publish the inbound flow.

### 4.3 Activepieces Cloud

1. **Sign up at cloud.activepieces.com.** Free tier covers low-volume personal automation.

2. **Create connections** (Connections → Add):
   - **Telegram Bot** — paste the BotFather token from §4.2.1.
   - **Google Sheets** — OAuth, log in with the Google account that owns the spreadsheet.
   - **Google Drive** — OAuth, same account, scope must include `drive.file`.
   - **HTTP** — no auth needed; the shared secret travels in request bodies.

3. **Build the inbound flow.** Follow `activepieces-inbound-flow.md` step by step. **Free tier note:** Activepieces' free plan does not expose a flow-level Variables tab — the spec instead tells you to paste each value (`<WEBAPP_URL>`, `<SHARED_SECRET>`, `<TELEGRAM_DRIVE_FOLDER_ID>`) literally into the relevant step, and to hard-code the whitelist directly inside the Step 1 Code piece.

4. **Build the polling flow.** Follow `activepieces-polling-flow.md`. Same free-tier caveat — paste `<WEBAPP_URL>` and `<SHARED_SECRET>` literally; pick the spreadsheet + tab from the Google Sheets piece's dropdown rather than typing IDs.

5. **Publish both flows.** Inbound first (so the Telegram webhook is live), then polling.

6. **Export the JSON** (Settings → Export Flow) and replace `activepieces-inbound-flow.md` and `activepieces-polling-flow.md` with the resulting `.json` files. Keeps the repo's source-of-truth aligned with what's actually running.

### 4.4 Meta access tokens (one-time, then ~60-day rotation)

**Why we need two tokens.** Meta's Graph API has an awkward permission split for the endpoints we use:

- **FB Page write endpoints** (`/{page}/photos` with `published=false`, `/{page}/feed` with `attached_media`, `/{page}/videos`) require the caller to *act as the Page*, which only a Page Access Token satisfies. Calling these with a User token returns `(#200) Unpublished posts must be posted to a page as the page itself`.
- **IG container read endpoints** (`GET /{ig-container-id}?fields=status_code`, used to poll for FINISHED before publishing carousels/videos/Stories) reject Page Access Tokens with error 100 / subcode 33 "Authorization Error", even when the Page token has `instagram_basic` bound to the right IG account. This appears to be a Meta-side enforcement quirk affecting Pages on the New Pages Experience. The same read with a User Access Token holding `instagram_basic` succeeds.

So the code uses each token for the endpoints it accepts:

| Token | Property | Used for |
|---|---|---|
| Page Access Token | `FB_PAGE_ACCESS_TOKEN` | All FB Page writes (photos, videos, feed) |
| User Access Token | `IG_USER_ACCESS_TOKEN` | All IG operations (create container, poll status_code, publish) |

**Rotation cadence.** The Page token is minted from a long-lived user token via `/me/accounts` and is effectively non-expiring (only breaks on password change, revocation, or a security event). The User token itself expires after ~60 days per Meta's Data Access Expiration policy, so `IG_USER_ACCESS_TOKEN` needs to be regenerated every ~50 days to be safe. Set a calendar reminder.

**Setup steps.**

1. **IG account type.** The IG account must be **Business** or **Creator**. Switch in Instagram app → Settings → Account type. (Personal accounts cannot use Graph API.)

2. **Link IG to a FB Page.** Easiest path: **Meta Business Suite** at business.facebook.com → Settings → Business assets → Instagram accounts → Add → "Connect to Page" → pick your FB Page. The Account Center / cross-app login link is **not** sufficient for Graph API — it has to be the Page-Settings-Linked-Accounts link.

3. **Add Instagram Graph API as a product** on your Meta for Developers app: developers.facebook.com → My Apps → your app → Add Product → "Instagram Graph API" → Set Up. (Don't follow the "Generate access tokens / Add an Instagram account" subflow — that's for a different IG-direct-login product you don't need.)

4. **Mint a short-lived User Access Token** in Graph API Explorer (developers.facebook.com/tools/explorer):
   - Application dropdown (top right) → your app.
   - User or Page Token → **User Access Token**.
   - Add Permission → check `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `publish_video`, `instagram_basic`, `instagram_content_publish`.
   - Generate Access Token → sign in with the FB account that admins both the Page and the IG.
   - **Verify scopes** at https://developers.facebook.com/tools/debug/accesstoken/ — the `Scopes` row must include all of the above. Granular Scopes on `instagram_basic` and `instagram_content_publish` must point at your IG Business Account ID.

5. **Extend to long-lived User Access Token (~60 days).**
   ```
   GET https://graph.facebook.com/v25.0/oauth/access_token
     ?grant_type=fb_exchange_token
     &client_id={app-id}
     &client_secret={app-secret}
     &fb_exchange_token={short-lived-user-token}
   ```
   The `access_token` in the response is your **long-lived User token**. Debug it again — `Type` should be `User`, `Expires` about 60 days out. **Paste this into `IG_USER_ACCESS_TOKEN` in Apps Script Properties.**

6. **Derive a non-expiring Page Access Token** from the same long-lived user token:
   ```
   GET https://graph.facebook.com/v25.0/me/accounts?fields=name,id,access_token,instagram_business_account{id,username},connected_instagram_account{id,username}&access_token={long-lived-user-token}
   ```
   In the response, find your Page object → its `access_token` is your Page token. Debug it — `Type` should be `Page`, `Expires` should read `Never`. **Paste this into `FB_PAGE_ACCESS_TOKEN` in Apps Script Properties.**

7. **Confirm IG_USER_ID.** From the same `/me/accounts` response, your Page object should have `instagram_business_account.id` (or `connected_instagram_account.id` for pages on the New Pages Experience) populated. That value is your `IG_USER_ID`. It's already baked into `initScriptProperties()` in `Setup.gs` — update it only if you're pointing this at a different account.

**Rotating just the User token.** Every ~50 days: redo steps 4–5, overwrite `IG_USER_ACCESS_TOKEN` in Script Properties. The Page token (`FB_PAGE_ACCESS_TOKEN`) does NOT need to be touched — it's derived from a *previous* user token but has its own independent lifetime. Only redo step 6 if the Page token also breaks (rare — usually only when the underlying FB account changes password or revokes the app).

**Diagnosing token problems.** See `#Debugging` at the bottom of this file for the failure modes each token produces when misconfigured, plus the exact error codes to grep the Logs column for.

### 4.5 Instagram aspect-ratio normalization

Carousel posts to Instagram fail with error code 36003 if the items have mixed or unsupported aspect ratios. The code routes every IG-bound image through `wsrv.nl` (a free public image-resize proxy) with `fit=contain`, padding each image to a fixed canvas (`IG_TARGET_W` × `IG_TARGET_H`, default 1080×1080 = 1:1 square) without cropping. See `getIgImageUrl()` in `Posting.gs`. Change the constants at the top of that section to `1080×1350` if all your content is portrait phone photos and you want a 4:5 canvas with less padding.

The original Drive file is untouched — the proxy generates the padded version on the fly. FB Page receives the original (FB has no aspect-ratio restrictions). Reels/video are unchanged (they're posted at their native ratio; IG accepts 9:16 for Reels).

**Instagram Stories** use a separate canvas (`IG_TARGET_W_STORY` × `IG_TARGET_H_STORY`, default 1080×1920 = 9:16 vertical) so they fill the screen instead of letterboxing. Same wsrv.nl proxy, different output dimensions — see `getIgStoryImageUrl()` in `Posting.gs`.

### 4.5b Instagram Stories (auto-posted alongside the feed post)

After every successful Instagram feed post (single image, single Reel, photo carousel, video carousel, or mixed photos+Reels), the same media is also published as Instagram Stories. Each photo and each video becomes its own Story slide (Stories don't support carousels), so a 4-photo + 1-video post lands as 1 carousel + 1 Reel + 5 Stories.

What you'll see:
- **In the IG app:** the feed post in your Reels/Posts grid, plus 5 Story slides at the top of the Stories tray.
- **In the sheet's `IG_Post_ID` column (Q):** all the IDs comma-separated, feed post(s) first, then Story IDs in image-then-video order. e.g. `<carousel_id>, <story1_id>, <story2_id>, <story3_id>, <story4_id>, <story5_id>`.
- **In the row Logs (column H):** one line per Story posted (or skipped/failed), plus a summary `Instagram Stories: N posted (M failed/skipped).` at the end of each post.

What you can't customize via API (Meta limitation, not a code limitation):
- **No caption text on Stories** — Stories don't render the caption visibly. Stickers, polls, mentions, hashtag chips have to be added manually in the IG app after the fact.
- **No "Share my Reel to my Story"** as a re-share link — Stories created via API are independent media, not re-shares of your Reel.
- **No carousels in Stories** — each item is a separate slide.

Failure handling:
- Per-Story failure is **logged but never aborts** the row. The feed post is the primary content; Stories are bonus reach.
- If the IG feed post itself fails (returning `Posted (FB only)` or `Failed`), Stories are not attempted.
- If a video Reel went to `Pending (IG)` (still processing), Stories for that row are skipped — the pending-trigger only finalizes the Reel, not Stories. You can manually share to Story from the IG app once the Reel publishes.

Stories expire in 24 hours per Meta's standard behavior. If you want a Story preserved beyond that, save it manually as a Highlight in the IG app.

To **disable** Stories without removing the code: comment out the `postIgStoriesForRow(...)` call sites in `postToInstagram` and `postIgMixed` (three call sites, all clearly labeled with comments). The Story helper functions stay in place for re-enabling later.

### 4.5c Automatic IG retry for rows at "Posted (FB only)"

Sometimes a row lands at `Posted (FB only)` because IG had a transient failure (rate limit, brief outage, carousel-parent 9007 race, flaky video upload). The FB post is up; IG didn't make it.

A scheduled Apps Script trigger named `retryFbOnlyRows` automatically re-runs the Instagram path on any such row, **with no manual intervention**. No Telegram command, no Activepieces step — it's pure Apps Script.

**How it works** ([Posting.gs](/Users/sparshsinghal/personal/social-poster/Posting.gs) `retryFbOnlyRows`):

- Trigger fires every **30 minutes** (installed by `setup()` as a time-based trigger).
- Scans the sheet for rows with `Status == "Posted (FB only)"`.
- For each row whose `Posted_At` is **within the last 6 hours** (`FB_ONLY_RETRY_WINDOW_MS`), calls `retryIgForRow(sheet, rowIndex)` — which re-runs the same `postToInstagram` flow (including Stories) without retouching Facebook.
- Rows older than 6 hours are **left alone** — persistent IG failures (codec issue, account block, etc.) shouldn't churn API calls forever.

**Per-row retry budget at the default cadence:**

```
30-min cadence × 6-hour window = up to 12 retry attempts per row
```

Then it stops. The row stays at `Posted (FB only)` permanently.

**State transitions per retry:**

| Outcome | Status after | What happens next |
|---|---|---|
| IG retry succeeds | `Posted` | `IG_Post_ID` stamped. `Confirmation_Sent` reset → polling flow sends a fresh "now on IG too" Telegram message. Row is now fully done; trigger ignores it on subsequent passes. |
| IG video container queued (still processing) | `Pending (IG)` | The existing `checkPendingIgContainers` 15-min trigger publishes when ready. Row exits `Posted (FB only)` and stops being eligible for `retryFbOnlyRows` (it's no longer at that status). |
| IG retry still fails / skipped | `Posted (FB only)` (unchanged) | Failure logged in column H. Row stays eligible for the next trigger pass — until the 6-hour window expires. |

**Tuning:**

- `FB_ONLY_RETRY_WINDOW_MS` in `Posting.gs` — change the window length (default 6 h).
- `everyMinutes(30)` in `Setup.gs` `setup()` — change the cadence. Apps Script supports `1, 5, 10, 15, 30` for sub-hour cadence.

**To disable** the automatic retry: re-run `setup()` after commenting out the `retryFbOnlyRows` trigger installation block. The function itself can stay in `Posting.gs` (harmless if no trigger calls it).

### 4.6 Writer bot (separate Telegram bot, Sarvam-as-a-service)

The writer bot is an independent Telegram bot for two stateless tasks: rewriting Hindi text for grammar/clarity, and generating 3-4 paragraph Hindi news-style articles from a brief. **No sheet writes, no FB/IG posting.** It shares the same Apps Script Web App as the post bot — only the bot identity in Telegram and the Activepieces flow are separate.

Setup:

1. **Create a second Telegram bot** via `@BotFather` → `/newbot`. Save the new token. Send `/start` to the new bot from your account so it can DM you.
2. **Build the writer flow** in Activepieces Cloud following `activepieces-writer-flow.md`. Use a separate Telegram Bot connection (paste the new token) so the two bots' inbound triggers don't collide.
3. **No Apps Script changes needed beyond the v4 deployment** — `Writer.gs` and the two new actions (`rewrite_text`, `generate_article`) on `doPost` are already in place.
4. **Same shared secret** (`ORCHESTRATOR_SHARED_SECRET`) and same `/exec` URL as the post bot. Both bots distinguish themselves to Apps Script via the `action` field.

Usage in Telegram:

| Input | Behavior |
|---|---|
| `/rewrite आज बैठक हुई थी ...` or just `आज बैठक हुई थी ...` (no command) | Returns the cleaned-up Hindi text. |
| `/article श्रीमती लीना सिंघल आज नजीबाबाद में किसानों से मिलीं ...` | Returns a 3-4 paragraph news-style article (200-400 Hindi words). |
| `/help` or `/start` | Replies with usage. |

Prompts are tunable in `Writer.gs` (`REWRITE_SYSTEM_PROMPT` and `ARTICLE_SYSTEM_PROMPT`). Input is capped at 4000 chars (`WRITER_INPUT_MAX_CHARS`) to keep Sarvam roundtrips fast.

### 4.7 Drive folder must be permanently shared

**Required for Instagram posting (and FB video uploads via the wsrv.nl proxy).**

Open Google Drive → navigate to your `TELEGRAM_DRIVE_FOLDER` → right-click → **Share** → **General access** dropdown → set to **"Anyone with the link"**, role **Viewer**. Save.

All existing files inherit this immediately, and all future Activepieces uploads land in the folder with public-read access automatically.

**Why:** Instagram's Graph API and (after the v4 fix) FB's video CDN both fetch media from the URL we provide rather than accepting binary upload. They need to be able to GET the file anonymously. The earlier `makeFilePublic` / `makeFilePrivate` per-file dance has been removed (it kept hitting `Zugriff verweigert: DriveApp` permission errors even with full Drive scope, on edge cases involving AP-uploaded file ownership). One folder-level setting replaces all of that.

**Security note:** Drive file IDs are 33+ char random strings. Anyone with a leaked URL can re-view that specific file but cannot enumerate the folder or discover other files. For personal automation this is the standard tradeoff.

To revert to per-file sharing later, restore the original `makeFilePublic` / `makeFilePrivate` bodies in `Config.gs` (currently no-ops with comment explaining the change).

---

## 5. Testing plan

### 5.1 Happy path (text only)

1. Send "नमस्कार, आज नजीबाबाद में बैठक" from a whitelisted number.
2. Within ~5 seconds, expect a Telegram ack: "Got it. Drafting your post..."
3. Within ~30 seconds, expect a Telegram approval card with the Sarvam-generated headline + caption.
4. Reply "1".
5. Expect "Approved. Posting now..." within seconds.
6. Within ~60 seconds, expect a final confirmation: "Posted to Facebook and Instagram. FB: https://facebook.com/{id}".
7. Verify on the Page and Instagram.

### 5.2 Happy path (image + caption)

Same as 5.1 but attach an image to the Telegram message. Verify column C of the new row contains a Drive URL, and the Drive folder contains the file.

### 5.2b Multi-media album (Collecting state)

1. Send a text message ("नमस्कार आज की बैठक की तस्वीरें देखें").
2. Within 60 seconds, send 3 more images (one at a time, no captions).
3. Verify only **one** new row was created in the sheet, with Status=`Collecting`.
4. Verify column B contains the original text (no concatenation needed because subsequent messages had empty captions); column C contains 4 Drive URLs comma-separated; Timestamp updates with each new arrival.
5. Stop sending. Wait 60–90 seconds.
6. Verify Status flips to `New` → `Processing` → `Draft` automatically.
7. Verify the approval card reflects all 4 media items (FB will get a 4-image gallery; IG will get a 4-item carousel).

### 5.2c Interactive buttons

After the approval card arrives, tap the "Approve & Post" button (don't type anything). Verify the workflow handles the `interactive.button_reply` payload and routes through the same approve branch as text "1".

### 5.3 Edit flow

1. Send a message → wait for approval card → tap **✏️ Edit** button.
2. Expect "Send the corrected caption as your next message." Sheet status flips to `Awaiting Edit`.
3. Send the corrected text (any text message, no slash command needed).
4. Expect "Got it — applied your correction and posting now." Apps Script's `handleAddToDraft` detects the Awaiting Edit state, writes the new text to PCaption, marks Approved, and runs `postRow` synchronously.
5. Verify column E (PCaption) contains the corrected text, status is `Posted` (or `Posted (FB only)` / `Pending (IG)`), and the post is live on FB Page + IG.

**Note on edit-message media:** if the corrective message includes a photo or video, the media is **ignored** — only the text replaces PCaption. The original draft's media stays. (This is intentional — the Edit button means "fix the caption", not "replace the whole post". To replace media, just start a fresh draft instead.)

### 5.4 Whitelist

Send from an unlisted number. Expect "Unauthorized number. Access denied." Verify nothing is appended to the sheet.

### 5.5 Reminder

1. Send a message → get the approval card.
2. Wait 2 hours without replying.
3. Verify a reminder arrives.
4. Verify a *second* reminder does not arrive (the `Reminder_Sent` flag is set on first send).

### 5.6 Sarvam failure

Temporarily corrupt `SARVAM_API_KEY` in Script Properties. Send a message. Expect Status to land at `Error` and a confirmation message with the error text.

### 5.7 Facebook failure

Temporarily corrupt `FB_PAGE_ACCESS_TOKEN`. Send → approve. Expect Status `Failed` and a Telegram confirmation with the FB error.

### 5.8 Backward compatibility

Submit through the existing Google Form. Verify processing still works exactly as v1 (email reviewer, sheet status flow, no Telegram messages).

### 5.9 Idempotency

Manually re-run the Activepieces inbound webhook with the same Telegram `update_id` payload. Verify only one row is created (either via `update_id` dedup if you add one, or simply observe that the user can't accidentally double-post — see Gap #2 below).

### 5.10 Long-running IG video

Send a video. Verify Status flips to `Pending (IG)` after FB success. Verify the on-demand `checkPendingIgContainers` trigger fires within 15 minutes and updates Status to `Posted`. Verify the Telegram confirmation arrives on the next 90-second poll after that.

---

## 6. Edge cases and how they're handled

| Edge case | Behavior |
|-----------|----------|
| Sender not in whitelist | Inbound workflow halts with "Unauthorized number. Access denied." Nothing is appended. |
| Unsupported message type (audio, sticker, location) | Halts with "Sorry, that message type is not supported." |
| Empty text message (e.g. just a sticker reaction) | Falls through to new-post branch, but Apps Script's empty-caption guard sets Status=Error and posts an explanation back. |
| User has an open Draft and sends a new message | Treated as a brand new draft. The old draft remains in `Draft` state and the polling workflow keeps trying to remind, but the user's behaviour signals they've abandoned it — see Gap #4 below. |
| User replies "1" but there's no open Draft | Falls through to new-post branch and creates a row whose Caption is just "1". Sarvam will likely return an Error. (This is a niche; see Gap #3.) |
| Apps Script Web App times out (>6 minutes) | Activepieces retries up to 3 times via the HTTP Request node retry config (set this on the node — default is off). The 4-hour `checkApprovedPosts` trigger picks up any row stuck in Approved. |
| Telegram media URL expired before Activepieces downloads | Activepieces's HTTP node throws — the workflow execution fails visibly in Activepieces's history, but no row is appended. The user's message is silently dropped. Mitigation: low (Activepieces is fast enough); see Gap #5. |
| Concurrent inbound messages | Apps Script's `LockService` serializes web app calls. Sheets writes from Activepieces are also serialized server-side. No race. |
| User edits PCaption via the sheet UI before the Telegram poll fires | Whichever side commits last wins. The polling workflow only sends the approval card once, so the user's WA approval reflects whatever was in PCaption at send time. |
| `Posted_At`, `FB_Post_ID`, `IG_Post_ID` columns missing from sheet (legacy) | `stampPostSuccess()` checks `getLastColumn()` first and silently skips writes. The post still happens; only the audit metadata is missing. Run `ensureHeaders()` to fix. |

---

## 7. What was fixed in v3, and what's still on the list

### Resolved in v3

| v2 gap | v3 fix |
|--------|--------|
| Multi-media — separate webhook per photo created separate rows | New `Collecting` state. `add_to_draft` appends additional media (and text) to the most recent Collecting row from the same user, sliding the Timestamp forward each time. Polling finalizes after 60 s of inactivity. |
| `update_id` retry duplicates | `updateIdSeen()` / `markUpdateIdSeen()` use `CacheService` (6-hour TTL). `add_to_draft` is now naturally idempotent: a retried webhook returns `action: 'deduped'` and Activepieces suppresses the ack. |
| Multiple open drafts per user | `processRow` calls `supersedeOlderDrafts()` before flipping a new draft to `Draft` — older Draft / Awaiting Edit rows for the same WA number become `Superseded` and are skipped by the polling sweeps. |
| "1"/"2" with no open draft | State Router emits a `no_draft_command` branch that sends a polite "no draft awaiting" reply instead of creating a row. |
| Text-mode "1"/"2" replies are clunky | Approval card now uses Telegram interactive buttons (Approve & Post / Edit Caption). Inbound parse handles `interactive.button_reply.id`, and falls back to text "1"/"2"/"approve"/"edit" for clients that don't render buttons. |
| No retry on transient HTTP errors | Every Activepieces HTTP Request, Google Sheets, and Google Drive node has `retryOnFail: true, maxTries: 3, waitBetweenTries: 2000`. |
| 90 s polling latency | Cron lowered to 30 s. The same poll handles all four sweeps — finalize, approve, remind, confirm. |
| No archival | New `archiveOldPosts()` runs daily at 03:00. Moves rows in `Posted / Posted (FB only) / Failed / Error / Superseded` older than 30 days into a sibling `Archive` tab, preserving headers and column widths. |

### Intentionally not changed

- **Schedule parsing from Telegram.** Column D stays in the schema and `handleApprove` still routes to `Scheduled` when a future datetime is set, so the system supports it the moment any other ingestion path populates it. Per your direction, no Telegram-side parsing for now.
- **Synchronous posting on approval.** Already implemented in v2: `handleApprove` runs `postRow` in the same web-app call. No change needed for the "post immediately on approval" requirement.

### Remaining items (low priority, not blocking)

1. **Telegram media URL expiry.** Activepieces's retry-on-fail covers most transient cases, but a 5-minute total window before Telegram's URL dies remains a hard limit. Mitigation is monitoring: add an Activepieces Error Workflow that pings you on inbound-workflow failures.
2. **Outbound rate limiting.** Activepieces retries handle the common 429 case. For high-volume bursts (>80 messages/sec — far above your expected load) consider a `Wait` node before each Send.
3. **Bearer-token-only Web App auth.** The `ORCHESTRATOR_SHARED_SECRET` is the only gate. A small further-reducing measure: rotate quarterly and consider an Activepieces → Apps Script signed-timestamp scheme if the threat model warrants it.
4. **Push-driven approval card.** Polling gives up to 30 s latency after `Draft` lands. To reduce to near-zero, have the Apps Script Web App POST a webhook into Activepieces when Status flips to Draft. Adds cross-system coupling; not worth it at current volume.

### Reliability levers worth pulling for production

- **Add an Error Workflow.** Activepieces supports a global "On Error" workflow per workflow. Wire it to send an email / Slack ping when the inbound or polling workflow fails.
- **Backup the sheet.** A daily Apps Script trigger that copies the sheet to a versioned file in Drive gives you a rollback path.
- **Monitor the Apps Script Executions view.** A regression in Sarvam's API or in the IG endpoint shows up as repeated failures here long before it reaches the user.

---

## 8. File index

| File | Purpose |
|------|---------|
| `Config.gs` | Constants, getters, helpers. Includes Telegram/Activepieces columns, stamp helpers, `findCollectingRowForUser`, `supersedeOlderDrafts`, `updateIdSeen`/`markUpdateIdSeen`. |
| `Setup.gs` | One-time setup. `initScriptProperties` (fill in placeholders for all API keys and IDs), `ensureHeaders`, `setup` (installs form-submit + 4h checks + daily archive triggers). |
| `Processing.gs` | `processRow` — runs Sarvam, supersedes older drafts, sets Draft. Gates email on Telegram-id absence. Includes `callSarvamAPI` and `stripCodeFences` helpers reused by Writer.gs. |
| `Posting.gs` | `postRow` + IG flow. Captures FB/IG post IDs, stamps `Posted_At`. IG image aspect-ratio padding via wsrv.nl proxy (`getIgImageUrl`). |
| `Telegram.gs` | Web App `doPost()` — post-bot actions (`add_to_draft`, `finalize_collecting`, `check_update_id`, `process`, `approve`, `setStatus`, `appendError`) plus writer-bot actions (`rewrite_text`, `generate_article`). Same endpoint for both bots; routed by `action`. |
| `Writer.gs` | Stateless Sarvam-as-a-service for the writer bot. Two prompt-driven helpers (`rewriteHindiText`, `generateHindiArticle`) and the doPost handlers wired into `Telegram.gs`. No sheet I/O. |
| `Archive.gs` | `archiveOldPosts()` moves >30-day terminal rows to an `Archive` tab. Daily trigger. |
| `FormSubmit.gs` | Wires `onFormSubmitTrigger` → `processRow`. |
| `activepieces-inbound-flow.md` | Build spec for the **post bot's** inbound Activepieces flow (Telegram → Sheet/Apps Script). |
| `activepieces-polling-flow.md` | Build spec for the **post bot's** 30 s polling flow (finalize, approval cards, reminders, confirmations). |
| `activepieces-writer-flow.md` | Build spec for the **writer bot's** flow (Telegram → Sarvam-rewrite or article-generate → Telegram reply). Stateless. |
| `README.md` | This file. |

---

## 9. Operational quick-reference

**Force-process a stuck row.** Open Apps Script editor → run `processRow(getSheet(), N)` where N is the 1-based row index.

**Manually approve from desktop.** Edit the sheet: set column G (Status) to `Approved`. The 4-hour `checkApprovedPosts` trigger picks it up. To post immediately, run `postRow(getSheet(), N)` from the editor.

**Re-send the approval card to a user.** Set column K (`Approval_Requested`) to `FALSE` for that row. The next polling cycle (within 90s) will send a fresh card.

**Disable Telegram ingestion entirely without touching code.** In Activepieces, deactivate the inbound workflow. The form path keeps working unchanged.

**Rotate `ORCHESTRATOR_SHARED_SECRET`.** Update both the Apps Script Script Property and the Activepieces env var. Atomic — there's no token version handshake, so update both within a few seconds of each other (or briefly disable the inbound workflow during rotation).

**Roll back to v1.** Deactivate both Activepieces workflows. Apps Script v2/v3 changes are all backward-compatible with the v1 sheet (legacy A-H columns are unchanged); existing form path keeps working.

### 9.1 Debugging Meta tokens {#debugging}

When posting starts failing, first flip `LOG_LEVEL=DEBUG` in Script Properties so per-step diagnostics land in the Logs column, then match the error string below against what shows up.

| Error signature in Logs | What it means | Fix |
|---|---|---|
| `(#200) Unpublished posts must be posted to a page as the page itself` on FB photo/video/feed upload | `FB_PAGE_ACCESS_TOKEN` is a User token, not a Page token | Redo §4.4 step 6. The Token Debugger must show `Type: Page` for this property. |
| `code: 100, subcode: 33, "Authorization Error"` on `GET /{ig-container-id}?fields=status_code` | `IG_USER_ACCESS_TOKEN` is either a Page token, expired, or missing `instagram_basic` | Redo §4.4 steps 4–5. Token Debugger must show `Type: User`, and Granular Scopes must include `instagram_basic` bound to the right IG account ID. |
| `HTTP 403` on any FB or IG call | Token likely revoked, expired past Data Access Expiration (~90d since last user login), or missing a required scope | Debug the token — if `Valid: False`, regenerate. If `Valid: True`, compare its `Scopes` row against the list in §4.4 step 4. |
| `code: 9007, subcode: 2207027, "Media is not ready to be published"` on `/media_publish` | Transient race — Meta's publish endpoint hasn't caught up with a just-created container. `publishIgContainer` has a 60-second retry loop, so this should be caught silently. If it surfaces as a real error, the retry timed out — likely means the container itself failed to finalize. | Check the container's `status_code` manually in Graph API Explorer with `IG_USER_ACCESS_TOKEN`. If it's `ERROR` or `EXPIRED`, the underlying image URL (usually wsrv.nl → Drive) was unreachable when Meta tried to fetch it. |
| Instagram Story fails with `IG container status check error 400` right after main IG post succeeds | Same subcode-33 issue as above, but only visible on the Story path (single-image feed posts don't do a status read; Stories always do) | Same fix — `IG_USER_ACCESS_TOKEN` is wrong or lacks `instagram_basic`. |

**Golden rule:** before assuming code is broken, paste both tokens into the [Token Debugger](https://developers.facebook.com/tools/debug/accesstoken/) and verify: (1) the correct `Type`, (2) all required `Scopes`, (3) `Valid: True`. Most "posting broken" incidents in this project have been one of these three.

---

## 10. Roadmap

### News-article generation bot

The same Telegram → Activepieces → Sarvam plumbing can support a second, independent workflow: the user sends a brief in Telegram, Sarvam drafts a polished news-style article, the user iterates until satisfied, and the result is exported as a Google Doc — no FB/IG posting involved.

**Proposed design:**

- A `/news` command prefix routes the inbound message to the article flow; all other messages continue as social posts — no disruption to existing users.
- A separate `Articles` tab in the same spreadsheet holds article rows, keeping the social posting code untouched.
- A new `Articles.gs` file adds three `doPost` handlers: `article_create`, `article_iterate`, `article_finalize`.
- A separate polling workflow targets the `Articles` tab so article processing can be paused independently.

**Proposed `Articles` tab schema:**

| Col | Header | Set by | Purpose |
|-----|--------|--------|---------|
| A | Timestamp | Activepieces | Row creation time |
| B | Original_Brief | Activepieces | Cumulative user input across iterations |
| C | Current_Article | Apps Script | Sarvam's latest draft |
| D | Iteration_Count | Apps Script | Number of refinement passes |
| E | Status | All | `Drafting` / `Iterating` / `Finalized` / `Error` |
| F | Article_Doc_URL | Apps Script | Google Doc URL, set on finalize |
| G | Logs | All | Timestamped audit trail |
| H | Row_ID | Activepieces / Apps Script | UUID |
| I | Telegram_User_Id | Activepieces | Telegram numeric user id |
| J | Approval_Requested | Polling flow | `TRUE` once draft card sent |
| K | Confirmation_Sent | Polling flow | `TRUE` once Doc link delivered |

---

## Contributing

Pull requests are welcome. For significant changes, please open an issue first to discuss the approach.

- Keep secrets out of code — all credentials go into Google Apps Script Script Properties via `initScriptProperties()` in `Setup.gs`.
- Follow the existing `doPost` action pattern when adding new endpoints to `Telegram.gs`.
- Update the relevant Activepieces `*.md` flow spec if your change affects the Activepieces side.
- Test both the Telegram ingestion path and the Google Form path when touching shared processing logic in `Processing.gs` or `Posting.gs`.

---

## License

[MIT](LICENSE)

