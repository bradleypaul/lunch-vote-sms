# Lunch Vote SMS

Runs a weekly lunch poll for a small group (10-25 people) entirely over SMS,
from a dedicated Twilio toll-free number. Sending the weekly poll,
classifying replies, and drafting a digest are automatic; only the final
"text the group where we're going" step waits on a human (you) approving or
overriding the digest.

## What it does

1. **Monday** — `sendAnnouncement` (Cloud Scheduler) texts every group
   member the week's poll options individually, from the group's Twilio
   number.
2. **All week** — group members text back a vote, a number, or loose
   sentiment ("something spicy"). `voteWebhook` receives each inbound text
   from Twilio and hands it to `classifyVote`, which uses Haiku to match it
   against the poll's options (grounded in each option's tags). A confident
   match is recorded; anything else is left alone — no automated reply, no
   logged "failure." It's just an ordinary text in your Messages app for you
   to notice and answer personally if you want to.
3. **Thursday** — `generateDigest` (Cloud Scheduler) reads the week's votes,
   has Haiku synthesize a tally + sentiment themes + a recommended pick, and
   texts that digest to **your own number**. The poll moves to
   `awaiting_approval`.
4. **You reply** — texting the group's Twilio number back from your own
   phone routes to `approvalHandler` instead of vote classification. Reply
   `approve` to confirm the digest's recommendation, or `override <option>`
   to pick something else. Either way, `sendFinalAnnouncement` texts the
   group the confirmed where (and when, if set) and the poll moves to
   `sent`.

Using a dedicated Twilio number (rather than a personal phone) is
deliberate: every text the group gets clearly comes from an automated
system, not from you personally — nothing here should read as you texting
someone under your own name when it isn't.

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
   voteWebhook  <---------- Twilio ---------->  voteWebhook
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
    index.ts                 function exports + admin.initializeApp()
    config.ts                secrets, collection names, phone hashing, schedules
    voteParsing.ts             pure text-parsing logic (vote text match, approval replies)
    twilioSignature.ts         HMAC-SHA1 verification for inbound Twilio webhooks
    voteWebhook.ts             HTTPS function: branches inbound SMS to classifyVote/approvalHandler
    classifyVote.ts             Haiku tool-use call: free text -> {matched_option, confidence}
    generateDigest.ts           scheduled: tally + Haiku summary -> digest doc + SMS to owner
    approvalHandler.ts          parses owner's approve/override reply
    sendAnnouncement.ts         scheduled: texts the week's poll to the group
    sendFinalAnnouncement.ts    texts the confirmed pick to the group
    smsClient.ts                 Twilio Messages API wrapper (send message)
  /test
    voteParsing.test.ts
    twilioSignature.test.ts
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
- `groupMembers/{phoneHash}` — `{ name, phoneNumber, active }`

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

## Webhook verification

Twilio signs every webhook request with an `X-Twilio-Signature` header:
`base64(HMAC-SHA1(authToken, url + sorted-and-concatenated POST param
key+value pairs))`, per
[Twilio's documented request-validation algorithm](https://www.twilio.com/docs/usage/webhooks/webhooks-security).
`voteWebhook` verifies this (constant-time comparison) before touching
Firestore, using your account's Auth Token (`TWILIO_AUTH_TOKEN`).

This is sensitive to getting the URL exactly right — `VOTE_WEBHOOK_URL` (a
plain, non-secret config param) must match, character for character, the
webhook URL configured on the Twilio number. If verification starts failing
in production after everything was working, mismatch between these two is
the first thing to check (e.g. a trailing slash, or `http` vs `https`).

## Local development

Requires the Firebase CLI (`npm install -g firebase-tools`) and a GCP/Firebase
project (see **Manual setup**, below).

```bash
cd functions
npm install
npm test              # vote-parsing + Twilio-signature unit tests
npm run build          # type-check + compile to lib/
```

To run against the Functions + Firestore emulators:

```bash
firebase use --add     # first time only, picks the GCP project
firebase emulators:start --only functions,firestore
```

The emulator prints local URLs for `voteWebhook`, `sendAnnouncement`, and
`generateDigest` (the latter two are scheduled, not HTTP-triggered — invoke
them manually from the emulator UI's "Trigger now" button while testing).
You can drive `voteWebhook` directly with `curl` to simulate an inbound text
without Twilio — you'll need to compute a matching signature over the exact
URL and form-encoded params:

```bash
URL="http://127.0.0.1:5001/<project-id>/us-central1/voteWebhook"
SECRET=your-local-auth-token
# Twilio's algorithm: url + sorted "key"+"value" pairs, HMAC-SHA1, base64
SIG=$(printf '%sBody2FromSample+15555550123' "$URL" | openssl dgst -sha1 -hmac "$SECRET" -binary | base64)

curl -X POST "$URL" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -H "X-Twilio-Signature: $SIG" \
  --data-urlencode "From=+15555550123" \
  --data-urlencode "Body=2"
```

(You'll also need a matching `groupMembers` doc and an open `polls` doc
seeded in the Firestore emulator first — use the emulator UI or `firebase
firestore:` commands. `classifyVote` calls the real Anthropic API even
against the emulator, so `ANTHROPIC_API_KEY` needs to be a real key locally
too — export it as a plain env var for the emulator.)

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
4. Create a [Twilio](https://console.twilio.com) account. Buy a **toll-free
   number** (not a standard local number, which requires 10DLC business
   registration for automated texting; not a true short code, which costs
   $500-1000+/month and a multi-week carrier application). Complete Twilio's
   toll-free verification for your use case (a personal group's weekly lunch
   poll — this is a quick form, not the 10DLC campaign process).
5. From the Twilio console, note your **Account SID** and **Auth Token**.
6. Get an Anthropic API key from console.claude.com.
7. Store all secrets (never commit them):
   ```bash
   firebase functions:secrets:set TWILIO_ACCOUNT_SID
   firebase functions:secrets:set TWILIO_AUTH_TOKEN
   firebase functions:secrets:set ANTHROPIC_API_KEY
   firebase functions:secrets:set MY_PHONE_NUMBER          # your own number, any format
   ```
8. Set the two non-secret config params (used by `smsClient.ts` and the
   webhook signature check). `firebase-functions/params` reads these as
   plain environment values at deploy time from a `functions/.env.<project-id>`
   file (e.g. `functions/.env.lunch-vote-sms`), which is gitignored —
   create it with:
   ```text
   TWILIO_FROM_NUMBER=+18885551234
   VOTE_WEBHOOK_URL=https://us-central1-<project-id>.cloudfunctions.net/voteWebhook
   ```
   `VOTE_WEBHOOK_URL` needs the real deployed URL, so you'll only have the
   final value after the first deploy — deploy once, note the printed
   `voteWebhook` URL, add it to the `.env` file, redeploy.
9. Decide the group's phone-number allowlist and each poll option's
   descriptive tags. Seed `groupMembers` docs and each week's `polls` doc
   accordingly — this is Firestore config, not a hardcoded list, so it's
   editable without a redeploy. Set `eventDetails` on the poll doc if you
   want a time/place note folded into the final announcement.
10. In the Twilio console, set the phone number's **"A message comes
    in"** webhook to the deployed `voteWebhook` URL (HTTP POST).
11. Adjust `TIMEZONE`, `ANNOUNCEMENT_SCHEDULE`, and `DIGEST_SCHEDULE` in
    `config.ts` to match when you actually want the poll sent and the digest
    generated — the defaults (Monday 9am / Thursday 5pm, America/New_York)
    are placeholders.

## Deploying

```bash
cd functions && npm run build
firebase deploy --only functions
```

`sendAnnouncement` and `generateDigest` are `onSchedule` functions — Firebase
provisions their Cloud Scheduler jobs automatically on deploy, no separate
`gcloud scheduler` setup needed.

## Known limitations

- **Single active poll assumed.** All the polling functions query for the
  most recently opened poll in the relevant status; if more than one is
  left in that status simultaneously, only the newest is used (older ones
  silently ignored, not an error).
- **No automatic poll creation.** Each week's `polls` doc (options, tags,
  opensAt/closesAt, eventDetails) is seeded manually in Firestore before
  `sendAnnouncement` fires — this repo only sends and tallies, it doesn't
  author the poll.
- **classifyVote and generateDigest cost real API calls.** Both hit the
  Anthropic API live, including against the local emulator — see **Cost
  notes** for expected volume/cost, but there's no offline/mock mode built
  in.
- **`VOTE_WEBHOOK_URL` must exactly match the Twilio console's configured
  webhook URL**, or signature verification fails on every request — see
  "Webhook verification" above.

## Stretch goals (not implemented)

- A reminder nudge to yourself if the digest goes unanswered for ~24 hours.
- A minimal read-only dashboard as a second view onto the same data.

## Cost notes

At this volume (10-25 people, once a week), Firestore, Cloud Functions, and
Cloud Scheduler usage stays comfortably inside GCP's always-free tier (50k
reads/day, 20k writes/day, 2M function invocations/month, 3 free scheduler
jobs).

Twilio is the one part of this that isn't free: a toll-free number runs
around $2/month, plus roughly $0.0079 per SMS segment sent/received in the
US. At 10-25 people texting a few times a week, that's still a few dollars a
month, not a free-tier system — the tradeoff for texts that clearly read as
coming from an automated number rather than your own.

Haiku 4.5 (`claude-haiku-4-5-20251001`) is $1/$5 per million input/output
tokens. Each `classifyVote` call is a few hundred tokens; the weekly
`generateDigest` call reading a week's worth of votes is maybe 1-2k input
tokens. All-in, this piece is still pennies a month.
