import { onBeforeUnmount, ref, watch, nextTick, type Ref } from 'vue'

/**
 * Wave 4 §5 Path D — accessibility primitives for our checkout modals
 * (CheckoutLinkModal · SigningSecretRevealModal · CreateCheckoutSuccessCard's
 * parent ConfirmModal). Surfaced by the Accessibility-Auditor agent's
 * CRITICAL findings:
 *
 *   1. **ESC key dismissal** — modals previously closed only via X-button
 *      or backdrop click. Keyboard-only users had no escape.
 *   2. **Focus restoration on close** — focus would land on `<body>` after
 *      `emit('close')`; screen readers re-announced from page top.
 *   3. **Focus trap on open** — Tab key escaped the modal into the
 *      underlying page DOM.
 *
 * The composable owns:
 *   - `document.addEventListener('keydown', ...)` for ESC.
 *   - A ref to the previously-focused element (captured on `setOpen(true)`)
 *     and restoration to it on `setOpen(false)`.
 *   - A focus-trap on Tab within the modal's root element.
 *
 * Callers pass:
 *   - `isOpen: Ref<boolean>` — reactive open-state ref.
 *   - `rootRef: Ref<HTMLElement | null>` — the modal's root element ref
 *     (for the focus trap + first-focus targeting).
 *   - `onEscape: () => void` — called when the user presses ESC.
 *
 * Wave 5 may swap to focus-trap-vue or `<inert>` once focus-trap-vue
 * 4.x ships native Vue 3 support; today this is a 70-line replacement
 * that ships with the dashboard.
 */

export interface UseModalA11yOptions {
  isOpen: Ref<boolean>
  rootRef: Ref<HTMLElement | null>
  onEscape: () => void
  /**
   * When true, ESC + backdrop click are ignored. Useful for modals
   * mid-submission or those that gate close behind acknowledgment
   * (SigningSecretRevealModal's checkbox).
   */
  disableEscape?: Ref<boolean>
}

/**
 * Selector for elements that participate in the Tab focus loop. Mirrors
 * the WAI-ARIA Authoring Practices interactive-elements list — keep in
 * sync with focus-trap-vue's default if we ever swap.
 */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

export function useModalA11y(opts: UseModalA11yOptions): void {
  const previousFocus = ref<HTMLElement | null>(null)

  function handleKeydown(e: KeyboardEvent): void {
    if (!opts.isOpen.value) return
    if (e.key === 'Escape') {
      if (opts.disableEscape?.value) return
      e.stopPropagation()
      opts.onEscape()
      return
    }
    if (e.key === 'Tab' && opts.rootRef.value) {
      const focusables = Array.from(
        opts.rootRef.value.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((el) => {
        // Defensive: skip hidden / display:none elements that match
        // the selector but aren't actually keyboard-reachable.
        return el.offsetParent !== null || el.tagName === 'BODY'
      })
      if (focusables.length === 0) {
        e.preventDefault()
        return
      }
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement as HTMLElement | null
      if (e.shiftKey) {
        if (active === first || !opts.rootRef.value.contains(active)) {
          e.preventDefault()
          last.focus()
        }
      } else {
        if (active === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
  }

  watch(opts.isOpen, (open) => {
    if (open) {
      previousFocus.value = document.activeElement as HTMLElement | null
      document.addEventListener('keydown', handleKeydown, true)
      // Land focus inside the modal on next tick so the rendered DOM is
      // attached before we query for focusables.
      nextTick(() => {
        if (!opts.rootRef.value) return
        const first = opts.rootRef.value.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)
        if (first) {
          first.focus()
        } else {
          opts.rootRef.value.focus()
        }
      })
    } else {
      document.removeEventListener('keydown', handleKeydown, true)
      const prev = previousFocus.value
      if (prev && typeof prev.focus === 'function') {
        // Defensive — call site may have been re-rendered out of the DOM.
        try {
          prev.focus()
        } catch {
          /* noop */
        }
      }
      previousFocus.value = null
    }
  })

  onBeforeUnmount(() => {
    document.removeEventListener('keydown', handleKeydown, true)
  })
}

/**
 * Wave 4 §5 Path D — beforeunload guard for the one-time
 * `SigningSecretRevealModal`. Once the secret renders, the user MUST
 * acknowledge the warning + copy the secret before close; an accidental
 * tab close / refresh / back-button without acknowledging silently
 * destroys the secret. Adding `beforeunload` shows the browser's
 * native "Are you sure?" prompt while the modal is open + secret
 * unconfirmed.
 *
 * Idempotent: only one listener is attached even if the composable is
 * called twice (defensive against re-mount).
 */
export function useBeforeUnloadGuard(active: Ref<boolean>): void {
  function handler(e: BeforeUnloadEvent): void {
    if (!active.value) return
    // Per the spec, `e.preventDefault()` + a non-empty `returnValue`
    // is the way to trigger the browser prompt. Modern browsers ignore
    // the custom message and show their own — that's fine, the goal
    // is just to interrupt the navigation.
    e.preventDefault()
    e.returnValue = ''
  }

  watch(
    active,
    (on) => {
      if (on) {
        window.addEventListener('beforeunload', handler, { capture: true })
      } else {
        window.removeEventListener('beforeunload', handler, true)
      }
    },
    { immediate: true },
  )

  onBeforeUnmount(() => {
    window.removeEventListener('beforeunload', handler, true)
  })
}
