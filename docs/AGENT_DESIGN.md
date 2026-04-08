# MuHaven — AI Agent Design

> Architecture, tool definitions, and step-by-step implementation guide for the MuHaven AI agent. Written for builders new to agentic AI.

> **SDK note**: All tool handlers use `@cofhe/sdk` (v0.4.0) with `Encryptable.uint64()` / `Encryptable.uint128()` for encryption and the async decrypt pattern (`requestBalanceDecrypt` → `getBalanceDecryptResult`) for reading balances. Import from `@cofhe/sdk/node` in Node.js agent contexts. See [SMART_CONTRACTS.md](./SMART_CONTRACTS.md) for SDK compatibility details.

---

## What is an AI agent (no jargon)

A regular LLM answers questions. An AI agent **does things**.

The difference: when you ask ChatGPT "what's the best RWA yield?", it answers. When you tell the MuHaven agent "invest $10K in the best yield", it checks current rates, recommends an allocation, gets your approval, and executes the trades.

An agent has three components:

1. **Brain** — An LLM (Claude, GPT-4, etc.) that understands natural language and reasons about what to do
2. **Tools** — Functions the LLM can call (deposit money, buy tokens, check balances)
3. **Loop** — The agent perceives (reads data), reasons (decides what to do), acts (calls a tool), and repeats

```
User says something
       │
       ▼
┌─────────────┐
│  LLM thinks │ ← "User wants low-risk investment"
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  Call tool  │ ← get_yields() → returns current rates
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  LLM thinks │ ← "Treasury at 4.8% fits their risk profile"
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  Respond    │ ← "I recommend 70% treasuries. Shall I proceed?"
└──────┬──────┘
       │
       ▼
User confirms → Agent calls deposit() → buy_rwa() → done
```

---

## MuHaven's two agents

### Agent 1: Portfolio agent (investor-facing)

The investor interacts with this agent through a chat interface. It wears three hats:

| Hat | What it does | Example |
|-----|-------------|---------|
| **Advisor** | Asks questions, assesses risk, recommends allocation | "Based on your 1-year horizon and low risk tolerance, I recommend 70% treasuries, 20% money market, 10% cash buffer" |
| **Risk manager** | Sets encrypted guardrails on-chain | Max drawdown: 5%, min yield alert: 4%, drift tolerance: 5% |
| **Executor** | Deposits, buys tokens, claims yields — within guardrails | Wraps USDC → PUSDC → MuHaven mint → ReineiraOS claim |

### Agent 2: Platform agent (backend operations)

Runs as a background service. No chat interface — it's automated:

| Task | Trigger | Action |
|------|---------|--------|
| Yield distribution | RWA issuer deposits yield via `depositYield()` | Creates ReineiraOS escrows for each eligible investor via YieldDistributor |
| Compliance monitoring | Periodic check | Verifies KYC claims haven't expired |
| Yield alert | Yield drops below investor threshold | Sends notification to investor |

**Issuer-facing tools (future production):**

The platform agent gains issuer-facing tools for production use, enabling issuers to interact with MuHaven programmatically:

| Tool | What it does |
|------|-------------|
| `create_token` | Deploy a new fhERC-20 RWA token with configuration (name, yield type, KYC tier, jurisdiction) |
| `mint_tokens` | Mint tokens to eligible investor addresses via `mint()` (MINTER_ROLE) |
| `deposit_yield` | Deposit yield and trigger proportional distribution via YieldDistributor |
| `get_issuer_stats` | View aggregate metrics (total supply, investor count, total yield distributed) |
| `update_whitelist` | Add/remove investors from eligibility |

For the hackathon, Agent 1 (portfolio agent) is the priority. Agent 2 can be simplified to a script. The issuer dashboard (Vue 3) provides the issuer-facing UI for hackathon scope — the platform agent tools are a production enhancement.

---

## Tool definitions

Tools are functions the LLM can call. Each tool has a name, description (so the LLM knows when to use it), parameters, and a handler function.

### Tool schema format

```typescript
// Each tool follows this pattern:
interface Tool {
  name: string;
  description: string;        // LLM reads this to decide when to call the tool
  parameters: JSONSchema;      // What the tool needs as input
  handler: (params) => result; // What actually executes
}
```

### Tool 1: `get_yields`

```typescript
{
  name: "get_yields",
  description: "Get current yield rates for all available RWA tokens. Call this when the user asks about investment options, yields, or rates.",
  parameters: {
    type: "object",
    properties: {},  // No parameters needed
  },
  handler: async () => {
    // Fetch current yields from oracle or API
    return {
      tokens: [
        { name: "Treasury Bond Fund", symbol: "MHRWA-TB", yield_apy: 4.8, risk: "low" },
        { name: "Money Market Fund", symbol: "MHRWA-MM", yield_apy: 5.2, risk: "low" },
        { name: "Private Credit", symbol: "MHRWA-PC", yield_apy: 8.1, risk: "medium" },
        { name: "Real Estate Fund", symbol: "MHRWA-RE", yield_apy: 6.5, risk: "medium" },
      ]
    };
  }
}
```

### Tool 2: `deposit`

```typescript
{
  name: "deposit",
  description: "Deposit USDC into MuHaven via ReineiraOS PUSDC (encrypted). Call this when the user confirms they want to invest a specific amount.",
  parameters: {
    type: "object",
    properties: {
      amount: { type: "number", description: "USDC amount to deposit" }
    },
    required: ["amount"]
  },
  handler: async ({ amount }) => {
    // Wrap USDC → PUSDC via ReineiraOS confidential stablecoin wrapper
    const sdk = ReineiraSDK.create({ network: 'testnet', privateKey: process.env.AGENT_WALLET_KEY });
    const result = await sdk.stablecoin(amount).wrap();
    return { success: true, txHash: result.hash, message: `Deposited $${amount} USDC → PUSDC (encrypted)` };
  }
}
```

### Tool 3: `buy_rwa`

```typescript
{
  name: "buy_rwa",
  description: "Purchase fhERC-20 RWA tokens with deposited USDC. Call this after a successful deposit, when the user has approved an allocation.",
  parameters: {
    type: "object",
    properties: {
      token_symbol: { type: "string", description: "RWA token symbol (e.g., MHRWA-TB)" },
      amount: { type: "number", description: "USDC amount to allocate" }
    },
    required: ["token_symbol", "amount"]
  },
  handler: async ({ token_symbol, amount }) => {
    // Encrypt amount using @cofhe/sdk
    const [encrypted] = await client.encryptInputs([
      Encryptable.uint128(BigInt(amount * 1e6))  // USDC has 6 decimals
    ]).execute();
    const tx = await muhavenToken.mint(walletAddress, encrypted);
    return { success: true, txHash: tx.hash, message: `Bought $${amount} of ${token_symbol} (encrypted)` };
  }
}
```

### Tool 4: `view_portfolio`

```typescript
{
  name: "view_portfolio",
  description: "Show the investor's current portfolio with decrypted balances. Only the investor can see this data. Call this when the user asks about their holdings, balance, or portfolio.",
  parameters: {
    type: "object",
    properties: {},
  },
  handler: async () => {
    // Request async decryption of balance (investor signs their own balance task)
    await muhavenToken.requestBalanceDecrypt();
    let balance = 0n;
    for (let i = 0; i < 30; i++) {
      const [val, ready] = await muhavenToken.getBalanceDecryptResult(walletAddress);
      if (ready) { balance = val; break; }
      await new Promise(r => setTimeout(r, 2000));
    }

    // Request async decryption of risk params
    await riskParamsContract.requestRiskParamsDecrypt(walletAddress);
    let maxDrawdown = 0n, minYield = 0n;
    for (let i = 0; i < 30; i++) {
      const [md, my, , , mdReady] = await riskParamsContract.getRiskParamsDecryptResult(walletAddress);
      if (mdReady) { maxDrawdown = md; minYield = my; break; }
      await new Promise(r => setTimeout(r, 2000));
    }

    return {
      total_value_usd: Number(balance) / 1e6, // Convert from 6 decimals
      positions: [
        { token: "MHRWA-TB", value: (Number(balance) / 1e6) * 0.7, yield_apy: 4.8 },
        { token: "MHRWA-MM", value: (Number(balance) / 1e6) * 0.2, yield_apy: 5.2 },
        { token: "Cash buffer", value: (Number(balance) / 1e6) * 0.1, yield_apy: 5.0 },
      ],
      risk_params: {
        max_drawdown: `${Number(maxDrawdown) / 100}%`,
        min_yield_alert: `${Number(minYield) / 100}%`,
      },
      note: "All balances are encrypted on-chain. Only you can see this data."
    };
  }
}
```

### Tool 5: `claim_yield`

```typescript
{
  name: "claim_yield",
  description: "Claim pending yield from ReineiraOS escrows. Call this when the user asks to claim yields or when auto-claim is enabled.",
  parameters: {
    type: "object",
    properties: {
      escrow_id: { type: "string", description: "ReineiraOS escrow ID to claim from" }
    },
    required: ["escrow_id"]
  },
  handler: async ({ escrow_id }) => {
    // Redeem from ReineiraOS escrow
    const sdk = ReineiraSDK.create({ network: 'testnet', privateKey: process.env.AGENT_WALLET_KEY });
    const result = await sdk.escrow.redeem(escrow_id);
    return { success: true, message: "Yield claimed and added to your portfolio (encrypted)" };
  }
}
```

### Tool 6: `set_risk_params`

```typescript
{
  name: "set_risk_params",
  description: "Set the investor's risk parameters (encrypted on-chain). Call this after the risk assessment conversation.",
  parameters: {
    type: "object",
    properties: {
      max_drawdown_percent: { type: "number", description: "Max acceptable loss percentage" },
      min_yield_percent: { type: "number", description: "Minimum yield before alerting" },
      drift_tolerance_percent: { type: "number", description: "Max allocation drift before rebalance" },
      max_daily_spend: { type: "number", description: "Max USDC the agent can spend per day" }
    },
    required: ["max_drawdown_percent", "min_yield_percent", "max_daily_spend"]
  },
  handler: async (params) => {
    // Encrypt risk params using @cofhe/sdk before sending to contract
    const [encMaxDrawdown, encMinYield, encDrift, encMaxSpend] = await client.encryptInputs([
      Encryptable.uint64(BigInt(params.max_drawdown_percent * 100)),   // basis points
      Encryptable.uint64(BigInt(params.min_yield_percent * 100)),      // basis points
      Encryptable.uint64(BigInt((params.drift_tolerance_percent || 5) * 100)),
      Encryptable.uint64(BigInt(params.max_daily_spend * 1e6)),        // USDC 6 decimals
    ]).execute();
    const tx = await riskParamsContract.setRiskParams(
      encMaxDrawdown,
      encMinYield,
      encDrift,
      encMaxSpend
    );
    return { success: true, message: "Risk parameters saved (encrypted on-chain)" };
  }
}
```

---

## System prompt

The agent's behavior is defined by a system prompt that tells the LLM its role, capabilities, and constraints:

```
You are MuHaven, a confidential AI portfolio manager for tokenized Real-World Assets.

YOUR ROLE:
- You help investors build and manage RWA portfolios
- You recommend allocations based on risk tolerance and investment goals
- You execute trades and claim yields on the investor's behalf
- You ALWAYS ask for confirmation before executing any transaction

YOUR CAPABILITIES:
- You can check current RWA yield rates (get_yields)
- You can deposit USDC via encrypted payment rails (deposit)
- You can buy fhERC-20 RWA tokens (buy_rwa)
- You can show the investor's encrypted portfolio (view_portfolio)
- You can claim yield from escrows (claim_yield)
- You can set encrypted risk parameters (set_risk_params)

YOUR CONSTRAINTS:
- NEVER execute a transaction without explicit investor confirmation
- NEVER reveal portfolio details to anyone except the connected wallet owner
- NEVER exceed the investor's max daily spend limit
- NEVER interact with contracts outside the whitelisted set
- You are NOT a financial advisor — you provide tools and information
- Always remind investors that they maintain full custody of their funds

PRIVACY PRINCIPLE:
All balances, amounts, and risk parameters are FHE-encrypted on-chain.
You operate on encrypted state — you call tools that handle ciphertext.
Only the investor can decrypt their own data.
Nobody else — not competitors, not MEV bots, not even you — can see the portfolio.

RISK ASSESSMENT FLOW:
When a new investor asks to invest, follow this sequence:
1. Ask about investment horizon (3 months, 1 year, 3+ years)
2. Ask about risk tolerance (conservative, moderate, aggressive)
3. Ask about income goals (steady income vs growth)
4. Recommend an allocation based on available yields
5. Explain the recommendation clearly
6. Ask for confirmation before executing
```

---

## Implementation guide (step by step)

### Step 1: Choose your LLM provider

For the hackathon, use one of these:

| Provider | How to use | Cost |
|----------|-----------|------|
| **Anthropic (Claude)** | `@anthropic-ai/sdk` npm package | Free tier available, pay-per-token |
| **OpenAI (GPT-4)** | `openai` npm package | Pay-per-token |

Both support function calling (tools). The implementation is nearly identical.

### Step 2: Set up the agent backend

```typescript
// agent/index.ts
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Define tools (from the schemas above)
const tools = [
  { name: "get_yields", /* ... */ },
  { name: "deposit", /* ... */ },
  { name: "buy_rwa", /* ... */ },
  { name: "view_portfolio", /* ... */ },
  { name: "claim_yield", /* ... */ },
  { name: "set_risk_params", /* ... */ },
];

// Agent conversation loop
async function chat(messages: Message[]) {
  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,  // From above
    tools: tools,
    messages: messages,
  });

  // If the LLM wants to call a tool
  if (response.stop_reason === "tool_use") {
    const toolCall = response.content.find(c => c.type === "tool_use");
    const result = await executeToolHandler(toolCall.name, toolCall.input);

    // Send the result back to the LLM so it can formulate a response
    messages.push({ role: "assistant", content: response.content });
    messages.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolCall.id, content: JSON.stringify(result) }]
    });

    // Continue the conversation
    return chat(messages);
  }

  // Return the text response
  return response.content.find(c => c.type === "text")?.text;
}
```

### Step 3: Build the chat UI in Vue 3

```vue
<!-- frontend/src/components/AgentChat.vue -->
<template>
  <div class="chat-container">
    <div class="messages" ref="messagesContainer">
      <div
        v-for="msg in messages"
        :key="msg.id"
        :class="['message', msg.role === 'user' ? 'user-msg' : 'agent-msg']"
      >
        {{ msg.text }}
      </div>
    </div>
    <div class="input-area">
      <input
        v-model="input"
        @keyup.enter="sendMessage"
        placeholder="Ask MuHaven anything..."
      />
      <button @click="sendMessage">Send</button>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';

const messages = ref([
  { id: 1, role: 'agent', text: 'Welcome to MuHaven. I can help you build a private RWA portfolio. What are your investment goals?' }
]);
const input = ref('');

async function sendMessage() {
  if (!input.value.trim()) return;

  // Add user message
  messages.value.push({ id: Date.now(), role: 'user', text: input.value });

  // Call agent backend
  const response = await fetch('/api/agent/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: input.value, history: messages.value }),
  });

  const data = await response.json();
  messages.value.push({ id: Date.now(), role: 'agent', text: data.response });

  input.value = '';
}
</script>
```

### Step 4: Connect tools to real contracts

Each tool handler calls the actual SDKs:

```typescript
// agent/toolHandlers.ts
import { ethers } from 'ethers';
import { createCofheClient, createCofheConfig, Encryptable, FheTypes } from '@cofhe/sdk/node';
import { Ethers6Adapter } from '@cofhe/sdk/adapters';
import { arbSepolia } from '@cofhe/sdk/chains';
import { ReineiraSDK } from '@reineira-os/sdk';

// Initialize provider and contracts (ethers for contract interaction)
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(process.env.AGENT_WALLET_KEY, provider);
const muhavenToken = new ethers.Contract(TOKEN_ADDRESS, TOKEN_ABI, wallet);
const riskParams = new ethers.Contract(RISK_ADDRESS, RISK_ABI, wallet);

// Initialize @cofhe/sdk client (Ethers6Adapter bridges ethers → viem for CoFHE)
const { publicClient, walletClient } = await Ethers6Adapter(provider, wallet);
const config = createCofheConfig({ supportedChains: [arbSepolia] });
const client = createCofheClient(config);
await client.connect(publicClient, walletClient);
await client.permits.createSelf({ issuer: wallet.address });

// Tool handler dispatcher
async function executeToolHandler(toolName: string, params: any) {
  switch (toolName) {
    case 'get_yields':
      return handleGetYields();
    case 'deposit':
      return handleDeposit(params);
    case 'buy_rwa':
      return handleBuyRwa(params);
    case 'view_portfolio':
      return handleViewPortfolio();
    case 'claim_yield':
      return handleClaimYield(params);
    case 'set_risk_params':
      return handleSetRiskParams(params);
    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}
```

---

## Agent wallet (hackathon approach)

The agent needs a wallet to sign transactions, but it should NOT have the investor's private key.

For the hackathon, we use a dedicated **agent wallet** — a separate wallet funded by the investor with a capped USDC balance:

```
Investor Wallet (MetaMask)
│
├── Funds a dedicated agent wallet:
│   ├── Sends $X USDC to the agent wallet address
│   ├── Agent can only spend what's in this wallet
│   └── Investor can drain the agent wallet anytime
│
└── Agent backend holds the agent wallet private key
    ├── Stored in environment variable (AGENT_WALLET_KEY)
    ├── Used to sign transactions on behalf of investor
    └── If wallet is empty → agent can't act
```

This is simple, safe, and sufficient to demonstrate the concept. The agent's maximum risk exposure is the funded amount.

**Production upgrade (post-hackathon):** Replace the agent wallet with EIP-7702 session keys — scoped, time-limited, revocable wallet permissions set on-chain. This eliminates the need for a separate funded wallet and allows fine-grained controls (daily spend limits, whitelisted contracts, expiry dates).

---

## Hackathon scope vs. roadmap

### Wave 4 scope (build this)

- 3 tools: `get_yields`, `deposit` + `buy_rwa` (combined flow), `view_portfolio`
- Advisory conversation: risk assessment → allocation recommendation → confirmation → execution
- Chat UI in Vue 3
- Hardcoded yield data (no oracle integration yet)

### Roadmap (build later)

- `claim_yield` tool (requires ReineiraOS escrow integration)
- `set_risk_params` tool (requires RiskParams contract)
- Auto-rebalancing based on drift tolerance
- Auto-reinvestment of claimed yields
- Insurance purchasing tool
- Session key integration (EIP-7702)
- Multiple LLM provider support
- Agent performance analytics
- Agent-to-agent coordination via x402 payments and ERC-8004 identity (production enhancement — hackathon scope uses direct SDK calls from the portfolio agent)

---

<img src="./docs/images/agent-flow-diagram.jpg" alt="Agent Flow Diagram" width="850" />