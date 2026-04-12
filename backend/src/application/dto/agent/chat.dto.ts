import { z } from 'zod';

const HistoryMessageSchema = z.object({
  role: z.enum(['user', 'agent']),
  text: z.string(),
});

export const AgentChatDtoSchema = z.object({
  message: z.string().min(1).max(4000),
  history: z.array(HistoryMessageSchema).max(20).optional(),
  stream: z.boolean().optional(), // Accepted but ignored in stub
});

export type AgentChatDto = z.infer<typeof AgentChatDtoSchema>;

export type CardType = 'action' | 'data' | 'form' | 'status' | 'insight';

export interface AgentChatResponseDto {
  response: {
    text: string;
    card_type?: CardType;
    card_data?: Record<string, unknown>;
  };
}
