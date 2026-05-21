# scripts/oracle-mine

Headed-Chromium scraper for harvesting RWA reference data from `app.rwa.xyz`
to seed MuHaven demo tokens with realistic APY / NAV values.

**Internal / demo use only.** rwa.xyz is treated as a read-only reference
for selecting representative metric shapes for similarly-named MuHaven tokens.

## Where this runs

The 8h refresh cron lives on the **homelab** (GUI Ubuntu 24.04 with autologin),
not the operator's dev box. The wrapper at `../refresh-and-ingest.sh` invokes
`npm run refresh:all` here, then ingests the resulting `data/*.json` to the
prod backend. The Linux installer at `../linux/install-oracle-refresh.sh`
registers a systemd `--user` timer that fires at `00:00 / 08:00 / 16:00 UTC`
daily.

The full operator runbook lives at `docs/OPERATOR_CRONS.md`.

## Layout

```
scripts/oracle-mine/
  package.json                # playwright + tsx (and chromium via postinstall)
  assets.json                 # curated 11-asset manifest
  scripts/
    scrape-asset.ts           # interactive Playwright capture (login pause)
    extract-asset.ts          # pure parser of __NEXT_DATA__ + decoded XHRs
    fetch-timeseries.ts       # direct API fetch for measure_slug timeseries
    refresh-all.ts            # batch entrypoint (npm run refresh:all)
    lib/rwaxyz-decode.ts      # bulk-query wire-format decoder
  data/                       # gitignored: per-asset extracted JSON (~400KB each)
  _debug/                     # gitignored: HTML snapshots, screenshots, XHR dumps
  .chrome-profile/            # gitignored: persistent Chromium profile (cookies)
  node_modules/               # gitignored
```

## First-time setup (homelab)

```bash
cd ~/Project/Fhenix/MuHaven/scripts/oracle-mine
npm install                                                # installs playwright + chromium (~150MB)
# Interactive login (one-off; persistent profile keeps the cookie afterwards):
DISPLAY=:0 npx tsx scripts/scrape-asset.ts --slug=USYC      # opens headed Chromium, log in, press Enter
```

After step 2, the cookie jar in `.chrome-profile/` is authed. Subsequent
unattended runs ride it for ~weeks until rwa.xyz forces re-auth (sanity
probe fails → operator re-runs the interactive scrape once).

## Manual smoke

```bash
bash ~/Project/Fhenix/MuHaven/scripts/refresh-and-ingest.sh
# tail -f ~/Project/Fhenix/MuHaven/scripts/oracle-mine/_debug/cron-runs/*.log
# expected: outcome=ok rc=0 in refresh-history.log after ~3-5 minutes
```

## Wire format + decoder

bulk-query tRPC responses use:

```
base64(15_random_salt_bytes || gzip(REVERSE(JSON.stringify(payload))) || optional_trailing_garbage)
```

Skip first 15 bytes; use `inflateRawSync` with `Z_SYNC_FLUSH` (Node's
`gunzipSync` rejects trailing garbage). Decompressed bytes are char-reversed.
See `scripts/lib/rwaxyz-decode.ts`.

Use **assetTimeseriesV4** with `measure_slug` (string) — numeric `measure_id`
catalogs aren't public.

## Safety notes

- `.chrome-profile/` contains session cookies — gitignored, treat as a
  secret. The chmod-600 convention applies on Linux.
- `_debug/` may contain personal-account data from rwa.xyz responses —
  also gitignored.
- Only `data/*.json` would be intended as a commit candidate (and even
  then they're gitignored today; the cron regenerates them).
