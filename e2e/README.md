# MuHaven E2E — Playwright suite

Functional regression suite for the MuHaven UI. Runs against live
`https://muhaven.hasto.dev` + Arb Sepolia + homelab backend. Serial execution,
human-in-loop passkey prompts, no CI.

> Full spec + test inventory: `../development/DEV_WAVE_3/qa/PLAYWRIGHT_QA.md`.

---

## Install

```bash
cd e2e
pnpm install
pnpm install:browsers
```

---

## Running tests

```bash
pnpm test                                 # all suites (interactive — you confirm passkeys)
pnpm test:ui                              # Playwright UI mode — recommended for dev
pnpm test:public                          # Suite A — no passkey, fast sanity check
pnpm test:auth                            # Suite B — register / login / logout
pnpm test:investor                        # Suite C — portfolio / deposit / yields / claim
pnpm test:issuer                          # Suite D — tokens / distribute / role switch
pnpm test:regression                      # Suite E — guardrails for past bugs
pnpm test tests/investor/claim.spec.ts    # single file
pnpm test --grep "distribute"             # by pattern
pnpm report                               # open last run's HTML report
```

---

## Profiles

Two persistent Chromium profiles live at `profiles/` — one per role:

| Path | Role | Smart account |
|------|------|----------------|
| `profiles/investor/` | investor tests | investor address |
| `profiles/issuer/` | issuer tests | issuer address |

Both are gitignored. Each holds its own WebAuthn passkey, so the two roles
are separate smart accounts. You register once per role (first time you run
the auth suite), and the passkey survives across every subsequent run.

To force a fresh register:

```bash
rm -rf profiles/investor   # or profiles/issuer
```

---

## First-run checklist

Before the first full-suite run, both smart accounts need to be set up on
Arb Sepolia. The auth suite walks you through it:

1. `pnpm test tests/auth/register-investor.spec.ts` — registers the investor
   passkey, prints the smart account, then **pauses** if preflight fails
   (new account isn't whitelisted / funded yet).
2. In another terminal: `E2E_ADDRESS=0x<investor-addr> pnpm setup:e2e`
3. Return to the test terminal, press Enter — test resumes and finishes.
4. `pnpm test tests/auth/register-issuer.spec.ts` — same dance for the issuer.
5. `E2E_ADDRESS=0x<issuer-addr> pnpm setup:e2e`
6. Everything else (`pnpm test`) runs without more setup.

---

## Environment variables

All optional:

| Var | Default |
|-----|---------|
| `E2E_BASE_URL` | `https://muhaven.hasto.dev` |
| `E2E_BACKEND_URL` | `https://nagreg.hasto.dev` |
| `ARB_SEPOLIA_RPC_URL` | Arbitrum public RPC |
| `E2E_INVESTOR_PASSKEY_NAME` | `E2E Investor` |
| `E2E_ISSUER_PASSKEY_NAME` | `E2E Issuer` |
| `E2E_DEPOSIT_AMOUNT` | `100` |
| `E2E_WRAP_AMOUNT` | `10` |
| `E2E_DISTRIBUTE_AMOUNT` | `0.5` |

---

## Failure triage

When a test fails:

1. **Check backend health first** — `pnpm test:public` alone surfaces
   homelab drift faster than any other suite.
2. **Check preflight instructions** — if the test paused with a `setup-e2e`
   instruction, run it and press Enter.
3. **Inspect the trace** — Playwright drops `trace.zip` + screenshot in
   `test-results/<...>/` on failure. Open with `pnpm exec playwright show-trace`.
4. **Selector drift** — "element not found: [data-testid=...]" means either
   the testid was renamed (update `lib/selectors.ts`) or removed (confirm
   with user — the testid contract in `PLAYWRIGHT_QA.md §4` is binding).
5. **Profile pollution** — if a prior test left the profile in a weird state,
   `rm -rf profiles/<role>/` forces a clean re-register.

---

## Legacy `distribute.ts`

The imperative script that predated this suite lives in `distribute.ts` and
still works. It's superseded by `tests/issuer/distribute.spec.ts` and will
be removed once the new suite has run clean end-to-end at least once.

---

## Related docs

- `../development/DEV_WAVE_3/qa/PLAYWRIGHT_QA.md` — spec, inventory, testid contract
- `../development/DEV_WAVE_3/qa/MANUAL_QA.md` — deferred human QA plan
- `../development/DEV_WAVE_3/POST_HACKATHON.md` — explains the ⚠️ cases
