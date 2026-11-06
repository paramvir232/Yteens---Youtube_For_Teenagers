# Deploying the Yteens backend

An Express 5 API on Node, talking to MongoDB, Cloudinary, and three moderation
services. It is currently deployed on Render from `main`.

This guide covers what to set, in what order, and the handful of settings that fail
quietly rather than loudly if you get them wrong.

---

## 1. What this service needs

| Dependency | Why | Free tier? |
|---|---|---|
| MongoDB | all data | Atlas M0 |
| Cloudinary | video and image hosting | yes |
| transcript-and-frames | ASR transcript + frame sampling for uploads | self-hosted (Docker) |
| text moderation service | title, description, transcript, community posts | Hugging Face Space |
| image moderation service | thumbnails, video frames, post images | Hugging Face Space |

Only the **moderated upload route** (`POST /api/v2/upload`) needs the last three. Every
other route works without them — the feed, auth, communities and the legacy upload route
are unaffected.

---

## 2. Configuration

`.env.example` is the reference: it lists every variable the code reads, with the
reasoning for each. Copy it to `.env` and fill it in. **`.env` is git-ignored and must
stay that way** — it holds the JWT secret and the Cloudinary secret.

### Required — the server will not start or will fail every request without these

| Variable | Notes |
|---|---|
| `MONGODB_URI` | used whenever `NODE_ENV` is not `development` or `test` |
| `JWT_ACCESS_SECRET` | generate with `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` | all three must come from the **same** Cloudinary account — see the trap below |

### Required for moderated uploads only

`TRANSCRIPT_SERVICE_URL`, `TRANSCRIPT_SERVICE_API_KEY`, `TEXT_MODERATION_URL`,
`IMAGE_MODERATION_URL`.

Moderation **fails closed**: if any one of these is missing or unreachable, every upload
through `POST /api/v2/upload` is rejected and its Cloudinary asset destroyed. That is
deliberate — an unmoderated video is never published — but it means a sleeping free-tier
Space looks like a broken uploader.

### Should be set explicitly in production

| Variable | Set to | Why |
|---|---|---|
| `NODE_ENV` | `production` | see the trap below |
| `MONGO_AUTO_INDEX` | `false` | with it on, every deploy issues `createIndex` against live collections. Use `npm run ensure-indexes` instead |
| `LEGACY_ACTOR_FALLBACK` | `false` | `true` lets a request name any `channelId` as proof of identity. It exists only as a rollback |
| `COMMUNITY_WRITE_LIMIT` | leave unset (defaults to 30 per IP per 10 min) | |
| `PORT` | leave unset on Render — the platform provides it | |

### Optional tuning

The moderation thresholds (`IMAGE_VIOLENCE_THRESHOLD`, `FRAME_FLAG_RATIO`,
`FRAME_MIN_FLAGGED`, `IMAGE_NSFW_THRESHOLD`, `TEXT_TOXICITY_THRESHOLD`,
`TEXT_SEVERE_THRESHOLD`, `TRANSCRIPT_FLAG_RATIO`, `TRANSCRIPT_MIN_FLAGGED`) all have
defaults and are documented at length in `.env.example`, including the measurements
behind them. **Leave them unset unless you have re-measured the classifiers.** Read
"What the moderation actually guarantees" below before changing any of them.

---

## 3. Three ways this fails quietly

These are the ones that cost real time, so they are worth reading once.

**`NODE_ENV` unset means production.** It is not just a label — it selects the database
(`config/db.js`):

```
development                  -> MONGODB_URI_LOCAL, falling back to MONGODB_URI
test                         -> MONGODB_URI_TEST (must be a local mongod)
anything else, INCLUDING UNSET -> MONGODB_URI
```

So `node index.js` with no `NODE_ENV` reads and writes **production**. `npm run dev` sets
it for you; a bare `node index.js` does not.

**Cloudinary credentials from two different accounts.** The SDK accepts a mismatched
cloud name and key pair without complaint and only fails at upload time, with
`401 cloud_name mismatch`. Check with:

```bash
node -e "require('dotenv').config();require('./config/cloudinary');require('cloudinary').v2.api.ping().then(r=>console.log(r.status)).catch(e=>console.log('FAILED:',e.error&&e.error.message))"
```

**A missing moderation URL looks like a broken uploader.** `npm run preflight -- --ping`
reports which variables are set and whether each service answers.

---

## 4. Deploying

### Render (current setup)

| Setting | Value |
|---|---|
| Build command | `npm ci` |
| Start command | `npm start` |
| Health check path | `/wake-up` |

Set every variable from section 2 in the Render dashboard, not in a committed file.
`PORT` is provided by Render; `index.js` already reads it.

No `engines` field is declared in `package.json`, so the platform picks the Node version.
The code uses Node 18+ features (global `fetch` in the scripts); pin it if your platform
defaults lower:

```json
"engines": { "node": ">=20" }
```

### Before the first deploy, and after any schema change

```bash
npm run preflight          # every required variable set?
npm run preflight -- --ping  # and are the three services reachable?
npm run ensure-indexes -- --allow-remote   # build indexes against the deployed database
```

`ensure-indexes` refuses a non-local database unless you pass `--allow-remote`. That
guard is deliberate: it is the difference between building indexes and building them on
production by accident.

### Verifying a deploy

```bash
curl https://<your-host>/wake-up        # -> Backend is awake!
curl https://<your-host>/api/v2/feed    # -> {"data":[...],"meta":{...}}
```

`/docs` serves the Swagger UI.

---

## 5. What is safe to change

The legacy routes are load-bearing for whatever is already deployed and are covered by
`test/integration/legacy-contract.test.js`:

- `GET /video/` still returns a **bare unbounded array** with no token required.
- `POST /video/upload` still accepts an **unmoderated** upload.

Both are asserted on every test run, so a change that breaks them fails CI rather than
production. Do not "tidy" them into the v2 shape without a client migration.

---

## 6. What the moderation actually guarantees

Be clear-eyed about this before relying on it.

The **text** classifier works: it scores obviously abusive text around 0.99 toxicity and
ordinary text at 0. The text and transcript stages are real protection.

The **image** classifier does not separate violent from safe content. On a 673-image
hand-labelled set (`moderation-eval/results/metrics.json`, violence axis, 20 positives):

- the worst genuinely violent image scores **0.752**
- the worst safe image scores **0.956**
- **17 safe images score above the worst violent one**
- **10 of the 20 violent images score exactly 0.000** — invisible at any threshold

At every threshold it rejects more safe images than it catches violent ones. The default
of 0.7 therefore chooses "do not reject safe content", which leaves the visual check close
to off. It is a coarse backstop, not a guarantee.

For a platform serving 10–20 year olds, real protection has to come from the text and
transcript stages, from replacing the image model, and from user reporting. The thresholds
are tunable, but no setting makes this stage reliable — see `services/imageModeration.js`
for the full numbers.

---

## 7. Running the whole stack locally

See the "local development" block in `.env.example`. In short:

```bash
npm install
npm run preflight            # check configuration first
npm run dev                  # sets NODE_ENV=development for you
```

`npm run netcheck` diagnoses a phone that cannot reach the machine (LAN addresses,
listening ports, `adb reverse` state, firewall rule).

`npm test` runs 358 tests across 22 suites. The integration suite requires
`MONGODB_URI_TEST` pointing at a **local** mongod — it calls `dropDatabase()` and refuses
any `mongodb+srv://` URI outright.
