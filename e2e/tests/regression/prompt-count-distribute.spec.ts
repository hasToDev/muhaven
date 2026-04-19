import { roleTest as test } from '../../lib/fixtures.js'

test.describe.configure({ mode: 'serial' })

/**
 * Gated on frontend instrumentation — see PLAYWRIGHT_QA.md §5.6.
 *
 * Once `emitE2EMarker` is wired into the ZeroDev provider + useFhe, this test
 * asserts exactly 2 markers on first distribute, then 0 on the second.
 *
 * Leave as fixme until the instrumentation lands. Running today produces
 * no markers and would false-pass / false-fail on noise.
 */
test.fixme('prompt count — first distribute fires exactly 2, second fires 0', async () => {
  // TODO: instrument frontend (see PLAYWRIGHT_QA.md §5.6) then implement:
  //   const markers: string[] = []
  //   page.on('console', (msg) => {
  //     if (msg.text().includes('[E2E] webauthn-prompt-start')) markers.push(msg.text())
  //   })
  //   // ...run first distribute, expect markers.length === 2
  //   // ...run second distribute, expect markers.length unchanged
})
