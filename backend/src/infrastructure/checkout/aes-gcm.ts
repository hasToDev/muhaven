import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

/**
 * AES-256-GCM symmetric encryption for the hosted-checkout encrypted
 * payload (Wave 4 P5).
 *
 * The encrypted blob carries the buyer-facing amount + nonce + memo. The
 * 32-byte key is generated at session-create time and surfaced to the
 * issuer ONCE in the URL fragment — the backend persists only the
 * ciphertext, so a leaked DB dump alone cannot decrypt the payload.
 *
 * Wire format (compact, base64url-safe — `:` separator):
 *
 *     <iv-base64url>:<authTag-base64url>:<ciphertext-base64url>
 *
 * - IV is 12 random bytes (NIST SP 800-38D recommended for GCM).
 * - authTag is 16 bytes (GCM default).
 * - The three components decode independently; a malformed component
 *   raises `decryptPayload`'s explicit error rather than risking a
 *   silent partial decode.
 *
 * Why not raw `cipher.final()` concatenation? Because we need to ship
 * the IV alongside the ciphertext, and inlining at the start works but
 * means receivers must know the IV length. Three explicit fields make
 * the format self-describing for any third-party tooling that wants to
 * inspect a payload without re-implementing the codec.
 */

export interface EncryptResult {
  /** Base64url-encoded `iv:authTag:ciphertext` envelope. */
  encPayload: string;
  /** Raw 32-byte key — caller should base64url-encode for the URL fragment. */
  key: Buffer;
}

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class CheckoutAesGcm {
  /**
   * Encrypt a JSON-serialisable payload. The returned key MUST be
   * surfaced to the buyer-facing URL fragment; the backend does NOT
   * persist it.
   */
  encrypt(payload: unknown): EncryptResult {
    const key = randomBytes(KEY_BYTES);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const json = JSON.stringify(payload);
    const ciphertext = Buffer.concat([
      cipher.update(json, 'utf-8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    const encPayload = `${b64url(iv)}:${b64url(authTag)}:${b64url(ciphertext)}`;
    return { encPayload, key };
  }

  /**
   * Decrypt a ciphertext envelope. Throws on any structural mismatch —
   * caller is responsible for catching and translating to a 400/422.
   *
   * Length-checks the IV / authTag explicitly so a tampered envelope
   * cannot smuggle a different IV / tag length past `createDecipheriv`.
   */
  decrypt(encPayload: string, key: Buffer): unknown {
    if (key.length !== KEY_BYTES) {
      throw new Error(`AES-256-GCM key must be ${KEY_BYTES} bytes`);
    }
    const parts = encPayload.split(':');
    if (parts.length !== 3) {
      throw new Error('encPayload must have exactly 3 colon-separated parts');
    }
    const [ivPart, tagPart, ctPart] = parts;
    const iv = b64urlDecode(ivPart);
    const authTag = b64urlDecode(tagPart);
    const ciphertext = b64urlDecode(ctPart);
    if (iv.length !== IV_BYTES) throw new Error(`IV must be ${IV_BYTES} bytes`);
    if (authTag.length !== TAG_BYTES) {
      throw new Error(`authTag must be ${TAG_BYTES} bytes`);
    }
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString('utf-8'));
  }
}

export function b64url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function b64urlDecode(s: string): Buffer {
  const pad = (4 - (s.length % 4)) % 4;
  const std = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad);
  return Buffer.from(std, 'base64');
}

/** Fragment-key constants used by the hosted page. Exported so the
 *  URL builder + the apps/checkout-pay client can stay in sync. */
export const CHECKOUT_FRAGMENT_KEY_BYTES = KEY_BYTES;
