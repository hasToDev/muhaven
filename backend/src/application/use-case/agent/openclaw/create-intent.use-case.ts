import { createHash, randomBytes, randomInt } from 'node:crypto';
import { ApplicationHttpError } from '../../../../core/errors.js';
import {
  classifyTier,
  OpenClawIntent,
  OpenClawIntentKind,
  type OpenClawIntentPayload,
  OpenClawIntentStatus,
  OpenClawIntentTier,
} from '../../../../domain/agent/model/openclaw-intent.js';
import type { IOpenClawIntentRepository } from '../../../../domain/agent/repository/openclaw-intent.repository.js';

/**
 * Time-to-live for a freshly-minted intent before it auto-expires. Five
 * minutes mirrors device-flow + confirm-token TTLs (R-3 replay window).
 *
 * Per the research §6 confirmation tier table, the inline tier wants a
 * tighter window so a stale Telegram message doesn't survive a chat
 * history scroll-back; the passkey deep-link tier wants a slightly
 * looser window because the dashboard hop adds latency. Tier-keyed TTL
 * captures both.
 */
const TIER_TTL_SEC: Record<OpenClawIntentTier, number> = {
  [OpenClawIntentTier.Inline]: 300,
  [OpenClawIntentTier.MiniAppOtp]: 300,
  [OpenClawIntentTier.PasskeyDeeplink]: 600,
};

export interface CreateOpenClawIntentInput {
  userId: string;
  kind: OpenClawIntentKind;
  amountUsd6: bigint;
  payload: Omit<OpenClawIntentPayload, 'amountUsd6'> & { amountUsd6?: never };
  /** Telegram chatId that originated the intent. Optional. */
  telegramChatId?: string;
  now?: Date;
}

export interface CreateOpenClawIntentResult {
  intent: OpenClawIntent;
  /**
   * The 6-digit OTP for the mini_app_otp tier, returned ONCE at create
   * time. Caller (Telegram bot) is responsible for delivering this to
   * the user via a separate Telegram message — it MUST NOT be embedded
   * in the same message as the Mini App button (out-of-band requirement).
   * For other tiers this is undefined.
   */
  otp?: string;
}

/**
 * Mint an OpenClaw confirmation intent. Tier is derived from amount; OTP
 * is generated at create time for the mini_app_otp tier and surfaced to
 * the caller exactly once. The hash of `(kind, sortedPayload, userId,
 * createdAtSec)` is committed to the row so a confirmation can verify
 * the LLM-emitted intent matches what the user is approving.
 */
export class CreateOpenClawIntentUseCase {
  constructor(private readonly intentRepo: IOpenClawIntentRepository) {}

  async execute(input: CreateOpenClawIntentInput): Promise<CreateOpenClawIntentResult> {
    if (input.amountUsd6 < 0n) {
      throw ApplicationHttpError.badRequest('amountUsd6 must be non-negative');
    }
    const tier = classifyTier(input.amountUsd6);
    const ttlSec = TIER_TTL_SEC[tier];
    const now = input.now ?? new Date();
    const expiresAt = new Date(now.getTime() + ttlSec * 1000);
    const intentId = generateIntentId();

    const fullPayload: OpenClawIntentPayload = {
      token: input.payload.token,
      amountUsd6: input.amountUsd6.toString(),
      summary: input.payload.summary,
      ...(input.payload.escrowId ? { escrowId: input.payload.escrowId } : {}),
      ...(input.payload.issuerLabel ? { issuerLabel: input.payload.issuerLabel } : {}),
    };

    const intentHash = computeIntentHash(
      input.kind,
      fullPayload,
      input.userId,
      Math.floor(now.getTime() / 1000),
    );

    let otp: string | null = null;
    if (tier === OpenClawIntentTier.MiniAppOtp) {
      otp = generateOtp();
    }

    const intent = new OpenClawIntent({
      intentId,
      userId: input.userId,
      kind: input.kind,
      tier,
      status: OpenClawIntentStatus.Pending,
      amountUsd6: input.amountUsd6,
      payload: fullPayload,
      intentHash,
      otp,
      telegramChatId: input.telegramChatId ?? null,
      confirmedAt: null,
      consumedAt: null,
      deniedAt: null,
      denyReason: null,
      expiresAt,
      createdAt: now,
      updatedAt: now,
    });

    await this.intentRepo.issue({ intent });

    return otp ? { intent, otp } : { intent };
  }
}

const INTENT_ID_PREFIX = 'oci_';

/**
 * Intent id format: `oci_<26-char alphabet>`. 26 chars over a 30-char
 * Crockford-style alphabet is ~127 bits of entropy — well above the
 * 80-bit floor for unguessable handles.
 *
 * Implementation note: a streaming-base32 encoder over 16 random bytes
 * overflows JS Number around byte 7 (Number is 53-bit safe-int). The
 * straightforward fix is one-byte-modulo-30 sampling. This biases the
 * alphabet slightly (256 % 30 ≠ 0), but the bias is ≤ 6/256 per char —
 * orders of magnitude below the security margin we need.
 */
const INTENT_ID_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
function generateIntentId(): string {
  const buf = randomBytes(26);
  let out = '';
  for (const b of buf) {
    out += INTENT_ID_ALPHABET[b % INTENT_ID_ALPHABET.length];
  }
  return INTENT_ID_PREFIX + out;
}

/**
 * 6-digit numeric OTP. `crypto.randomInt(0, 1_000_000)` gives a uniform
 * distribution over [000000, 999999]; pad with leading zeros so the
 * UX stays "type these six digits" rather than "type up to six digits".
 */
function generateOtp(): string {
  const n = randomInt(0, 1_000_000);
  return n.toString().padStart(6, '0');
}

/**
 * Stable JSON stringifier for the payload. Sorts object keys
 * alphabetically at every depth so a hash drift implies the LLM emitted
 * a semantically different intent (not just key reorder).
 */
function stableStringify(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',') + '}';
}

function computeIntentHash(
  kind: OpenClawIntentKind,
  payload: OpenClawIntentPayload,
  userId: string,
  createdAtSec: number,
): string {
  const stable = stableStringify({ kind, payload, userId, createdAtSec });
  return createHash('sha256').update(stable, 'utf-8').digest('hex');
}
