/**
 * Shared AUTH_REQUIRED payload used by both server-level and handler-level
 * unauthorized mappings.
 *
 * Why both layers? The handlers wrap every BackendClient call in a
 * try/catch + `mapBackendError(...)` (so the structured tool result is
 * uniform). That means a `BackendError(unauthorized)` is converted to a
 * normal return value and never reaches `server.ts`'s catch block, where
 * the original AUTH_REQUIRED branch lived. Surfacing it from BOTH layers:
 *  1. handler layer → catches the common case (backend 401 after one
 *     refresh retry).
 *  2. server layer → catches the JwtSource-throws-NoJwtAvailable case,
 *     which propagates THROUGH the handler (the handler never sees a
 *     BackendError because no HTTP request fires).
 *
 * Producing the same payload from both keeps the host LLM's parsing path
 * stable (always look for `code: 'AUTH_REQUIRED'`).
 */

import { trimTrailingSlash } from '../config.js';

export interface AuthRequiredPayload {
  readonly ok: false;
  readonly code: 'AUTH_REQUIRED';
  readonly message: string;
  readonly loginCommand: string;
}

export function authRequiredPayload(): AuthRequiredPayload {
  return {
    ok: false,
    code: 'AUTH_REQUIRED',
    message:
      'No JWT in broker keystore. Run `muhaven-broker login` to authenticate via the device-code ceremony, then retry this tool.',
    loginCommand: 'muhaven-broker login',
  };
}

/**
 * Sibling to `AUTH_REQUIRED` — used when the broker daemon is reachable
 * but boots in read-only posture (no `MUHAVEN_BROKER_SESSION_KEY` at
 * startup). The remediation is NOT `muhaven-broker login` — that mints
 * a JWT, which is different from minting a session key. The session key
 * comes from the dashboard's `/agent/policy/transition` ceremony (see
 * Q1 in the post-§4 queue).
 *
 * Surfacing this as a distinct code lets the host LLM disambiguate:
 *  - `AUTH_REQUIRED` → run a CLI command (deterministic, one-step).
 *  - `SESSION_KEY_REQUIRED` → open a URL and complete a passkey ceremony
 *    (operator-mediated, multi-step). The LLM should NOT auto-suggest
 *    `muhaven-broker login` for this case — that would loop the user
 *    indefinitely without minting a key.
 */
export interface SessionKeyRequiredPayload {
  readonly ok: false;
  readonly code: 'SESSION_KEY_REQUIRED';
  readonly message: string;
  readonly mintUrl: string;
}

export function sessionKeyRequiredPayload(
  dashboardBaseUrl = 'https://muhaven.app',
): SessionKeyRequiredPayload {
  // Defensive trim — `loadMcpConfig` already strips trailing slashes, but
  // a downstream caller passing a raw env value or a `${url}/` template
  // shouldn't produce a double-slash mintUrl. Shares the helper with
  // `config.ts` so a future url-shape change lands at one site.
  const mintUrl = `${trimTrailingSlash(dashboardBaseUrl)}/agent/policy/transition`;
  return {
    ok: false,
    code: 'SESSION_KEY_REQUIRED',
    message:
      `No session key loaded in broker (read-only posture). Mint one via the ` +
      `dashboard at ${mintUrl}, copy the 0x-prefixed hex into ` +
      `MUHAVEN_BROKER_SESSION_KEY, and restart the daemon. Do NOT run ` +
      `\`muhaven-broker login\` for this — that mints a JWT, not a session key.`,
    mintUrl,
  };
}
