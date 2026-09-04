# Lunch Vote SMS

Runs a weekly lunch poll for a small group (10-25 people) entirely over SMS,
sent from your own phone's SIM via the [SMS Gateway for
Android](https://sms-gate.app) app's cloud relay. Sending the weekly poll,
classifying replies, and drafting a digest are automatic; only the final
"text the group where we're going" step waits on a human (you) approving or
overriding the digest.

## What it does

1. **Monday** — `sendAnnouncement` (Cloud Scheduler) texts every group
   member the week's poll options individually, from your phone's number.
2. **All week** — group members text back a vote, a number, or loose
   sentiment ("something spicy"). `voteWebhook` receives each inbound text
   via the SMS Gateway cloud relay and hands it to `classifyVote`, which
   uses Haiku to match it against the poll's options (grounded in each
   option's tags). A confident match is recorded; anything else is left
   alone — no automated reply, no logged "failure." It's just an ordinary
   text in your Messages app for you to notice and answer personally if you
   want to.
3. **Thursday** — `generateDigest` (Cloud Scheduler) reads the week's votes,
   has Haiku synthesize a tally + sentiment themes + a recommended pick, and
   texts that digest to **your own number**. The poll moves to
   `awaiting_approval`.
4. **You reply** — texting back (from the same phone) routes to
   `approvalHandler` instead of vote classification. Reply `approve` to
   confirm the digest's recommendation, or `override <option>` to pick
   something else. Either way, `sendFinalAnnouncement` texts the group the
   confirmed where (and when, if set) and the poll moves to `sent`.

Sending from your own phone (rather than a dedicated number like a Twilio
toll-free line) is the deliberate tradeoff here: it's free beyond the phone
itself, but every text the group gets is genuinely from your personal
number — the weekly poll, the nag, and the final "we're going here" will
read exactly like you texting them yourself, because that's what's
happening under the hood. The phone running SMS Gateway also needs to stay
powered on and connected (Wi-Fi or data) at all times for delivery and
inbound replies to work — a spare/old Android phone dedicated to this is
more reliable than using your daily driver.

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
    index.ts                 function exports + admin.initializeApp()
    config.ts                secrets, collection names, phone hashing, schedules
    voteParsing.ts             pure text-parsing logic (vote text match, approval replies)
    webhookSignature.ts        HMAC-SHA256 verification for inbound SMS Gateway webhooks
    voteWebhook.ts             HTTPS function: branches inbound SMS to classifyVote/approvalHandler
    classifyVote.ts             Haiku tool-use call: free text -> {matched_option, confidence}
    generateDigest.ts           scheduled: tally + Haiku summary -> digest doc + SMS to owner
    approvalHandler.ts          parses owner's approve/override reply
    sendAnnouncement.ts         scheduled: texts the week's poll to the group
    sendFinalAnnouncement.ts    texts the confirmed pick to the group
    gatewayClient.ts             SMS Gateway (sms-gate.app) Messages API wrapper (send message)
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

To run against the Functions + Firestore emulators:

```bash
firebase use --add     # first time only, picks the GCP project
firebase emulators:start --only functions,firestore
```

The emulator prints local URLs for `voteWebhook`, `sendAnnouncement`, and
`generateDigest` (the latter two are scheduled, not HTTP-triggered — invoke
them manually from the emulator UI's "Trigger now" button while testing).
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
4. Get a dedicated Android phone (a spare/old one works fine — it just needs
   to stay powered on and connected). Install [SMS Gateway for
   Android](https://sms-gate.app) on it, and register/sign in to a **Cloud
   mode** account so the app relays through SMS Gateway's cloud service
   (rather than needing your phone to expose a public endpoint directly).
   Note the device's Cloud-mode **login and password** from the app.
5. In the app's webhook settings, set a **webhook signing secret** (any
   strong random string you generate) and add a webhook for the
   `sms:received` event pointing at your `voteWebhook` function's URL —
   you'll only have the real deployed URL after the first deploy, so add
   this after step 10 below (deploy once with a placeholder, get the URL,
   configure the app, done — no redeploy needed since the URL isn't stored
   in this repo's config).
6. Get an Anthropic API key from console.claude.com.
7. Store all secrets (never commit them):
   ```bash
   firebase functions:secrets:set SMS_GATEWAY_LOGIN
   firebase functions:secrets:set SMS_GATEWAY_PASSWORD
   firebase functions:secrets:set WEBHOOK_SIGNING_SECRET    # same value set in the app
   firebase functions:secrets:set ANTHROPIC_API_KEY
   firebase functions:secrets:set MY_PHONE_NUMBER           # your own number, any format
   ```
8. Decide the group's phone-number allowlist and each poll option's
   descriptive tags. Seed `groupMembers` docs and each week's `polls` doc
   accordingly — this is Firestore config, not a hardcoded list, so it's
   editable without a redeploy. Set `eventDetails` on the poll doc if you
   want a time/place note folded into the final announcement.
9. Deploy (see **Deploying** below), note the printed `voteWebhook` URL, and
   finish step 5 above — configure that URL as the `sms:received` webhook in
   the SMS Gateway app.
10. Adjust `TIMEZONE`, `ANNOUNCEMENT_SCHEDULE`, and `DIGEST_SCHEDULE` in
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
- **Depends on one Android phone staying online.** Delivery and inbound
  replies both route through the SMS Gateway app on a single device — if
  it's off, out of battery, or disconnected, texts queue up (or are missed
  entirely) until it's back.
- **Texts read as coming from you personally**, not an automated system —
  see the tradeoff called out at the top of this README.

## Stretch goals (not implemented)

- A reminder nudge to yourself if the digest goes unanswered for ~24 hours.
- A minimal read-only dashboard as a second view onto the same data.

## Cost notes

At this volume (10-25 people, once a week), Firestore, Cloud Functions, and
Cloud Scheduler usage stays comfortably inside GCP's always-free tier (50k
reads/day, 20k writes/day, 2M function invocations/month, 3 free scheduler
jobs).

Sending SMS itself is free here — it rides on your phone's existing plan
and SMS Gateway's free Cloud-mode tier, rather than paying Twilio's
per-segment rates. The cost instead is a dedicated Android phone (a spare
one, or your daily driver if you're comfortable with that) that has to stay
powered on and connected.

Haiku 4.5 (`claude-haiku-4-5-20251001`) is $1/$5 per million input/output
tokens. Each `classifyVote` call is a few hundred tokens; the weekly
`generateDigest` call reading a week's worth of votes is maybe 1-2k input
tokens. All-in, this piece is still pennies a month.
