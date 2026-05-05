import { decodeBase64Url } from './fragment.js';

/**
 * AES-256-GCM decrypt for the hosted-checkout encrypted payload (Wave 4
 * P5).
 *
 * Wire format mirrors the backend codec
 * (`backend/src/infrastructure/checkout/aes-gcm.ts`):
 *
 *     <iv-base64url>:<authTag-base64url>:<ciphertext-base64url>
 *
 * Buyer-side decryption uses the Web Crypto API. Because Web Crypto's
 * `AES-GCM` decrypt expects the auth tag CONCATENATED with the
 * ciphertext, we glue the two before invoking `subtle.decrypt`.
 */

export interface CheckoutPayload {
  amountUsd6: string;
  memo?: string;
  referenceId?: string;
}

export async function decryptPayload(
  encPayload: string,
  fragmentKey: string,
): Promise<CheckoutPayload> {
  const parts = encPayload.split(':');
  if (parts.length !== 3) {
    throw new Error('encPayload must have exactly 3 colon-separated parts');
  }
  const [ivPart, tagPart, ctPart] = parts;
  if (!ivPart || !tagPart || !ctPart) {
    throw new Error('encPayload contains empty segment');
  }
  const iv = decodeBase64Url(ivPart);
  const authTag = decodeBase64Url(tagPart);
  const ciphertext = decodeBase64Url(ctPart);
  if (iv.length !== 12) throw new Error('iv must be 12 bytes');
  if (authTag.length !== 16) throw new Error('authTag must be 16 bytes');

  const keyBytes = decodeBase64Url(fragmentKey);
  if (keyBytes.length !== 32) throw new Error('fragment key must be 32 bytes');

  // Allocate against a non-shared ArrayBuffer so the WebCrypto types
  // (which insist on `ArrayBuffer`, not `ArrayBufferLike`) accept the
  // typed-array view. The decode helpers above return Uint8Array<ArrayBufferLike>
  // which TS5+ refuses to widen.
  const cipherWithTagBuf = new ArrayBuffer(ciphertext.length + authTag.length);
  const cipherWithTag = new Uint8Array(cipherWithTagBuf);
  cipherWithTag.set(ciphertext, 0);
  cipherWithTag.set(authTag, ciphertext.length);

  const keyBuf = new ArrayBuffer(keyBytes.length);
  new Uint8Array(keyBuf).set(keyBytes);

  const ivBuf = new ArrayBuffer(iv.length);
  new Uint8Array(ivBuf).set(iv);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBuf,
    { name: 'AES-GCM' },
    false,
    ['decrypt'],
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ivBuf, tagLength: 128 },
    cryptoKey,
    cipherWithTagBuf,
  );
  const json = new TextDecoder('utf-8').decode(plaintext);
  const parsed = JSON.parse(json);
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    typeof parsed.amountUsd6 !== 'string'
  ) {
    throw new Error('decrypted payload missing amountUsd6');
  }
  return parsed as CheckoutPayload;
}

/**
 * Format a USDC 6-decimal amount as `1,234.56`. Pure helper — kept here
 * so the buyer page renders the same shape regardless of the locale's
 * default Number formatting.
 */
export function formatUsd6(amountUsd6: string): string {
  // Pad to at least 7 chars so the integer slice is always non-empty.
  const padded = amountUsd6.padStart(7, '0');
  const intPart = padded.slice(0, padded.length - 6);
  const fracPart = padded.slice(-6);
  // Strip trailing zeros from the fractional but keep at least 2.
  let trimmed = fracPart.replace(/0+$/, '');
  if (trimmed.length < 2) trimmed = trimmed.padEnd(2, '0');
  // Group thousands in the integer part.
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${grouped}.${trimmed}`;
}
