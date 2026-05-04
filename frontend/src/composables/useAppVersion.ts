import { APP_MODE, APP_VERSION } from '@/lib/version'

/**
 * Build-time version metadata for surfaces (LandingPage footer, LoginPage
 * card, Sidebar bottom). Three return shapes for one source — keeps the
 * format authoritative here so per-surface markup stays cosmetic.
 *
 * - `semver`: bare `0.3.0`, no `v` prefix — for cases where the consumer
 *   wants to compose its own label.
 * - `env`: `null` on prod builds, the Vite mode otherwise (`'stage'` /
 *   `'development'`). A stage artifact slipping into a prod conversation
 *   is the disambiguation case worth surfacing.
 * - `fullLabel`: ready-to-render `v0.3.0` (prod) or `v0.3.0 · stage`.
 */
export function useAppVersion() {
  const semver = APP_VERSION
  const env = APP_MODE === 'production' ? null : APP_MODE
  const fullLabel = env ? `v${semver} · ${env}` : `v${semver}`
  return { semver, env, fullLabel }
}
