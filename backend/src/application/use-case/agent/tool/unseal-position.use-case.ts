import type {
  UnsealPositionDto,
  UnsealPositionResponseDto,
} from '../../../dto/agent/tool.dto.js';

/**
 * Wave 4 P2 — `muhaven_unseal_position` (read-side, client-driven decrypt).
 *
 * Backend NEVER decrypts. The tool returns metadata describing how the
 * client should run `cofheClient.decryptForView(handle).withPermit().execute()`
 * locally. The response is intentionally minimal: handle + signer hint +
 * one human-readable instruction string.
 *
 * Privacy invariant: a malicious agent that emits `muhaven_unseal_position`
 * still cannot exfiltrate plaintext, because the user must produce the
 * permit signature on their own device, and the cleartext stays on the
 * client (never POSTed to the backend, never sent to the LLM).
 */
export class UnsealPositionToolUseCase {
  async execute(input: UnsealPositionDto): Promise<UnsealPositionResponseDto> {
    return {
      tool: 'muhaven_unseal_position',
      handle: input.handle,
      signerHint: input.signerHint,
      decryptInstruction:
        `Client-side: cofheClient.decryptForView('${input.handle}').withPermit().execute() ` +
        `using your ${input.signerHint === 'session' ? 'session-key' : 'passkey-master'} signer. ` +
        `The cleartext stays on your device — it is never sent to the agent or the backend.`,
    };
  }
}
