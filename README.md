# Lunch Vote SMS

Runs a weekly lunch poll for a small group (10-25 people) entirely over SMS,
sent from a dedicated phone via the [SMS Gateway for
Android](https://sms-gate.app) app's cloud relay. Sending the weekly poll,
classifying replies, and drafting a digest are automatic; only the final
"text the group where we're going" step waits on a human (you) approving or
overriding the digest. Group members can also propose an ad-hoc activity
("let's have a game night, who can host?" / "let's go to Emerald Tavern")
any time, independent of the weekly poll — see **Activity ideas** below.

## What it does

1. **Monday** — `sendAnnouncement` (Cloud Scheduler) texts every group
   member the week's poll options individually, from the dedicated number.
2. **All week** — group members text back a vote, a number, or loose
   sentiment ("something spicy"). `voteWebhook` receives each inbound text
   via the SMS Gateway cloud relay and hands it to `classifyVote`, which
   uses Haiku to match it against the poll's options (grounded in each
   option's tags). A confident match is recorded; anything else is left
   alone — no automated reply, no logged "failure." It's just an ordinary
   text in your Messages app for you to notice and answer personally if you
   want to.
3. **Wednesday** — `sendVoteReminder` (Cloud Scheduler) texts a one-time
   nudge to any active member who hasn't voted yet, so silence before the
   digest generates isn't just assumed as "no opinion."
4. **Thursday** — `generateDigest` (Cloud Scheduler) reads the week's votes,
   has Haiku synthesize a tally + sentiment themes + a recommended pick
   (nudged to avoid repeating the last `AVOID_REPEAT_WEEKS` picks unless
   votes clearly favor a repeat anyway), and texts that digest to **your own
   number**. The poll moves to `awaiting_approval`.
5. **You reply** — texting back (from your own number) routes to
   `approvalHandler` instead of vote classification. Reply `approve` to
   confirm the digest's recommendation, or `override <option>` to pick
   something else — either exact keywords or free-form phrasing (Haiku
   fills in for anything the exact match doesn't recognize). Either way,
   `sendFinalAnnouncement` texts the group the confirmed where (and when, if
   set) and the poll moves to `sent`. If you haven't replied by **Friday**,
   `sendApprovalReminder` texts you one more nudge.

Sending from a phone dedicated to this project (rather than your daily
driver) keeps the automation's texts separate from your own — see **Manual
setup** for getting a second number onto a device without needing a
business-messaging account (Twilio, etc.) at all.

## Architecture

```text
[Cloud Scheduler: Mon]                    [Cloud Scheduler: Thu]
        |                                          |
        v                                          v
 sendAnnouncement                           generateDigest
   (texts each group                     (Haiku: tally + themes
    member individually)                  + recommendation)
        |                                          |
        v                                          v
  group member replies                   texted to your own number
        |                                          |
        v                                          v
   voteWebhook  <----- SMS Gateway relay -----> voteWebhook
   (inbound SMS webhook)               (your reply, from your own number)
        |                                          |
   sender == your number? ----- no ---- classifyVote (Haiku) --> confident?
        |                                          |                |
       yes                                       (else: left       yes
        |                                        alone, no reply)   |
        v                                                           v
  approvalHandler                                              Firestore
  (approve / override)                                        (votes)
        |
        v
 sendFinalAnnouncement
 (texts each member the
  confirmed where + when)
```

## Repo layout

```text
/functions
  /src
    index.ts                    function exports + admin.initializeApp()
    config.ts                   secrets, collection names, phone hashing, schedules
    voteParsing.ts               pure text-parsing logic (vote/approval/prompt replies)
    webhookSignature.ts          HMAC-SHA256 verification for inbound SMS Gateway webhooks
    voteWebhook.ts               HTTPS function: routes inbound SMS to approval/vote/idea handling
    classifyVote.ts               Haiku tool-use call: free text -> {matched_option, confidence}
    classifyApprovalReply.ts      Haiku fallback for free-form approve/override replies
    classifyActivityIdea.ts       Haiku tool-use call: free text -> {isIdea, kind, activity}
    classifyPromptReply.ts        Haiku fallback for free-form yes/no/maybe prompt replies
    classifyOwnerIntent.ts        Haiku fallback covering every other admin command
    classifyPollTags.ts           Haiku call: option names -> best-effort optionTags
    safeClassify.ts               wraps a classifyX call, falls back instead of throwing
    pollUtils.ts                  shared findOpenPoll query
    generateDigest.ts             scheduled: tally + Haiku summary -> digest doc + SMS to owner
    generateIdeaDigest.ts         scheduled: tallies host/outing responses -> SMS to owner
    sendVoteReminder.ts            scheduled: nudges members who haven't voted yet
    sendApprovalReminder.ts        scheduled: nudges the owner if a digest is still unanswered
    approvalHandler.ts            parses owner's approve/override reply
    inviteHandler.ts               parses owner's "invite <phone>" command, texts the invitee
    pollCommandHandler.ts          parses owner's "poll <option>, ..." command, creates the poll
    ownerCommandHandler.ts         natural-language fallback dispatcher for admin commands
    signupHandler.ts                resolves an invitee's yes/no reply to a pending invite
    memberManagementHandler.ts    admin's "members" / "remove" / "canhost" / "admin" commands
    helpHandler.ts                 "help" for the owner (admin commands) or a member (their commands)
    activityIdeaHandler.ts        creates an activity idea, prompts the relevant members
    promptReplyHandler.ts         resolves a member's reply to a pending host/outing prompt
    sendAnnouncement.ts           scheduled: texts the week's poll to the group
    sendFinalAnnouncement.ts      texts the confirmed pick to the group
    gatewayClient.ts               SMS Gateway (sms-gate.app) Messages API wrapper (send message)
  /test
    voteParsing.test.ts
    webhookSignature.test.ts
  firestore.rules
firestore.indexes.json
firebase.json
```

## Firestore schema

- `polls/{pollId}` — `{ options: string[], optionTags?: Record<string, string[]>, opensAt, closesAt, eventDetails?: string, status, confirmedOption? }`
  (`status`: `open` → `awaiting_approval` → `approved` → `sent`)
- `polls/{pollId}/votes/{phoneHash}` — `{ choice, confidence, receivedAt, rawBody }`
  (upsert on phone hash, so a repeat text overwrites rather than duplicates)
- `polls/{pollId}/digest/current` — `{ tally, totalVotes, themes, recommendedOption, recommendedReason, sentAt, approvalStatus }`
- `groupMembers/{phoneHash}` — `{ name, phoneNumber, active, canHost?, isAdmin?, pendingPrompt? }`
  (`active: false` means invited but not yet confirmed — see **Signup** below;
  `canHost`: eligible to be asked "want to host?" for a `host_needed` idea;
  `isAdmin`: routes this member's texts through the admin command chain —
  see **Admin promotion**; `pendingPrompt`: `{ ideaId }` while awaiting
  that member's yes/no/maybe — set when they're asked, cleared on their
  next reply regardless of whether it parsed)
- `activityIdeas/{ideaId}` — `{ kind, activity, proposerPhoneHash, createdAt, status }`
  (`kind`: `host_needed` | `outing`; `status`: `collecting` → `digested`)
- `activityIdeas/{ideaId}/responses/{phoneHash}` — `{ response, receivedAt }`
  (`response`: `yes` | `no` | `maybe`)

`optionTags` is what lets loose sentiment ("something spicy") resolve to an
actual option instead of the model guessing blind — e.g.
`{ "Chipotle": ["mexican", "casual", "spicy option available"] }`.
`eventDetails` is a free-text field (e.g. `"Friday 12:30pm"`) folded into the
final announcement if set.

**Design note on phone numbers:** votes are keyed and stored purely by
`sha256(digits-only phone number)` — no name or number ever lands in a vote
record, since that's the part of this system that's actually
privacy-sensitive (who voted for what). `groupMembers`, by contrast, already
pairs a `name` with each entry, so it isn't anonymous in any meaningful sense
— it's a roster, and it stores the real `phoneNumber` too (alongside the hash
as the doc ID, used for fast membership lookup) because `sendAnnouncement`
and `sendFinalAnnouncement` have no inbound request to read a number from
the way a reply-triggered send does. The owner's own number (`MY_PHONE_NUMBER`)
is stored in Secret Manager rather than Firestore for the same reason.

Firestore access is Admin-SDK-only — see `firestore.rules`, which denies all
direct client reads/writes.

## Admin commands

None of this requires touching Firestore directly — text the bot number
**from an admin's number** (the root owner, `MY_PHONE_NUMBER`, always is
one; anyone else needs to be promoted first — see **Admin promotion**
below). You don't need to get the exact syntax right: just describe what
you want ("can you add Jane, her number is 512-555-1234" works as well as
`invite Jane 5125551234`). Every command below is also understood in
plain language — the exact syntax is only there because it's free and
instant, not because it's required.

| Command | Plain-language example | Does |
| --- | --- | --- |
| `help` | "what can I do here" | Texts back this list |
| `invite <name>? <phone>` | "add Jake, 512-555-1234" | Invites someone (see **Signup** below) |
| `poll <option>, <option>, ...` | "let's do a poll for chipotle or panera" | Starts a new poll (see **Poll creation** below) |
| `approve` | "yeah let's go with that" | Confirms the digest's recommended pick |
| `override <option>` | "let's actually do panera instead" | Picks a different option than recommended |
| `members` | "who's in the group" | Texts back every group member and their status (pending / active / active, can host / admin) |
| `remove <name or phone>` | "take Jake out of the group" | Deletes that member's `groupMembers` doc |
| `canhost <name or phone> yes\|no` | "Jake can host from now on" | Sets whether that member gets asked to host a `host_needed` activity idea |
| `admin <name or phone> yes\|no` | "make Jake an admin" | Promotes or demotes another admin (see **Admin promotion** below) |

Under the hood: `voteWebhook` first tries each command's exact syntax in
turn (all free, instant, no API call — see `ADMIN_COMMAND_HANDLERS` in
`voteWebhook.ts`), including `approve`/`override`'s own existing
fast-path-then-Haiku-fallback (`approvalHandler.ts`). Only if *none* of
those match does it fall through to `classifyOwnerIntent` (one Haiku
call covering `invite`/`poll`/`members`/`remove`/`canhost`/`admin`/`help`)
— see `ownerCommandHandler.ts`. Both paths call the same underlying
Firestore actions and reply to whichever admin actually sent the command,
so which path fires is invisible to you either way.

`<name or phone>` in `remove`, `canhost`, and `admin` matches
case-insensitively against a member's stored `name`, or — if what you
typed normalizes to 10 or 11 digits — directly by phone number, so either
`remove Jane` or `remove 5125551234` finds the same person.

## Admin promotion

There's always exactly one root admin — whoever controls
`MY_PHONE_NUMBER` in Secret Manager. Only an admin can create new ones:
text `admin <name or phone> yes` to promote an existing `groupMembers`
doc to `isAdmin: true`, which routes their future texts through the same
admin command chain the root owner uses (including `admin` itself — a
promoted admin can promote others, or demote anyone, including
themselves, with `admin <name or phone> no`). Demoting just clears the
flag; it doesn't remove them from the group the way `remove` does.

The root admin can't be demoted this way — `MY_PHONE_NUMBER` isn't a
`groupMembers` doc at all, it's a permanent, secret-backed identity
checked before any Firestore lookup happens, so there's always at least
one admin who can't be locked out by a mistaken `admin ... no`.

Active members have their own, shorter command: texting **`help`** back
to the bot texts them what *they* can do (vote, propose an activity, reply
yes/no/maybe to a prompt) — see `helpHandler.ts`.

## Poll creation

Text `poll <option>, <option>, ...` (comma-separated, at least two) — or
just describe it in plain language, e.g. "start a poll for chipotle,
panera, and chili's this week." `pollCommandHandler` creates the `open`
poll doc, and `classifyPollTags` (Haiku, best-effort — a failure here just
means the poll gets created with no tags, not a blocked creation) fills in
descriptive `optionTags` for each option, the same as a manually-seeded
poll would have, so loose-sentiment vote matching ("something spicy")
works on a text-created poll too. `sendAnnouncement` still does the actual
weekly send to the group on its own schedule — this just creates the poll
doc, it doesn't immediately text everyone.

## Signup

Text `invite <name>? <phone>` (phone number formats are flexible — digits
only, dashes, dots, or `(512) 555-1234`-style parens all work, and the
number just needs to be at the end of the message; the name is optional).
`inviteHandler` creates a `groupMembers` doc with `active: false` and
texts that number an explanation of what this is, asking them to reply
**YES** to join. Their next reply is read by `signupHandler` as a yes/no
answer (same fast-keyword-then-Haiku-fallback approach as everywhere
else): **yes** sets `active: true`; **no** deletes the invite so a later
re-`invite` starts clean; anything else (a "maybe," or nothing
recognizable) just leaves the invite pending — they can reply again
whenever.

## Activity ideas

Independent of the weekly lunch poll, any group member can propose an
ad-hoc activity at any time, in plain text — no command syntax needed.
`voteWebhook` tries this as a fallback whenever a message isn't a pending
prompt reply and isn't a confident vote (or there's no open poll at all):
`classifyActivityIdea` (Haiku) decides whether it's actually a proposal and,
if so, which of two kinds:

- **`host_needed`** — needs someone to organize it (e.g. "let's have a game
  night, who can host?"). Only members with `canHost: true` are asked.
- **`outing`** — a specific place or event to go to (e.g. "let's go to
  Emerald Tavern" or "let's go to the Red Poppy Festival"). Every other
  active member is asked.

`activityIdeaHandler` creates the `activityIdeas` doc and texts each
targeted member "want to host?" / "want to go?", setting a `pendingPrompt`
on their `groupMembers` doc so their next reply is read as answering that
question (via `promptReplyHandler`) rather than as a vote or a new idea.
`generateIdeaDigest` runs hourly, and once an idea has been collecting
responses for `IDEA_DIGEST_WINDOW_HOURS` (default 24), texts you a
yes/maybe/no tally and marks it `digested`.

Same proposer-anonymity treatment as votes: the ask that goes out to
targeted members never names who proposed it, and the idea doc stores only
`proposerPhoneHash`, not a name or number.

## Webhook verification

SMS Gateway signs every webhook delivery with `X-Signature` and
`X-Timestamp` headers: `X-Signature` is
`hex(HMAC-SHA256(webhookSigningSecret, rawBody + X-Timestamp))` (the raw
JSON body string concatenated directly with the timestamp string, no
separator), where `X-Timestamp` is a Unix-seconds timestamp. `voteWebhook`
recomputes this (constant-time comparison) and rejects anything more than 5
minutes stale, before touching Firestore — see `webhookSignature.ts`.

The signing secret is set once, on the device, in the SMS Gateway app's
webhook settings (or its cloud account dashboard), and must match
`WEBHOOK_SIGNING_SECRET` in Secret Manager exactly. Unlike Twilio-style
URL-signing, this scheme doesn't care what URL the webhook is posted to, so
there's no separate "the deployed URL must match a config param" failure
mode to worry about here.

## Local development

Requires the Firebase CLI (`npm install -g firebase-tools`) and a GCP/Firebase
project (see **Manual setup**, below).

```bash
cd functions
npm install
npm test              # vote-parsing + webhook-signature unit tests
npm run build          # type-check + compile to lib/
```

To run against the Functions + Firestore emulators, you'll also need a JVM
(the Firestore emulator is Java-based) and, on this project specifically,
**Node 20** — not whatever's newest on your machine. The emulator's runtime
sandbox has been observed to silently break `admin.firestore.FieldValue`
(and other namespaced Firestore statics) under Node 24, with no error at
the call site that mentions Node at all — it just throws `Cannot read
properties of undefined`. The code already sidesteps this by importing
from the modular `firebase-admin/firestore` entry point instead of the old
`admin.firestore.*` namespace, which is also just the current recommended
pattern — but if you ever see that exact error locally, mismatched Node
versions are the first thing to check, not a Firestore bug:

```bash
nvm install 20 && nvm use 20     # if not already on 20
firebase use --add               # first time only, picks the GCP project
firebase emulators:start --only functions,firestore
```

Secrets (`SMS_GATEWAY_LOGIN`, `SMS_GATEWAY_PASSWORD`, `WEBHOOK_SIGNING_SECRET`,
`ANTHROPIC_API_KEY`, `MY_PHONE_NUMBER`) aren't pulled from Secret Manager for
the emulator — put real values in a gitignored `functions/.secret.local`
file (dotenv format, one `KEY=value` per line) and the emulator picks them
up automatically.

The emulator prints local URLs for `voteWebhook`, `sendAnnouncement`,
`generateDigest`, and `generateIdeaDigest` (the latter three are scheduled,
not HTTP-triggered — invoke them manually from the emulator UI's "Trigger
now" button while testing, or note that Cloud Scheduler jobs *do* run
against the deployed versions once live, no manual trigger needed there).
You can drive `voteWebhook` directly with `curl` to simulate an inbound text
without SMS Gateway — you'll need to compute a matching HMAC-SHA256
signature over the raw JSON body and a timestamp:

```bash
URL="http://127.0.0.1:5001/<project-id>/us-central1/voteWebhook"
SECRET=your-local-webhook-signing-secret
BODY='{"event":"sms:received","payload":{"sender":"+15555550123","message":"2"}}'
TIMESTAMP=$(date +%s)
SIG=$(printf '%s%s' "$BODY" "$TIMESTAMP" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')

curl -X POST "$URL" \
  -H "Content-Type: application/json" \
  -H "X-Signature: $SIG" \
  -H "X-Timestamp: $TIMESTAMP" \
  --data-raw "$BODY"
```

(You'll also need a matching `groupMembers` doc and an open `polls` doc
seeded in the Firestore emulator first — the Admin SDK, pointed at the
emulator via `FIRESTORE_EMULATOR_HOST=127.0.0.1:8080`, bypasses
`firestore.rules`' deny-all the same way it does in production; a raw
REST call to the emulator's Firestore API would get rejected by those same
rules. `classifyVote`/`classifyActivityIdea`/etc. call the real Anthropic
API even against the emulator, so `ANTHROPIC_API_KEY` in `.secret.local`
needs to be a real, funded key.)

## Manual setup (not automatable from this repo)

1. Create or select a GCP project. Enable billing. Enable the Cloud
   Functions, Cloud Build, Firestore, and Cloud Scheduler APIs.
2. Create a Firestore database in **Native mode**, pick a region (match
   `FIRESTORE_REGION` in `config.ts`, currently `us-central1`).
3. Install and authenticate the `gcloud` CLI locally:
   ```bash
   gcloud auth login
   gcloud config set project <PROJECT_ID>
   ```
4. Get a phone number dedicated to this project, separate from your own —
   either a second SIM in a spare/dedicated Android phone, or a second
   line/eSIM on a dual-SIM phone you already carry. Any prepaid plan with
   texting works; this doesn't need a business-messaging account (Twilio,
   etc.) at all, and no carrier verification process. If the phone runs
   Google Messages, check **Settings → RCS chats** and turn RCS *off* for
   this line specifically — RCS is a separate protocol from SMS, and SMS
   Gateway's inbound detection needs traditional SMS delivery to see
   replies at all.
5. Install [SMS Gateway for Android](https://sms-gate.app) on that phone
   and register a **Cloud mode** account (relays through SMS Gateway's
   cloud service, so the phone doesn't need to expose a public endpoint
   itself). Note the device's Cloud-mode **login and password**.
6. Set a **webhook signing secret** (any strong random string you
   generate) in the app's webhook settings, and register a webhook for the
   `sms:received` event pointing at your `voteWebhook` function's URL. If
   the app's UI doesn't expose webhook registration directly, it's a
   one-line API call once you have the login/password:
   ```bash
   curl -u "<login>:<password>" -X POST \
     -H "Content-Type: application/json" \
     https://api.sms-gate.app/3rdparty/v1/webhooks \
     -d '{"url":"<your voteWebhook URL>","event":"sms:received"}'
   ```
   You'll only have the real deployed URL after the first deploy — deploy
   once with any placeholder, note the printed `voteWebhook` URL, then run
   this. No redeploy needed since the URL isn't stored in this repo's
   config (unlike Twilio-style signing, SMS Gateway's HMAC doesn't care
   what URL it's posted to).
7. Get an Anthropic API key from console.claude.com.
8. Store all secrets (never commit them):
   ```bash
   firebase functions:secrets:set SMS_GATEWAY_LOGIN
   firebase functions:secrets:set SMS_GATEWAY_PASSWORD
   firebase functions:secrets:set WEBHOOK_SIGNING_SECRET    # same value set in the app
   firebase functions:secrets:set ANTHROPIC_API_KEY
   firebase functions:secrets:set MY_PHONE_NUMBER           # your own number, any format
   ```
9. Decide the group's phone-number allowlist, each poll option's
   descriptive tags, and (if using activity ideas) who's `canHost: true`.
   Seed `groupMembers` docs and each week's `polls` doc accordingly — this
   is Firestore config, not a hardcoded list, so it's editable without a
   redeploy. Set `eventDetails` on the poll doc if you want a time/place
   note folded into the final announcement.
10. Adjust `TIMEZONE`, `ANNOUNCEMENT_SCHEDULE`, `VOTE_REMINDER_SCHEDULE`,
    `DIGEST_SCHEDULE`, `APPROVAL_REMINDER_SCHEDULE`,
    `IDEA_DIGEST_WINDOW_HOURS`/`IDEA_DIGEST_CHECK_SCHEDULE`, and
    `AVOID_REPEAT_WEEKS` in `config.ts` to match your actual cadence — the
    defaults (Monday announcement / Wednesday vote reminder / Thursday
    digest / Friday approval reminder, America/New_York, 24h idea window
    checked hourly, avoid the last 2 picks) are placeholders.

## Deploying

```bash
cd functions && npm run build
firebase deploy --only functions
```

`sendAnnouncement`, `sendVoteReminder`, `generateDigest`,
`sendApprovalReminder`, and `generateIdeaDigest` are all `onSchedule`
functions — Firebase provisions their Cloud Scheduler jobs automatically
on deploy, no separate `gcloud scheduler` setup needed.

## Known limitations

- **Single active poll assumed.** All the polling functions query for the
  most recently opened poll in the relevant status; if more than one is
  left in that status simultaneously, only the newest is used (older ones
  silently ignored, not an error).
- **The Haiku-calling functions cost real API calls.** `classifyVote`,
  `classifyApprovalReply`, `classifyActivityIdea`, `classifyPromptReply`,
  `classifyOwnerIntent`, `classifyPollTags`, and `generateDigest`'s summary
  step all hit the Anthropic API live, including against the local
  emulator — see **Cost notes** for expected volume/cost, but there's no
  offline/mock mode built in.
- **Depends on one phone staying online.** Delivery and inbound replies
  both route through the SMS Gateway app on a single device — if it's
  off, out of battery, or disconnected, texts queue up (or are missed
  entirely) until it's back.

## Stretch goals (not implemented)

- A minimal read-only dashboard as a second view onto the same data.

## Cost notes

At this volume (10-25 people, once a week), Firestore, Cloud Functions, and
Cloud Scheduler usage stays comfortably inside GCP's always-free tier (50k
reads/day, 20k writes/day, 2M function invocations/month, 3 free scheduler
jobs).

Sending SMS itself is free here — it rides on the dedicated phone's
existing prepaid plan and SMS Gateway's free Cloud-mode tier, rather than
paying a business-messaging provider's per-segment rates. The real cost is
the phone and its plan (a cheap prepaid line, one-time or ~$15-35/mo
depending on carrier — see the phone/carrier discussion in this project's
history for specifics) plus keeping it powered on and connected.

Haiku 4.5 (`claude-haiku-4-5-20251001`) is $1/$5 per million input/output
tokens. Each `classifyVote`/`classifyActivityIdea`/`classifyPromptReply`
call is a few hundred tokens; the weekly `generateDigest` call reading a
week's worth of votes is maybe 1-2k input tokens. All-in, this piece is
still pennies a month.
