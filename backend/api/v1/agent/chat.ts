import { AgentChatDtoSchema, type AgentChatResponseDto } from '../../../src/application/dto/agent/chat.dto.js';
import { createHandler } from '../../../src/interface/handler-factory.js';
import { withAuth } from '../../../src/interface/middleware/with-auth.js';
import { withCors } from '../../../src/interface/middleware/with-cors.js';
import { Response } from '../../../src/interface/response.js';

/**
 * Keyword patterns → context-aware responses.
 * Each pattern checks the lowercased message for keywords and returns
 * an appropriate response with optional card type/data.
 *
 * This is a stub for Phase 17 — will be replaced with real LLM + tool calls.
 */
const PATTERNS: Array<{
  keywords: string[];
  response: AgentChatResponseDto['response'];
}> = [
  {
    keywords: ['yield', 'apy', 'rate', 'interest', 'return'],
    response: {
      text: 'Current yields across your RWA tokens: Treasury Bond Fund (MHTB) is at 4.8% APY with monthly distributions. Money Market Fund (MHMM) is at 5.2% APY. Both are performing above benchmark. Your next distribution is estimated in approximately 3 days.',
      card_type: 'insight',
      card_data: {
        title: 'Yield Overview',
        body: 'MHTB: 4.8% APY (monthly) · MHMM: 5.2% APY (monthly). All yields are encrypted via FHE — only you can see your individual share.',
        suggestions: ['Show yield history', 'Claim pending yields'],
      },
    },
  },
  {
    keywords: ['portfolio', 'holdings', 'balance', 'position', 'allocation'],
    response: {
      text: 'Your portfolio is well diversified across RWA tokens. Treasury bonds provide stability while money market offers higher yield. All balances are FHE-encrypted — I can help you decrypt them for viewing.',
      card_type: 'insight',
      card_data: {
        title: 'Portfolio Health',
        body: 'Allocation is within target ranges. Your balances are encrypted on-chain via Fhenix FHE. Use "decrypt balance" to view individual holdings.',
        suggestions: ['Decrypt balances', 'Optimize allocation'],
      },
    },
  },
  {
    keywords: ['deposit', 'add fund', 'fund', 'usdc', 'pusdc'],
    response: {
      text: 'I can help you deposit USDC into your MuHaven account. The process wraps your USDC into PUSDC (confidential stablecoin) via ReineiraOS, then you can use it to purchase RWA tokens. How much would you like to deposit?',
      card_type: 'form',
      card_data: {
        type: 'deposit',
      },
    },
  },
  {
    keywords: ['withdraw', 'cash out', 'redeem'],
    response: {
      text: 'I can help you withdraw funds. This will unwrap your PUSDC back to USDC. Note that any RWA token positions should be sold first. How much would you like to withdraw?',
      card_type: 'form',
      card_data: {
        type: 'withdraw',
      },
    },
  },
  {
    keywords: ['rebalance', 'optimize', 'adjust', 'reallocate'],
    response: {
      text: 'Based on current market conditions and your risk parameters, here\'s my recommended rebalance:',
      card_type: 'action',
      card_data: {
        title: 'Suggested Rebalance',
        description: 'Move 5% from Cash Buffer to Money Market Fund for +0.3% portfolio APY. All operations are encrypted — no one can see the rebalance details.',
        actions: [
          { label: 'Approve', variant: 'primary' },
          { label: 'Modify', variant: 'secondary' },
          { label: 'Reject', variant: 'ghost' },
        ],
      },
    },
  },
  {
    keywords: ['claim', 'collect', 'payout'],
    response: {
      text: 'You have pending yield claims available. I\'ll initiate the claim process through ReineiraOS encrypted escrow.',
      card_type: 'status',
      card_data: {
        status: 'pending',
        description: 'Yield claim initiated — processing via ReineiraOS escrow',
      },
    },
  },
  {
    keywords: ['risk', 'guardrail', 'limit', 'exposure', 'drawdown'],
    response: {
      text: 'Your risk parameters are stored encrypted on-chain via Fhenix FHE. Current settings include max drawdown tolerance, minimum yield threshold, drift tolerance, and max daily spend. I operate within these guardrails at all times.',
      card_type: 'insight',
      card_data: {
        title: 'Risk Parameters',
        body: 'All risk guardrails are FHE-encrypted (4x euint64). Only you can decrypt and modify them. I execute within these bounds without seeing the actual values.',
        suggestions: ['View risk params', 'Update guardrails'],
      },
    },
  },
  {
    keywords: ['compliance', 'kyc', 'whitelist', 'eligible'],
    response: {
      text: 'Your KYC status is verified through the ERC-3643 ONCHAINID adapter. You are eligible for all active RWA tokens on the platform. Compliance checks happen on-chain — the issuer sees only aggregate data, never your individual position.',
      card_type: 'insight',
      card_data: {
        title: 'Compliance Status',
        body: 'KYC: Verified · Tier: Full Access · Provider: ERC-3643 ONCHAINID. Individual KYC details are secured on-chain.',
        suggestions: ['View eligible tokens', 'Check accreditation'],
      },
    },
  },
  {
    keywords: ['buy', 'purchase', 'invest', 'token', 'rwa'],
    response: {
      text: 'I can help you purchase RWA tokens. Available tokens include Treasury Bond Fund (MHTB) at 4.8% APY and Money Market Fund (MHMM) at 5.2% APY. All purchases use encrypted transfers — the amount is never visible on-chain.',
      card_type: 'action',
      card_data: {
        title: 'Purchase RWA Token',
        description: 'Select a token and amount. The purchase is executed via FHE-encrypted transfer — no one can see the transaction amount.',
        actions: [
          { label: 'Buy MHTB', variant: 'primary' },
          { label: 'Buy MHMM', variant: 'secondary' },
          { label: 'Browse tokens', variant: 'ghost' },
        ],
      },
    },
  },
  {
    keywords: ['help', 'what can you', 'how do', 'explain'],
    response: {
      text: 'I\'m your MuHaven portfolio agent. I can help you with:\n\n• **View portfolio** — See your encrypted RWA holdings\n• **Deposit/Withdraw** — Move USDC in and out via PUSDC\n• **Buy RWA tokens** — Purchase encrypted RWA positions\n• **Check yields** — See current APY rates and pending claims\n• **Rebalance** — Optimize your allocation\n• **Risk settings** — View or update your encrypted guardrails\n\nAll operations are privacy-preserving — I operate on encrypted state and never see your actual balances.',
    },
  },
];

const DEFAULT_RESPONSE: AgentChatResponseDto['response'] = {
  text: 'I understand. As your portfolio agent, I can help with deposits, yield checking, token purchases, portfolio rebalancing, and risk management — all on encrypted state. What would you like to do?',
  card_type: 'insight',
  card_data: {
    title: 'How Can I Help?',
    body: 'I operate on FHE-encrypted state. I can manage your portfolio without ever seeing your balances, yields, or strategy.',
    suggestions: ['Check yields', 'View portfolio', 'Deposit USDC'],
  },
};

function matchResponse(message: string): AgentChatResponseDto['response'] {
  const lower = message.toLowerCase();

  for (const pattern of PATTERNS) {
    if (pattern.keywords.some((kw) => lower.includes(kw))) {
      return pattern.response;
    }
  }

  return DEFAULT_RESPONSE;
}

const handler = createHandler({
  operationName: 'AgentChat',
  schema: AgentChatDtoSchema,
  execute: async (dto) => {
    // withAuth guarantees authPayload exists — wallet address is always available
    const matched = matchResponse(dto.message);
    const response: AgentChatResponseDto = { response: matched };
    return Response.ok(response);
  },
});

export default withCors(withAuth(handler));
