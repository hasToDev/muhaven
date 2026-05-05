import { getLogger } from '../../core/logger.js';

/**
 * Resolve an issuer wallet address to a verified label (Wave 4 P5).
 *
 * Wave 4 ships a stub-friendly interface — production wires
 * `OnChainIssuerLabelResolver` against the deployed ERC-3643 +
 * ONCHAINID deployment. The hosted-checkout page renders the resolved
 * label as the "You are paying [Issuer Verified]" header — the badge
 * is what justifies the buyer trusting the URL, so the resolver MUST
 * NEVER return an issuer-supplied label as "verified". Only on-chain-
 * attested labels reach the verified slot.
 *
 * The interface returns three forms:
 *   `verified`  — pulled from a registered ONCHAINID claim, attested.
 *   `unverified` — issuer-provided label, no on-chain anchor.
 *   `null`       — no resolution available; page renders the truncated
 *                  address only.
 *
 * The use case at create-session time stamps the metadata with the
 * resolved label so a later re-resolution drift (e.g., the issuer
 * rotates their identity contract between session create + buyer
 * load) doesn't surprise the page.
 */

export interface ResolvedIssuerLabel {
  /** Short display name for the page header. */
  label: string;
  /** True iff the label is anchored to an on-chain claim. */
  verified: boolean;
}

export interface IIssuerLabelResolver {
  resolve(issuerAddress: `0x${string}`): Promise<ResolvedIssuerLabel | null>;
}

/**
 * Stub resolver — returns null for any address. Used in dev / tests
 * where the on-chain ONCHAINID deployment isn't reachable. The hosted
 * page falls back to rendering the truncated address.
 */
export class StubIssuerLabelResolver implements IIssuerLabelResolver {
  async resolve(_issuerAddress: `0x${string}`): Promise<ResolvedIssuerLabel | null> {
    return null;
  }
}

/**
 * Optional issuer-list overlay — lets the operator pin a small set of
 * known issuer addresses to plaintext labels (e.g., "MuHaven Demo
 * Treasury") for the hackathon demo without standing up the full
 * ONCHAINID stack. NOT considered "verified" — the page should render a
 * lower-confidence chip than the on-chain path.
 *
 * Production deploys should wire `OnChainIssuerLabelResolver` (Wave 5)
 * once the ERC-3643 ONCHAINID deployment is live.
 */
export class StaticIssuerLabelResolver implements IIssuerLabelResolver {
  private readonly map: Map<string, string>;

  constructor(staticMap: Record<string, string>) {
    this.map = new Map(
      Object.entries(staticMap).map(([k, v]) => [k.toLowerCase(), v]),
    );
  }

  async resolve(issuerAddress: `0x${string}`): Promise<ResolvedIssuerLabel | null> {
    const label = this.map.get(issuerAddress.toLowerCase());
    if (!label) return null;
    return { label, verified: false };
  }
}

/**
 * Compose two resolvers — try `primary` first, fall back to `fallback`.
 * Used in production: on-chain resolver primary, static map fallback for
 * known addresses while the ONCHAINID claim system is being seeded.
 */
export class ChainedIssuerLabelResolver implements IIssuerLabelResolver {
  private readonly logger = getLogger('IssuerLabelResolver');

  constructor(
    private readonly primary: IIssuerLabelResolver,
    private readonly fallback: IIssuerLabelResolver,
  ) {}

  async resolve(issuerAddress: `0x${string}`): Promise<ResolvedIssuerLabel | null> {
    try {
      const primary = await this.primary.resolve(issuerAddress);
      if (primary) return primary;
    } catch (err) {
      this.logger.warn(
        { err: (err as Error).message, issuerAddress },
        'primary issuer label resolver failed; falling back',
      );
    }
    return this.fallback.resolve(issuerAddress);
  }
}
