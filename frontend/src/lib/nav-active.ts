/**
 * Wave 5 Option D · Commit 4 — resolve the single active nav item by
 * LONGEST matching path.
 *
 * The `Policy` entry (`/agent/policy/transition`) is a sub-route of the
 * `Agent` entry (`/agent`). A naive prefix-match (`route.startsWith(p)`)
 * lit BOTH pills on the policy page. Longest-prefix-wins makes the most
 * specific entry the sole active one — `/agent/policy/transition` beats
 * `/agent`, while `/checkout` still wins for `/checkout/:id` (it's the
 * only registered nav path that prefixes it).
 *
 * Pure + framework-free so Sidebar.vue + TopNav.vue share ONE
 * implementation and the unit tests exercise it without mounting.
 *
 * A path `p` matches the current route when it's an exact match OR a
 * path-segment prefix (`route === p + '/...'`). The `+ '/'` guard stops
 * `/agent` from matching `/agentfoo`.
 */
export function resolveActiveNavPath(
  navPaths: readonly string[],
  currentPath: string,
): string | null {
  let best: string | null = null
  for (const p of navPaths) {
    const matches = currentPath === p || currentPath.startsWith(p + '/')
    if (matches && (best === null || p.length > best.length)) {
      best = p
    }
  }
  return best
}
