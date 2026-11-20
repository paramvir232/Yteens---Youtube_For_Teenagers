# Yteens---Youtube_For_Teenagers

Express 5 + Mongoose backend for the Yteens app.

## Running it locally

```bash
npm install
cp .env.example .env     # then fill it in; .env is git-ignored and holds real secrets
npm run preflight        # says which values are missing, never prints one
npm run dev              # NODE_ENV=development + nodemon
```

`npm run preflight -- --ping` additionally contacts the transcript and moderation
services. Those are Hugging Face Spaces that sleep when idle; a cold start has been
measured at 60s+, and that is time an upload pays too.

### Which database it talks to

Chosen by `NODE_ENV`, in `config/db.js`, so that developing or testing can never reach
production data:

| `NODE_ENV` | URI used |
|---|---|
| `test` | `MONGODB_URI_TEST` — required, and asserted to be a local mongod |
| `development` | `MONGODB_URI_LOCAL`, falling back to `MONGODB_URI` |
| anything else | `MONGODB_URI` |

That fallback is the sharp edge: with `MONGODB_URI_LOCAL` unset, `NODE_ENV=development`
silently resolves to production. `npm run preflight` reports which of the two is set.

### Indexes

`autoIndex` is **off** by default, the opposite of Mongoose's default. With it on,
declaring an index on an existing schema means the next deploy issues `createIndex`
against a live collection as a side effect of booting. Build them deliberately instead:

```bash
npm run ensure-indexes                     # refuses anything but a local mongod
npm run ensure-indexes -- --allow-remote   # a deployed cluster, on purpose
```

Existing collections get `createIndex` (additive). Only collections this project created
are ever `syncIndexes`-ed, because that **drops** indexes the schema does not declare.

## Tests

```bash
npm test              # 216 tests: unit + integration against a local mongod
npm run test:unit
npm run test:integration
```

### End to end, against a running server

```bash
npm run dev                 # one terminal
npm run stub:moderation     # another, if you want the rejection cases
npm run e2e                 # a third
```

29 checks over real HTTP: auth and refresh-token rotation with reuse detection, identity
coming from the token rather than the body, feed paging with a video inserted mid-scroll,
community join/post/comment/vote/ban including ban-evasion by resubscribing, and the
legacy `GET /video` contract. Deliberately outside `npm test`, which mocks Cloudinary and
blocks the network — that is what makes it fast, and also what stops it noticing a route
mounted at the wrong path or a `.env` pointing at the wrong database.

It refuses to run against a non-local database, creates everything it needs through the
public API, and leaves its fixtures behind in `yteens_dev`. Drop that database whenever
it gets noisy.

Two checks need the moderation stub running (they use the `REJECT` marker); without it
they report that the content was accepted and tell you why.

Integration tests need a mongod on localhost. Each run creates a uniquely named database
and drops it afterwards, and `assertLocal` refuses to run against anything that is not
local — the suite calls `dropDatabase()`, so pointing it at Atlas would destroy real
data. The network is blocked in tests; the moderation and Cloudinary clients are mocked.

## Uploads

Two routes, both live:

- `POST /video/upload` — the original. Requires a token now, but does **no** moderation.
- `POST /api/v2/upload` — moderated: Cloudinary → duration probe → transcript → text and
  image moderation. Add `?mode=async` to get `202 {jobId, statusUrl}` immediately and
  poll `GET /api/v2/upload/jobs/:id`, which is what the app does. The blocking form can
  legitimately take 4–7 minutes, which most proxies and clients will cut off first.

Moderation **fails closed**: if a service is unreachable the upload is rejected and the
Cloudinary asset destroyed, rather than published unchecked. One unset URL therefore
rejects every upload — hence `npm run preflight`.

To exercise the real pipeline against the real services, without MongoDB:

```bash
node scripts/pipelineLiveCheck.js            # text-rejection path, no ASR quota
node scripts/pipelineLiveCheck.js --accept   # full path: 1 ASR call + up to 30 image calls
```

## Testing against a phone

The device is a different computer: `localhost` there means the phone. Two ways across.

### Over USB — preferred, because it removes Wi-Fi from the problem

```bash
adb reverse tcp:3000 tcp:3000
```

The phone's own `localhost:3000` is tunnelled down the cable to this machine. No LAN IP,
no firewall rule, no same-network requirement, and it survives your laptop's IP changing.
Expo already does this for Metro's port; this is the same mechanism for the API. The app
then wants `EXPO_PUBLIC_API_URL=http://localhost:3000`.

It is cleared when the cable is unplugged or adb restarts, and must be re-run.

### Over Wi-Fi

Leave `EXPO_PUBLIC_API_URL` unset: in development the app derives the backend host from
the address Metro is serving on, so it follows this machine automatically. Needed once:

```bash
netsh advfirewall firewall add rule name="Yteens backend 3000" dir=in action=allow protocol=TCP localport=3000
```

### When it will not connect

```bash
npm run netcheck
```

Prints this machine's addresses (marking which is actually Wi-Fi rather than a virtual
adapter), what is listening and whether it is bound loopback-only, whether the USB tunnel
is up, whether the firewall rule exists, and the exact URL to use. It reads no `.env`.

| Symptom | Likely cause | Fix |
|---|---|---|
| App stuck on splash, Metro never connects | phone on another network | `adb reverse`, or rejoin Wi-Fi |
| "Could not connect to YTEENS" | backend unreachable | `adb reverse tcp:3000 tcp:3000` |
| Worked yesterday, not today | laptop IP changed | leave `EXPO_PUBLIC_API_URL` unset and let Metro's host drive it |
| Feed loads, upload hangs then fails | a moderation service is unreachable — the pipeline fails closed | `npm run preflight -- --ping` |
| Community actions start returning 429 | `COMMUNITY_WRITE_LIMIT`, 30 per 10 min in production | set it, restart — it is read once at load |
| Everything 401s after signing in | `JWT_ACCESS_SECRET` unset; it throws at call time, not at boot | `npm run preflight` |
| App reaches production despite `.env` | Metro not restarted, or a blank value falling back | restart Metro; blank means production, not localhost |

## Testing moderation without waiting on a Space

```bash
npm run stub:moderation      # port 8787
```

Then point `TEXT_MODERATION_URL` and `IMAGE_MODERATION_URL` at `http://localhost:8787`.
The verdict comes from the content, so one running stub serves an accept and a reject in
the same run: text or image URL containing **REJECT** is refused, **SLOW** sleeps past the
caller's timeout (the 503 `MODERATION_UNAVAILABLE` path), **BOOM** returns 500, anything
else passes.

It is not a model and proves nothing about moderation quality — prove the real chain once
with `scripts/pipelineLiveCheck.js`, then use the stub for repetition. Against the real
Spaces a rejection means waiting out a cold start (measured at 60s+) and hoping the model
agrees with you.

## One setting worth checking

`LEGACY_ACTOR_FALLBACK=true` re-opens the pre-token path, where a request body's
`channelId` is trusted as proof of identity — anyone can act as anyone by naming their
channel. It exists as a one-variable rollback. It has been found left on in a working
`.env`, where every route still *looked* protected, so `npm run preflight` warns about
it loudly.
