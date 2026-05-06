import { z } from 'zod';

/**
 * Wave 4 Phase P2 — streaming chat input.
 *
 * SSE response wire format (one JSON object per `data:` line):
 *   { type: 'meta', model: 'gemini-1.5-flash' | 'stub', sessionId: string }
 *   { type: 'text', delta: string }
 *   { type: 'tool_call', toolCallId, toolName, args: object }
 *   { type: 'tool_result', toolCallId, ok, action?: ActionDescriptor, error?: string }
 *   { type: 'done', finishReason: 'stop' | 'tool_loop_exhausted' | 'error' }
 *   { type: 'error', message: string }
 *
 * The frontend `useAgentChat` composable parses each event and routes:
 *   - `text` → push delta into the current agent bubble
 *   - `tool_result.action` → mount `<ConfirmModal :action="…" />`
 *   - `done` → close the SSE stream
 *   - `error` → surface error toast + close
 */

const HistoryMessageSchema = z
  .object({
    role: z.enum(['user', 'agent']),
    text: z.string().max(8000),
  })
  .strict();

export const AgentChatStreamDtoSchema = z
  .object({
    message: z.string().min(1).max(4000),
    history: z.array(HistoryMessageSchema).max(20).optional(),
  })
  .strict();

export type AgentChatStreamDto = z.infer<typeof AgentChatStreamDtoSchema>;

export type StreamEvent =
  | { type: 'meta'; model: string; sessionId: string }
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | {
      type: 'tool_result';
      toolCallId: string;
      toolName: string;
      ok: boolean;
      result?: unknown;
      error?: string;
    }
  | { type: 'done'; finishReason: 'stop' | 'tool_loop_exhausted' | 'error' }
  | { type: 'error'; message: string };
