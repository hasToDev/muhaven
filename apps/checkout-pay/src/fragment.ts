/**
 * URL fragment + path parsing for the hosted-checkout buyer page (P5).
 *
 * Expected URL shape (post-2026-05-15 subdomain-collapse migration):
 *
 *     <origin>/pay/c/<sessionId>#k=<base64url(32B)>
 *
 * The `/pay/` prefix is the migration's path lever: the buyer page now
 * lives under the dashboard's apex origin (muhaven.app/pay/) so the
 * dashboard's GPM-backed passkey credential is the buyer-page credential
 * by construction (same origin = same authenticator routing). Vite's
 * `base: '/pay/'` mints asset URLs with the prefix; GitHub Pages
 * serves `muhaven-web/pay/404.html` as the SPA fallback.
 *
 * Both the sessionId AND the fragment key are required. A missing or
 * malformed key resolves to `null` so the page can show a clear
 * "URL is malformed" error rather than silently fail downstream.
 *
 * The sessionId itself is sanitized against the same regex the backend
 * uses (`cs_<26 base32>`) to defeat path-traversal-style probes.
 *
 * Legacy URLs (`https://pay.muhaven.app/c/<id>#k=<key>`) minted before
 * the migration are handled by a `window.location.replace` shim at the
 * old origin that bounces them to `https://muhaven.app/pay/c/<id>#k=<key>`
 * with the fragment preserved.
 */

const SESSION_ID_RE = /^cs_[A-Z0-9]{26}$/;
const FRAGMENT_KEY_RE = /^[A-Za-z0-9_-]{43}$/; // base64url(32B) is 43 chars unpadded

export interface CheckoutLocation {
  sessionId: string;
  fragmentKey: string;
}

export function parseCheckoutLocation(loc: Location): CheckoutLocation | null {
  // Path: /pay/c/<sessionId>
  const segments = loc.pathname.split('/').filter(Boolean);
  if (segments.length !== 3 || segments[0] !== 'pay' || segments[1] !== 'c') return null;
  const sessionId = segments[2];
  if (!sessionId || !SESSION_ID_RE.test(sessionId)) return null;

  // Fragment: #k=<base64url>
  const hash = loc.hash.startsWith('#') ? loc.hash.slice(1) : loc.hash;
  if (!hash) return null;
  const params = new URLSearchParams(hash);
  const k = params.get('k');
  if (!k || !FRAGMENT_KEY_RE.test(k)) return null;

  return { sessionId, fragmentKey: k };
}

export function decodeBase64Url(s: string): Uint8Array {
  const pad = (4 - (s.length % 4)) % 4;
  const std = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad);
  const bin = atob(std);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
