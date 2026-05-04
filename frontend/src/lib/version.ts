import pkg from '../../package.json'

/**
 * SemVer string from `frontend/package.json`. Bump per release.
 */
export const APP_VERSION: string = pkg.version

/**
 * Vite-set build mode. `'production'` for `bun run build`, `'stage'` for
 * `bun run build:stage` / `bun run dev:stage`, `'development'` for `bun run dev`.
 * Used by the version composable to suffix non-prod builds so a stage
 * artifact doesn't get mistaken for prod in screenshots / bug reports.
 */
export const APP_MODE: string = import.meta.env.MODE
