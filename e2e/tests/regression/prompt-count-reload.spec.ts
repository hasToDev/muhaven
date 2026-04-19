import { roleTest as test } from '../../lib/fixtures.js'

test.describe.configure({ mode: 'serial' })

/**
 * Gated on frontend instrumentation — see PLAYWRIGHT_QA.md §5.6.
 *
 * After reload, the post-session-install tab currently fires up to 3 prompts
 * (passkey reconnect + FHE permit + session re-enable) — documented as ⚠️ in
 * POST_HACKATHON.md. Any count > 3 on the post-reload distribute is a regression
 * beyond what's tracked.
 */
test.fixme('prompt count — post-reload distribute fires at most 3 prompts', async () => {
  // TODO: instrument frontend, then implement the count-post-reload flow.
})
