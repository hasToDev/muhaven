import { ref, type Ref } from 'vue'
import {
  agentToolsApi,
  type ActionDescriptor,
  type AgentStreamEvent,
  type AgentSuggestionItem,
  type AgentChatStreamRequest,
} from '@/services/api'

/**
 * Wave 4 P2 — HavenBot streaming chat composable.
 *
 * Bridges the SSE events (`AgentStreamEvent`) into Vue refs so the
 * UI updates incrementally. Surfaces:
 *   - `streamingText`: token-by-token agent reply being built
 *   - `pendingActions`: ActionDescriptors emitted by propose_* tools (the
 *     UI mounts a <ConfirmModal> for each one)
 *   - `isStreaming`: true while a turn is in flight
 *   - `lastError`: surfaced to the chat as an error bubble
 *
 * On a new turn the composable: aborts any in-flight stream, clears
 * streamingText, opens a fresh stream, accumulates events, and resolves
 * once the `done` event lands.
 */
export interface UseAgentChat {
  isStreaming: Ref<boolean>
  streamingText: Ref<string>
  lastError: Ref<string | null>
  pendingActions: Ref<ActionDescriptor[]>
  consumePendingAction: (toolCallId: string) => ActionDescriptor | null
  /** Returns the final accumulated text + any ActionDescriptors emitted +
   * a count of tool_result events seen on this turn + the suggestions
   * the backend emitted at the end of the turn. Callers use the
   * `toolsCalled` count to suppress the "I'm not sure how to help"
   * fallback when a read tool ran but produced no synthesised text;
   * `suggestions` drives the ActionCard chips below the agent reply. */
  send: (
    req: AgentChatStreamRequest,
  ) => Promise<{
    text: string
    actions: ActionDescriptor[]
    toolsCalled: number
    suggestions: AgentSuggestionItem[]
  }>
  abort: () => void
}

export function useAgentChat(): UseAgentChat {
  const isStreaming = ref(false)
  const streamingText = ref('')
  const lastError = ref<string | null>(null)
  const pendingActions = ref<ActionDescriptor[]>([])

  let activeController: AbortController | null = null

  function abort(): void {
    if (activeController) {
      try {
        activeController.abort()
      } catch {
        /* noop */
      }
      activeController = null
    }
    isStreaming.value = false
  }

  function consumePendingAction(toolCallId: string): ActionDescriptor | null {
    const idx = pendingActions.value.findIndex((a) => a.toolCallId === toolCallId)
    if (idx < 0) return null
    const [action] = pendingActions.value.splice(idx, 1)
    return action ?? null
  }

  function isActionDescriptor(value: unknown): value is ActionDescriptor {
    return (
      typeof value === 'object'
      && value !== null
      && 'kind' in value
      && 'toolCallId' in value
      && 'confirmTokenId' in value
      && 'sdkCall' in value
    )
  }

  async function send(
    req: AgentChatStreamRequest,
  ): Promise<{
    text: string
    actions: ActionDescriptor[]
    toolsCalled: number
    suggestions: AgentSuggestionItem[]
  }> {
    abort()
    activeController = new AbortController()
    streamingText.value = ''
    lastError.value = null
    isStreaming.value = true

    const turnActions: ActionDescriptor[] = []
    const turnCounter = { tools: 0 }
    const turnSuggestions: { items: AgentSuggestionItem[] } = { items: [] }

    let release: (() => void) | null = null
    try {
      const opened = await agentToolsApi.openChatStream(req, activeController)
      release = opened.release
      for await (const event of opened.events) {
        handleEvent(event, turnActions, turnCounter, turnSuggestions)
        if (event.type === 'done') break
      }
      return {
        text: streamingText.value,
        actions: turnActions,
        toolsCalled: turnCounter.tools,
        suggestions: turnSuggestions.items,
      }
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'The agent stream failed. Please try again.'
      lastError.value = msg
      throw err
    } finally {
      // Actively release the underlying fetch reader so Chrome stops
      // showing the SSE request as "pending" — without this the
      // reactive flush that mounts ActionCard / ConfirmModal can stall
      // until a network-tab click nudges the browser to process the
      // connection state. `release()` aborts the in-flight fetch which
      // closes the body stream client-side; the server has already
      // ended the response by the time `done` fires, so the abort is
      // a no-op on the wire but flips Chrome's bookkeeping.
      try {
        release?.()
      } catch {
        /* noop */
      }
      isStreaming.value = false
      activeController = null
    }
  }

  function handleEvent(
    event: AgentStreamEvent,
    turnActions: ActionDescriptor[],
    turnCounter: { tools: number },
    turnSuggestions: { items: AgentSuggestionItem[] },
  ): void {
    switch (event.type) {
      case 'meta':
        // Could surface `event.model` in the UI if useful; skip for now.
        break
      case 'text':
        streamingText.value += event.delta
        break
      case 'tool_call':
        // No UI surface — the user only sees tool_result outcomes.
        break
      case 'tool_result':
        turnCounter.tools += 1
        if (event.ok && event.result && isActionDescriptor(event.result)) {
          pendingActions.value.push(event.result)
          turnActions.push(event.result)
        }
        // Failures are NOT echoed verbatim into the chat anymore —
        // the backend's agentic loop feeds the structured error back
        // to the LLM as a `functionResponse`, and the LLM synthesises
        // a polite human-readable apology in its next-turn text. The
        // raw `_(Tool X failed: ...)_` dump used to double-render the
        // same content (and leaked structured error codes like
        // INSUFFICIENT_MHUSDC into the user-facing copy). Removed
        // 2026-05-09 from operator feedback. Successful read-tool
        // results similarly surface via the synthesis text.
        break
      case 'suggestions':
        turnSuggestions.items = event.items
        break
      case 'error':
        lastError.value = event.message
        break
      case 'done':
        // Loop in `send` checks for this and exits.
        break
    }
  }

  return {
    isStreaming,
    streamingText,
    lastError,
    pendingActions,
    consumePendingAction,
    send,
    abort,
  }
}
