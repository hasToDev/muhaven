import {
  createPublicClient,
  http,
  type Address,
  type PublicClient,
} from 'viem';
import { arbitrumSepolia } from 'viem/chains';
import type {
  ExplainKycAttestationDto,
  ExplainKycAttestationResponseDto,
} from '../../../dto/agent/p11-tool.dto.js';
import { ApplicationHttpError } from '../../../../core/errors.js';

/**
 * Wave 4 P11 — `muhaven_explain_kyc_attestation`.
 *
 * Read-only informational tool. Pulls public configuration from
 * `KYCAttestationRegistry` and packages a static-narrative response
 * the LLM can read back to the user without needing to know the EIP-712
 * mechanics.
 *
 * Falls back gracefully when KYC_ATTESTATION_REGISTRY_ADDRESS is unset
 * (Wave 4 close state) — returns `status: 'not_deployed'` plus the
 * static narrative so the LLM still has substance to respond with.
 */

const KYC_REGISTRY_VIEW_ABI = [
  {
    name: 'attestationSigner',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    name: 'defaultValidityPeriod',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'jurisdictionHashes',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'investor', type: 'address' }],
    outputs: [{ type: 'bytes32' }],
  },
] as const;

const STATIC_NARRATIVE =
  'MuHaven attests KYC state on a source chain (KYCAttestationRegistry) and verifies it on a destination chain ' +
  '(MuHavenKYCVerifier) via EIP-712 signatures. Each attestation carries a strictly-monotonic nonce so a stale ' +
  'attestation cannot be re-submitted after revocation. Jurisdiction is captured as a keccak256 hash (e.g. of "US" or "EU") ' +
  'so the destination chain can apply jurisdiction-specific rules without exposing the raw label on-chain.';

const ZERO_BYTES32 =
  '0x0000000000000000000000000000000000000000000000000000000000000000';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export interface ExplainKycAttestationDeps {
  rpcUrl?: string;
  kycAttestationRegistryAddress?: string;
  publicClientFactory?: (rpcUrl: string) => PublicClient;
}

export class ExplainKycAttestationToolUseCase {
  constructor(private readonly deps: ExplainKycAttestationDeps) {}

  async execute(
    callerWallet: string,
    input: ExplainKycAttestationDto,
  ): Promise<ExplainKycAttestationResponseDto> {
    const targetInvestor = (input.investorAddress ?? callerWallet).toLowerCase();

    if (!this.deps.kycAttestationRegistryAddress) {
      return {
        tool: 'muhaven_explain_kyc_attestation',
        status: 'not_deployed',
        investorAddress: targetInvestor,
        jurisdictionHash: null,
        defaultValidityPeriodSec: null,
        attestationSigner: null,
        narrative: STATIC_NARRATIVE,
      };
    }

    if (!this.deps.rpcUrl) {
      throw ApplicationHttpError.serviceUnavailable(
        'P11_RPC_NOT_CONFIGURED: KYC_ATTESTATION_REGISTRY_ADDRESS set without RPC_URL',
      );
    }

    const client =
      this.deps.publicClientFactory?.(this.deps.rpcUrl) ??
      createPublicClient({ chain: arbitrumSepolia, transport: http(this.deps.rpcUrl) });
    const address = this.deps.kycAttestationRegistryAddress as Address;

    const [signerRaw, validityRaw, jurisdictionRaw] = await Promise.all([
      client.readContract({
        abi: KYC_REGISTRY_VIEW_ABI,
        address,
        functionName: 'attestationSigner',
      }),
      client.readContract({
        abi: KYC_REGISTRY_VIEW_ABI,
        address,
        functionName: 'defaultValidityPeriod',
      }),
      client.readContract({
        abi: KYC_REGISTRY_VIEW_ABI,
        address,
        functionName: 'jurisdictionHashes',
        args: [targetInvestor as Address],
      }),
    ]);

    const signer = (signerRaw as string).toLowerCase();
    const jurisdiction = (jurisdictionRaw as string).toLowerCase();

    return {
      tool: 'muhaven_explain_kyc_attestation',
      status: 'live',
      investorAddress: targetInvestor,
      jurisdictionHash: jurisdiction === ZERO_BYTES32 ? null : jurisdiction,
      defaultValidityPeriodSec: Number(validityRaw as bigint),
      attestationSigner: signer === ZERO_ADDRESS ? null : signer,
      narrative: STATIC_NARRATIVE,
    };
  }
}

export { STATIC_NARRATIVE };
