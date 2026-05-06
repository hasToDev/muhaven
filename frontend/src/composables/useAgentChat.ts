import { ref, type Ref } from 'vue'
import {
  agentToolsApi,
  type ActionDescriptor,
  type AgentStreamEvent,
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
  send: (req: AgentChatStreamRequest) => Promise<{ text: string; actions: ActionDescriptor[] }>
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
  ): Promise<{ text: string; actions: ActionDescriptor[] }> {
    abort()
    activeController = new AbortController()
    streamingText.value = ''
    lastError.value = null
    isStreaming.value = true

    const turnActions: ActionDescriptor[] = []

    try {
      const { events } = await agentToolsApi.openChatStream(req, activeController)
      for await (const event of events) {
        handleEvent(event, turnActions)
        if (event.type === 'done') break
      }
      return { text: streamingText.value, actions: turnActions }
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'The agent stream failed. Please try again.'
      lastError.value = msg
      throw err
    } finally {
      isStreaming.value = false
      activeController = null
    }
  }

  function handleEvent(event: AgentStreamEvent, turnActions: ActionDescriptor[]): void {
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
        if (event.ok && event.result && isActionDescriptor(event.result)) {
          pendingActions.value.push(event.result)
          turnActions.push(event.result)
        } else if (!event.ok && event.error) {
          // Append a user-visible note so the chat reflects the failure.
          const note = `\n\n_(Tool ${event.toolName} failed: ${event.error})_`
          streamingText.value += note
        }
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
