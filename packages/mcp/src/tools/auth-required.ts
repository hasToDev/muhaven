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
