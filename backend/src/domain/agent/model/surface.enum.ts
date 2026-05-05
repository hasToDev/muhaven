/**
 * Per ADR-0: agent state is keyed by `userId × surface` so the same user can
 * be in different tiers across the four Wave 4 surfaces. Security-event
 * triggers (T-5 KYC revocation, T-6 account recovery) cascade across all
 * surfaces; explicit user actions (T-1 pause) can be scoped per surface.
 */
export const Surface = {
  HavenBot: 'havenbot',
  MCP: 'mcp',
  OpenClaw: 'openclaw',
  Checkout: 'checkout',
} as const;

export type Surface = (typeof Surface)[keyof typeof Surface];

export const SURFACE_VALUES: readonly Surface[] = [
  Surface.HavenBot,
  Surface.MCP,
  Surface.OpenClaw,
  Surface.Checkout,
] as const;

export function isSurface(value: unknown): value is Surface {
  return typeof value === 'string' && (SURFACE_VALUES as readonly string[]).includes(value);
}
