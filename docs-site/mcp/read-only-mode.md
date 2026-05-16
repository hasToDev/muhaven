---
title: '@muhaven/mcp — read-only mode'
description: Restrict your MCP install to 7 read-only tools for shared or curated deployments.
---

# Read-only mode

When `MUHAVEN_READ_ONLY=true` is set in the broker env at startup, only the **seven `muhaven.read.*` tools** are registered. The position, policy, issuer, and governance groups are not even surfaced to the host LLM — the tool catalog the LLM sees doesn't mention them.

This is defense in depth for deployments where you want to allow LLM visibility but never LLM-driven mutation.

## When to use it

| Scenario | Why read-only |
|---|---|
| Shared workstation (e.g., investor portal in a brokerage office) | LLM can answer client questions; can't accidentally move funds. |
| Investor's own laptop with auto-LLM-batch jobs | "Every Friday, summarize my MuHaven portfolio in a weekly email." No risk of jailbroken summary auto-trading. |
| Demo / training environments | Show the agentic surface without giving the demo audience signing capability. |
| Compliance officer who needs read access to their own issuer audit | The local broker only registers read tools — no risk of accidental signing. |

## How to enable

Set the env var before starting the broker:

```bash
export MUHAVEN_READ_ONLY=true
muhaven-broker
```

Or inline:

```bash
MUHAVEN_READ_ONLY=true muhaven-broker
```

The broker prints the read-only flag on startup:

```
[12:01] broker: READ-ONLY MODE (only muhaven.read.* tools registered)
```

The MCP server queries the broker on startup to learn the read-only flag, then filters its tool registry accordingly. The host LLM's tool catalog will list the 7 read tools and nothing else.

## What the LLM sees

```
> What MuHaven tools do you have?

I have these MuHaven tools available:
- muhaven.read.portfolio
- muhaven.read.yields
- muhaven.read.distribution
- muhaven.read.tokens
- muhaven.read.audit
- muhaven.read.protection_coverage
- muhaven.read.kyc_attestation

These are all read-only. I can show you portfolio state, yield
history, distribution status, and protection coverage, but I
can't propose any trades or policy changes from here.
```

A jailbroken LLM can't ask for a tool that isn't registered. There's no "force the tool registration" backdoor — the registry is built at startup from the broker's flag and stays immutable for the lifetime of the MCP server process.

## What still works

All seven read tools function normally:

- `muhaven.read.portfolio` — aggregate token list + `ebool` flags.
- `muhaven.read.yields` — per-token yield history.
- `muhaven.read.distribution` — epoch status.
- `muhaven.read.tokens` — RWA tokens you hold.
- `muhaven.read.audit` — your tiered-autonomy audit log.
- `muhaven.read.protection_coverage` — DefaultProtection state for a token.
- `muhaven.read.kyc_attestation` — KYC attestation registry status.

The privacy invariants of each tool are unchanged — they were already read-only in the no-decrypt sense. Read-only mode just removes the *propose* surface.

## What it doesn't do

- **It doesn't disable the broker's `sign_hash` capability.** The capability exists at the broker; it's only never invoked because no propose tool is registered.
- **It doesn't block dashboard sign-in.** Your MuHaven wallet + passkey still work fine for HavenBot, Telegram, and the dashboard — read-only is an MCP-instance-level flag.
- **It doesn't prevent a separate non-read-only install.** You can run two brokers in parallel (one on `MUHAVEN_BROKER_SOCKET=/tmp/muhaven-broker-ro.sock` with read-only, one default) and wire them to different host config entries.

## Running parallel read-only + full installs

```bash
# Terminal A — full broker on default socket
muhaven-broker

# Terminal B — read-only broker on a different socket
export MUHAVEN_READ_ONLY=true
export MUHAVEN_BROKER_SOCKET=/tmp/muhaven-broker-ro.sock
muhaven-broker
```

Wire each to a different host config entry:

```json
{
  "mcpServers": {
    "muhaven": { "command": "muhaven-mcp" },
    "muhaven-ro": {
      "command": "muhaven-mcp",
      "env": { "MUHAVEN_BROKER_SOCKET": "/tmp/muhaven-broker-ro.sock" }
    }
  }
}
```

Now in your host you have two MuHaven tool catalogs — one full, one read-only. You can call them by namespace prefix in your chat.

## Where next

- [Tool catalog](/mcp/tools) — full schema for the 7 read tools.
- [Broker daemon](/mcp/broker) — how the broker stores state.
- [Playbook](/mcp/playbook) — read-mostly scenarios that work great in read-only mode.
