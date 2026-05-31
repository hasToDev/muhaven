---
title: '@muhaven/mcp — playbook'
description: Practical scenarios for getting MuHaven results out of your own LLM.
---

# MCP playbook

A library of **scenarios that work** — copy a prompt, point it at your LLM with the `muhaven` MCP server installed, and get the result you want. Every scenario shows:

1. The exact prompt you type.
2. Which MCP tool(s) the LLM picks.
3. What you see back.

> Throughout this page, `<TOKEN>` and `RWA1` stand in for whichever active RWA token you hold. Your dashboard's Tokens page lists the actual symbols.

If your prompt doesn't match a scenario here, follow the same shape: be concrete about the asset, the time window, and the outcome you want.

## 1. Cross-MCP "morning brief"

Sit MuHaven next to your other MCP servers — Notion, GitHub, Gmail, calendar — and pull a single chat turn that crosses all of them.

```
> Give me a 5-bullet morning brief: my MuHaven portfolio summary
  plus signal flags, the top item from my Notion "Investments"
  database, today's calendar from Google, and any new starred
  GitHub PR for orgs I follow.

[muhaven] muhaven.read.portfolio()
[notion]  notion.search({"query":"Investments","filter":{"type":"database"}})
[gcal]    calendar.list_events({"date":"today"})
[github]  github.list_starred_prs()

Morning brief — 2026-05-16:

• MuHaven: 3 RWA positions, balanced. No isOverexposed flag.
  Last sync 09:14 UTC.
• Investments DB: "Rotate 10% out of growth into treasuries"
  (last edited yesterday).
• Calendar: 11:00 RWA underwriting call · 14:30 quarterly review.
• GitHub: 2 starred PRs merged overnight in fhenix-cofhe org.
• Action: pre-call, run "Quote 1000 mhUSDC of <TOKEN>" to have
  fresh NAV ready.
```

**Why this works:** every MCP server returns structured data; the LLM is good at composing structured data into a brief. MuHaven's portfolio summary is small, aggregate-only, and never includes encrypted handles — perfect for an LLM context summary.

## 2. Scheduled weekly yield check

Most MCP hosts (including Claude Code with `cron`, or any LLM with a scheduling agent) can run prompts on a recurring schedule. Wire this one to fire Friday afternoons:

```
> Every Friday at 17:00 local time:
  1. Call muhaven.read.yields for all my tokens.
  2. If any token has unclaimed yield >$10 in the past 7 days,
     propose a claim (don't submit it — return the envelope).
  3. Email me a 3-line summary at me@example.com.

[muhaven] muhaven.read.tokens()
[muhaven] muhaven.read.yields({"token":"<TOKEN>","since":"2026-05-09"})
[muhaven] muhaven.read.yields({"token":"RWA1","since":"2026-05-09"})
[muhaven] muhaven.position.claim({"items":[{"token":"<TOKEN>","epoch":6}]})
          → returns envelope + broker signature
[gmail]   gmail.send({"to":"me@example.com","subject":"MuHaven weekly",...})

Friday recap sent. Two unclaimed epochs ≥$10:
  • <TOKEN> epoch 6 — $14.20 (envelope queued)
  • RWA1 epoch 4 — $11.80 (envelope queued)
Open https://muhaven.app/agent to confirm both with one passkey tap.
```

**Important:** MCP propose tools **never auto-submit**. The scheduled run prepares the envelope; you commit it from the dashboard at your convenience. That's the no-auto-submit invariant — even a scheduled job can't sign on your behalf.

## 3. "Compare my RWA against a stock I track"

If you also have a market-data MCP server (Yahoo Finance, Polygon, Alpaca), you can ask cross-asset questions in one turn:

```
> Compare the last-30-day total return of my <TOKEN> position
  vs the SPY ETF. Use my actual <TOKEN> share count and the most
  recent NAV.

[muhaven]  muhaven.read.portfolio()
[muhaven]  muhaven.read.yields({"token":"<TOKEN>","since":"2026-04-16"})
[polygon]  polygon.aggregate({"ticker":"SPY","from":"2026-04-16","to":"2026-05-16"})

Over the last 30 days:
  <TOKEN>:    +0.42% (yield + NAV drift, your ~99 shares)
  SPY:        +1.84% (price only)

<TOKEN> is a low-vol cash-equivalent; the comparison is most
useful as "risk-off cushion vs equity beta", not as a pure
return race. Want me to chart the daily series?
```

**Why this works:** MCP returns the **share count** (aggregate, not the encrypted balance) and the per-epoch yield rate. The LLM composes that with the external market-data MCP into a like-for-like comparison.

## 4. "Diagnose an audit anomaly"

You see something odd in the audit log and want an LLM to help triage:

```
> Look at my MuHaven audit log for the last 48h. Highlight any
  rows that came from a different surface than usual, any
  permit_attempted failures, and any rebalance proposals I
  didn't follow through on.

[muhaven] muhaven.read.audit({"since":"2026-05-14T10:00:00Z","limit":50})

24-hour audit summary (12 rows):

  • 10 from dashboard_session_key (your usual)
  •  2 from telegram_inline (Tuesday 11:42, 11:43 — both buys,
     both settled)
  •  0 permit_attempted failures
  •  1 propose_rebalance that never settled (Tuesday 14:21);
     no follow-up commit row

The Telegram rows match your usual pattern (you confirmed two
sub-$200 buys on the move). The unrebalanced propose is the
one to look at — open /agent → Rebalance to see if you still
want to act on it.
```

**Why this works:** `muhaven.read.audit` returns cursor-paginated rows with a `source` field server-derived from the auth path. The LLM can spot anomalies because the source values are constrained — there are only ~6 valid sources.

## 5. "Pre-flight a big buy"

Before you commit to a >$5K buy, run a pre-flight that pulls oracle freshness, recent yield history, and the protection coverage state:

```
> Pre-flight a $20,000 buy of <TOKEN>. I want:
  1. Current NAV with timestamp.
  2. Yield rate of the last 3 epochs.
  3. Protection coverage state.
  4. Whether my Confirm-per-action session key has room for
     this within its remaining value cap.

[muhaven] muhaven.read.tokens()
[muhaven] muhaven.read.yields({"token":"<TOKEN>","limit":3})
[muhaven] muhaven.read.protection_coverage({"token":"<TOKEN>"})
[muhaven] muhaven.policy.session_key_status()

Pre-flight for $20K of <TOKEN>:

  NAV:                $1.003 (fresh)
  Last 3 epoch APR:   3.8% · 4.1% · 3.9%
  Protection:         active (50bps reserve covers $250K notional)
  Session key cap:    $5K per call · $50K per epoch

⚠️ Your session key value cap is $5K/call. A $20K buy would need
4 chunked UserOps OR the dashboard passkey confirm path. Recommend
opening /agent on dashboard and using the passkey confirm path
for the full $20K in one tx.
```

**Why this works:** every fact comes from a structured MCP tool. The LLM doesn't need to "remember" your session-key scope — it asks for it.

## 6. "Read-only sanity check from a shared machine"

If you're at a shared workstation or running a demo, start the broker in read-only mode (see [Read-only mode](/mcp/read-only-mode)) and run inspection prompts only:

```
> What MuHaven tools do you have right now?

[muhaven] (reads tool catalog)

I have 8 read tools:
  muhaven.read.portfolio
  muhaven.read.yields
  muhaven.read.distribution
  muhaven.read.tokens
  muhaven.read.audit
  muhaven.read.activity
  muhaven.read.protection_coverage
  muhaven.read.kyc_attestation

No position, policy, issuer, or governance tools are registered
on this install — the broker started with MUHAVEN_READ_ONLY=true.
I can answer questions but cannot propose any state changes.
```

A jailbroken LLM can't ask for a propose tool that isn't in its catalog. Read-only is the cheapest defense-in-depth control for any shared or curated install.

## 7. Issuer scenarios

If you're signed in with an **issuer's MuHaven wallet**, the issuer-side MCP tools become callable. Two scenarios:

### Monthly distribution rehearsal

```
> Show me my last 3 yield distributions to <TOKEN> holders.
  Then draft (but don't submit) a $50,000 distribution for
  May 2026 with the same per-share rate as last month.

[muhaven] muhaven.issuer.audit_query({"tool":"distribute_yield",
                                       "token":"<TOKEN>","limit":3})
[muhaven] muhaven.issuer.distribute_yield({"token":"<TOKEN>",
                                            "totalUsd6":50000000000,
                                            "label":"May 2026"})

Last 3 distributions to <TOKEN>:
  Apr — $48K / 1,200,000 shares = $0.0400/share
  Mar — $46K / 1,180,000 shares = $0.0390/share
  Feb — $45K / 1,150,000 shares = $0.0391/share

May draft prepared: $50,000 / ~1,250,000 shares = $0.0400/share
Envelope queued. Open /agent on dashboard to confirm with your
issuer passkey.
```

### Whitelist diff

```
> Compare my <TOKEN> whitelist to a list of addresses in a Notion
  page titled "Q2 Investors". Tell me which addresses are on the
  Notion list but NOT yet on the whitelist.

[notion]   notion.search({"query":"Q2 Investors"})
[muhaven]  muhaven.issuer.audit_query({"tool":"kyc_add","token":"<TOKEN>"})

Notion list has 24 addresses. <TOKEN> whitelist log shows 21
permit_granted kyc_add rows in the past 90 days.

3 addresses are in Notion but not in your add-log:
  • 0xabc...001
  • 0xdef...002
  • 0x123...003

Want me to propose 3 kyc_add operations? You'll sign each one
with your issuer passkey from the dashboard.
```

## Tips for writing prompts that just work

1. **Be concrete about the asset.** Use the actual token symbol, not "my position." LLMs sometimes parameterize too aggressively.
2. **Be concrete about the time window.** "Last 30 days", "this quarter", "since Tuesday" — better than "recent".
3. **Be concrete about the outcome.** "Email me a summary", "draft (don't submit)", "compare A vs B" — better than "look at it".
4. **Don't ask the LLM to decrypt.** MCP tools never return cleartext balances. If you need a number, switch to the dashboard and use `decryptForView` there.
5. **Use scheduled hosts for recurring brief.** Claude Code with cron, or your LLM's own scheduling agent, can fire the same prompt every Friday. The no-auto-submit invariant means scheduled runs prepare envelopes only — you commit on the dashboard.

## Where next

- [First chat](/mcp/first-chat) — the basics if you haven't done the walkthrough yet.
- [Tool catalog](/mcp/tools) — the strict schemas behind every tool the LLM picks.
- [Read-only mode](/mcp/read-only-mode) — lock the install to the 8 read tools.
- [Broker daemon](/mcp/broker) — how the broker keeps your keys out of the LLM context.
