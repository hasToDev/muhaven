import type { Address } from 'viem';
import { Tier } from '../../../../domain/agent/model/tier.enum.js';
import type { ActionId } from '../../../../domain/agent/model/action-id.enum.js';
import {
  buildPermissionTemplate,
  serializeTemplate,
  type PermissionTemplate,
  type MuHavenContractAddresses,
} from '../../../../infrastructure/agent/permission-template.builder.js';
import { getEnv } from '../../../../core/config.js';

export interface BuildTemplateInput {
  tier: Tier;
  actions: readonly ActionId[];
  ttlSec?: number;
  now?: Date;
}

/**
 * Resolves the deployed-contract surface from env and produces a
 * permission template the frontend can install via `@zerodev/permissions`.
 * Backed by `permission-template.builder.ts` — this use case is the
 * env-glue thin wrapper.
 */
export class BuildPermissionTemplateUseCase {
  execute(input: BuildTemplateInput): PermissionTemplate {
    const env = getEnv();
    const contracts: MuHavenContractAddresses = {
      muhavenToken: optAddr(env.MUHAVEN_TOKEN_ADDRESS),
      vault: optAddr(env.MUHAVEN_VAULT_ADDRESS),
      yieldDistributor: optAddr(env.YIELD_DISTRIBUTOR_ADDRESS),
      subscription: optAddr(env.SUBSCRIPTION_ADDRESS),
      riskParams: optAddr(env.RISK_PARAMS_ADDRESS),
    };
    return buildPermissionTemplate({
      tier: input.tier,
      actions: input.actions,
      contracts,
      ttlSec: input.ttlSec,
      now: input.now,
    });
  }

  serialize(template: PermissionTemplate): unknown {
    return serializeTemplate(template);
  }
}

function optAddr(raw: string | undefined): Address | undefined {
  if (!raw) return undefined;
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) return undefined;
  return raw as Address;
}
