/**
 * scripts/onboard-token.ts — Wave 3.5 per-token onboarding
 *
 * Deploys a single RWA token's full per-token stack (Token + Treasury +
 * Queue), wires every cross-contract pointer, registers it in
 * `TokenRegistry`, configures the chosen oracle, publishes an initial NAV
 * (when applicable), and seeds the treasury with a starter PUSDC float.
 *
 * Designed to be re-runnable per token (TBILL1, GOLD1, …). State is
 * appended to `deployments/{network}-v2[.staging].json` under
 * `tokens[<symbol>]` so subsequent re-deploys are visible.
 *
 * Usage (example invocation):
 *   MUHAVEN_TOKEN_SYMBOL=TBILL1 \
 *   MUHAVEN_TOKEN_NAME="MuHaven Treasury Bill Series 1" \
 *   MUHAVEN_NAV_INITIAL=1000000 \
 *   MUHAVEN_TREASURY_SEED=10000000000 \
 *   MUHAVEN_CHAINLINK_CBOR=0x... \
 *   pnpm run onboard-token:testnet
 *
 * Required env (testnet):
 *   MUHAVEN_TOKEN_SYMBOL          e.g. "TBILL1"
 *   MUHAVEN_TOKEN_NAME            display name
 *
 * Optional env (with defaults):
 *   MUHAVEN_ENV                   prod | staging   (default: prod)
 *   MUHAVEN_ISSUER                issuer EOA       (default: deployer)
 *   MUHAVEN_NAV_WRITER            NAV writer hot key (default: issuer)
 *   MUHAVEN_NAV_REQUESTER         Chainlink requester (default: issuer)
 *   MUHAVEN_NAV_INITIAL           initial cleartext NAV in PUSDC base units
 *                                 per share. Required when MUHAVEN_ORACLE_KIND
 *                                 is "issuer" (default 1_000_000 = 1.00 USDC)
 *   MUHAVEN_MIN_INVESTMENT        cleartext min hint (default: 1)
 *   MUHAVEN_INSTANT_CAP           per-epoch instant-redeem cap in PUSDC base
 *                                 units (default: 100_000_000 = 100 USDC)
 *   MUHAVEN_EPOCH_DURATION        seconds (default: 86400 = 1 day)
 *   MUHAVEN_TREASURY_MIN_FLOAT    cleartext minFloat (default: 0)
 *   MUHAVEN_TREASURY_SEED         PUSDC base units to wrap + fund treasury
 *                                 (default: 0 — issuer funds out-of-band)
 *   MUHAVEN_MAX_DEVIATION_BPS     deviation gate (default: 250 = 2.5%)
 *   MUHAVEN_MAX_STALENESS         seconds (default: contract default 36h)
 *   MUHAVEN_PAUSED                start paused? (default: false)
 *   MUHAVEN_ORACLE_KIND           "issuer" | "chainlink" — picks which
 *                                 oracle is registered in TokenRegistry.
 *                                 Default "issuer". The other oracle is
 *                                 still configured for forward-compat
 *                                 (e.g. ChainlinkFunctionsOracle gets per-
 *                                 token CBOR + subscription wired even when
 *                                 IssuerControlledOracle is the active one).
 *   CHAINLINK_FUNCTIONS_SUBSCRIPTION_ID
 *                                 numeric subscription ID for Chainlink
 *                                 Functions. Required when oracle kind is
 *                                 "chainlink" or when CBOR is supplied.
 *   MUHAVEN_CHAINLINK_CBOR        hex-encoded CBOR request body for the
 *                                 Chainlink Functions DON. Required when
 *                                 the Chainlink path is configured.
 *   MUHAVEN_CHAINLINK_GAS_LIMIT   callbackGasLimit (default: 300_000)
 *
 * Steps performed:
 *   1. Deploy `MuHavenToken` proxy
 *   2. Deploy `RedemptionQueue` proxy (subscription bound at init)
 *   3. Deploy `MuHavenTreasury` proxy (token+sub+queue+pusdc+issuer)
 *   4. Wire MuHavenToken pointers (subscription, queue, yieldSnapshot,
 *      identityRegistry, modularCompliance)
 *   5. Authorize Token in InvestorRegistry
 *   6. Authorize Token + Subscription as state-hook callers in
 *      ModularCompliance (per ADR-032)
 *   7. Configure oracle: issuer NAV writer + initial NAV (issuer kind), or
 *      Chainlink CBOR + subscription + requester (chainlink kind)
 *   8. Register the token in `TokenRegistry`
 *   9. Optional: wrap deployer's legacy PUSDC into `MuHavenStable` and fund
 *      treasury with the seed amount
 *  10. Append addresses + metadata into deployments JSON
 *
 * Deployer requirements when `MUHAVEN_TREASURY_SEED > 0` (testnet):
 *   - Holds at least `MUHAVEN_TREASURY_SEED` of legacy PUSDC
 *   - Will grant `MuHavenStable` operator rights on legacy PUSDC during the
 *     wrap step (uses `setOperator(stable, type(uint48).max)`).
 */

import hre, { ethers, upgrades, network } from "hardhat";
import { writeFileSync, existsSync, readFileSync, copyFileSync, mkdirSync } from "fs";
import { join } from "path";
import { Encryptable } from "@cofhe/sdk";
import { createCofheClient } from "../tasks/utils";

type DeployEntry = {
  proxy?: string;
  implementation?: string;
  address?: string;
};

type V2Deployment = {
  network: string;
  env: string;
  timestamp: string;
  deployer: string;
  external: {
    legacyPusdc: string;
    kycAdapter: string;
    chainlinkFunctionsRouter: string;
    chainlinkFunctionsDonId: string;
    chainlinkFunctionsSubscriptionId: number | null;
  };
  contracts: Record<string, DeployEntry>;
  tokens: Record<string, TokenRecord>;
};

type TokenRecord = {
  symbol: string;
  name: string;
  issuer: string;
  oracleKind: "issuer" | "chainlink";
  registeredOracle: string;
  initialNav: string | null;
  treasurySeed: string;
  contracts: Record<string, DeployEntry>;
  chainlink?: {
    subscriptionId: number;
    callbackGasLimit: number;
    donId: string;
    cborSet: boolean;
  };
  registeredAt: string;
};

function envOrThrow(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Required env var ${name} not set`);
  return v;
}

function envOr<T extends string | bigint | number>(name: string, fallback: T): T {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  if (typeof fallback === "bigint") return BigInt(v) as T;
  if (typeof fallback === "number") return Number(v) as T;
  return v as T;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = network.name;
  const isLocal = net === "hardhat" || net === "localhost";

  const envName = (process.env.MUHAVEN_ENV || "prod").toLowerCase();
  if (envName !== "prod" && envName !== "staging") {
    throw new Error(`MUHAVEN_ENV must be 'prod' or 'staging' (got '${envName}')`);
  }
  const envSuffix = envName === "staging" ? ".staging" : "";

  const symbol = envOrThrow("MUHAVEN_TOKEN_SYMBOL");
  const tokenName = envOrThrow("MUHAVEN_TOKEN_NAME");
  const issuer = envOr("MUHAVEN_ISSUER", deployer.address);
  const navWriter = envOr("MUHAVEN_NAV_WRITER", issuer);
  const navRequester = envOr("MUHAVEN_NAV_REQUESTER", issuer);

  const minInvestment = envOr("MUHAVEN_MIN_INVESTMENT", 1n);
  const instantCap = envOr("MUHAVEN_INSTANT_CAP", 100_000_000n);
  const epochDuration = envOr("MUHAVEN_EPOCH_DURATION", 86_400);
  const treasuryMinFloat = envOr("MUHAVEN_TREASURY_MIN_FLOAT", 0n);
  const treasurySeed = envOr("MUHAVEN_TREASURY_SEED", 0n);
  const maxDeviationBps = envOr("MUHAVEN_MAX_DEVIATION_BPS", 250); // 2.5%
  const maxStaleness = envOr("MUHAVEN_MAX_STALENESS", 0n); // 0 = use contract default
  const startPaused = (process.env.MUHAVEN_PAUSED || "").toLowerCase() === "true";

  const oracleKind = (
    process.env.MUHAVEN_ORACLE_KIND || "issuer"
  ).toLowerCase() as "issuer" | "chainlink";
  if (oracleKind !== "issuer" && oracleKind !== "chainlink") {
    throw new Error(`MUHAVEN_ORACLE_KIND must be 'issuer' or 'chainlink'`);
  }

  const navInitial = envOr("MUHAVEN_NAV_INITIAL", 1_000_000n);

  // ── Load platform deployment ─────────────────────────────────────────
  const outDir = join(__dirname, "..", "deployments");
  const platformPath = join(outDir, `${net}-v2${envSuffix}.json`);
  if (!existsSync(platformPath)) {
    throw new Error(
      `Platform deployment not found at ${platformPath}. ` +
        `Run scripts/deploy-v2.ts first.`
    );
  }
  const platform: V2Deployment = JSON.parse(readFileSync(platformPath, "utf-8"));

  if (platform.tokens[symbol]) {
    throw new Error(
      `Token ${symbol} is already onboarded in ${platformPath}. ` +
        `Remove the entry manually if you intend to re-onboard.`
    );
  }

  const subscriptionAddr = platform.contracts.MuHavenSubscription?.proxy;
  const tokenRegistryAddr = platform.contracts.TokenRegistry?.proxy;
  const investorRegistryAddr = platform.contracts.InvestorRegistry?.proxy;
  const yieldSnapshotAddr = platform.contracts.YieldSnapshot?.proxy;
  const identityRegistryAddr = platform.contracts.MuHavenIdentityRegistry?.proxy;
  const modularComplianceAddr = platform.contracts.ModularCompliance?.proxy;
  const stableAddr = platform.contracts.MuHavenStable?.proxy;
  const issuerOracleAddr = platform.contracts.IssuerControlledOracle?.proxy;
  const chainlinkOracleAddr = platform.contracts.ChainlinkFunctionsOracle?.proxy;
  const kycAdapterAddr = platform.external.kycAdapter;
  const legacyPusdcAddr = platform.external.legacyPusdc;

  const required: Record<string, string | undefined> = {
    MuHavenSubscription: subscriptionAddr,
    TokenRegistry: tokenRegistryAddr,
    InvestorRegistry: investorRegistryAddr,
    YieldSnapshot: yieldSnapshotAddr,
    MuHavenIdentityRegistry: identityRegistryAddr,
    ModularCompliance: modularComplianceAddr,
    MuHavenStable: stableAddr,
    IssuerControlledOracle: issuerOracleAddr,
    ERC3643KYCAdapter: kycAdapterAddr,
    LegacyPUSDC: legacyPusdcAddr,
  };
  for (const [name, addr] of Object.entries(required)) {
    if (!addr) throw new Error(`Platform deployment missing ${name}`);
  }

  console.log(`\n=== MuHaven Wave 3.5 Token Onboarding ===`);
  console.log(`Network:       [${net}]`);
  console.log(`Env:           ${envName}`);
  console.log(`Symbol:        ${symbol}`);
  console.log(`Name:          ${tokenName}`);
  console.log(`Issuer:        ${issuer}`);
  console.log(`Oracle kind:   ${oracleKind}`);
  console.log(`Initial NAV:   ${navInitial.toString()} (PUSDC base units / share)`);
  console.log(`Treasury seed: ${treasurySeed.toString()} (legacy PUSDC base units)`);
  console.log(`Deployer:      ${deployer.address}\n`);

  const record: Record<string, DeployEntry> = {};

  async function deployProxy(
    name: string,
    factoryName: string,
    initArgs: unknown[]
  ) {
    console.log(`Deploying ${name}...`);
    const Factory = await ethers.getContractFactory(factoryName);
    const proxy = await upgrades.deployProxy(Factory, initArgs, {
      kind: "transparent",
      initializer: "initialize",
    });
    await proxy.waitForDeployment();
    const proxyAddr = await proxy.getAddress();
    const implAddr = await upgrades.erc1967.getImplementationAddress(proxyAddr);
    record[name] = { proxy: proxyAddr, implementation: implAddr };
    console.log(`   ${name} proxy: ${proxyAddr}`);
    console.log(`   ${name} impl:  ${implAddr}`);
    return proxy;
  }

  // ── 1. MuHavenToken ───────────────────────────────────────────────────
  // KYC adapter is the Wave 3 carry-over fallback; Phase 3 wiring below
  // points the token at IdentityRegistry which supersedes it.
  const token = await deployProxy("MuHavenToken", "MuHavenToken", [
    tokenName,
    symbol,
    kycAdapterAddr!,
    investorRegistryAddr!,
    issuer,
    ethers.ZeroAddress,
  ]);
  const tokenAddr = await token.getAddress();
  console.log();

  // ── 2. RedemptionQueue ────────────────────────────────────────────────
  // Subscription is bound at init so submitFor (auto-escalate) works.
  const queue = await deployProxy("RedemptionQueue", "RedemptionQueue", [
    deployer.address,
    tokenAddr,
    tokenRegistryAddr!,
    subscriptionAddr!,
    stableAddr!,
  ]);
  const queueAddr = await queue.getAddress();
  console.log();

  // ── 3. MuHavenTreasury ────────────────────────────────────────────────
  // Treasury init grants immutable PUSDC operator rights to subscription
  // + queue (ADR-002).
  const treasury = await deployProxy("MuHavenTreasury", "MuHavenTreasury", [
    tokenAddr,
    subscriptionAddr!,
    queueAddr,
    issuer,
    stableAddr!,
    treasuryMinFloat,
    deployer.address,
  ]);
  const treasuryAddr = await treasury.getAddress();
  console.log();

  // ── 4. Wire MuHavenToken pointers ─────────────────────────────────────
  console.log("Wiring MuHavenToken pointers...");
  await (await token.setSubscription(subscriptionAddr!)).wait();
  console.log("   token.setSubscription ✓");

  await (await token.setQueue(queueAddr)).wait();
  console.log("   token.setQueue ✓");

  await (await token.setYieldSnapshot(yieldSnapshotAddr!)).wait();
  console.log("   token.setYieldSnapshot ✓");

  await (await token.setIdentityRegistry(identityRegistryAddr!)).wait();
  console.log("   token.setIdentityRegistry ✓");

  await (await token.setModularCompliance(modularComplianceAddr!)).wait();
  console.log("   token.setModularCompliance ✓");

  // RedemptionQueue needs its own IdentityRegistry pointer for the KYC-
  // revocation cancellation path (`cancelOnKYCRevocation` reads
  // `identityRegistry.isVerified(investor)` directly per ADR-027).
  await (await queue.setIdentityRegistry(identityRegistryAddr!)).wait();
  console.log("   queue.setIdentityRegistry ✓");
  console.log();

  // ── 5. InvestorRegistry: authorize the Token to call addHolder ─────────
  console.log("Authorising Token in InvestorRegistry...");
  const investorRegistry = await ethers.getContractAt(
    "InvestorRegistry",
    investorRegistryAddr!
  );
  await (await investorRegistry.setAuthorizedCaller(tokenAddr, true)).wait();
  console.log("   investorRegistry.setAuthorizedCaller(token) ✓\n");

  // ── 6. ModularCompliance: authorise the Token + Subscription state hooks ──
  // Per ADR-032, only the per-token authorised callers can fire `created` /
  // `transferred` / `destroyed` so stateful modules can't be polluted.
  console.log("Authorising state-hook callers in ModularCompliance...");
  const compliance = await ethers.getContractAt(
    "ModularCompliance",
    modularComplianceAddr!
  );
  await (await compliance.setAuthorizedCaller(tokenAddr, tokenAddr, true)).wait();
  console.log("   compliance.setAuthorizedCaller(token, token) ✓");
  await (
    await compliance.setAuthorizedCaller(tokenAddr, subscriptionAddr!, true)
  ).wait();
  console.log("   compliance.setAuthorizedCaller(token, subscription) ✓");
  // RedemptionQueue fires the `destroyed` state-hook from within
  // `processEpoch._settleRequest` (Phase 7.6 atomic settlement). Without
  // this authorization, every queue settlement reverts NotAuthorizedCaller
  // (selector 0x7046c88d) — broke staging Stage E redemption claim flow
  // 2026-04-28 until backfilled. Token registration must always include
  // the queue as an authorized caller for the same reason the token + the
  // subscription are.
  await (
    await compliance.setAuthorizedCaller(tokenAddr, queueAddr, true)
  ).wait();
  console.log("   compliance.setAuthorizedCaller(token, queue) ✓\n");

  // ── 7. Oracle config ───────────────────────────────────────────────────
  let registeredOracle: string;
  let chainlinkMeta: TokenRecord["chainlink"] | undefined;
  // Safety: if we won't seed a NAV in this script (chainlink = waits for
  // DON; issuer with non-deployer navWriter = waits for issuer), force the
  // token registration to land paused so an over-eager investor can't trip
  // a purchase against `nav = 0` (which would `OracleReturnedZero`-revert
  // and emit a misleading staleness signal). Operator unpauses manually
  // once the first NAV is in.
  let effectivePaused = startPaused;

  if (oracleKind === "issuer") {
    console.log("Configuring IssuerControlledOracle for this token...");
    const oracle = await ethers.getContractAt(
      "IssuerControlledOracle",
      issuerOracleAddr!
    );

    if (maxStaleness > 0n) {
      await (await oracle.setMaxStaleness(tokenAddr, maxStaleness)).wait();
      console.log(`   oracle.setMaxStaleness(${maxStaleness}) ✓`);
    }

    await (await oracle.setNavWriter(tokenAddr, navWriter)).wait();
    console.log(`   oracle.setNavWriter(${navWriter}) ✓`);

    // Set deviation gate first so the seed write isn't subject to it (the
    // contract's first-write-bypass handles seeding either way, but this
    // keeps the deployment self-documenting).
    await (
      await oracle.setMaxDeviationBps(tokenAddr, maxDeviationBps)
    ).wait();
    console.log(`   oracle.setMaxDeviationBps(${maxDeviationBps}) ✓`);

    // Initial NAV write — must come from the navWriter EOA. When deployer
    // is the writer (default) we can publish here; otherwise we surface a
    // post-deploy todo for the issuer.
    if (navWriter.toLowerCase() === deployer.address.toLowerCase()) {
      await (await oracle.setNAV(tokenAddr, navInitial)).wait();
      console.log(`   oracle.setNAV(${navInitial}) ✓ (initial seed)`);
    } else {
      effectivePaused = true;
      console.log(
        `   ⚠ navWriter (${navWriter}) != deployer; token will be ` +
          `registered PAUSED. Issuer must call oracle.setNAV(${tokenAddr}, ` +
          `${navInitial}) and tokenRegistry.setPaused(${tokenAddr}, false) ` +
          `before purchase opens.`
      );
    }

    registeredOracle = issuerOracleAddr!;
  } else {
    // chainlink path — requires CBOR + subscription ID
    if (isLocal) {
      throw new Error(
        "MUHAVEN_ORACLE_KIND=chainlink not supported on local network"
      );
    }
    if (!chainlinkOracleAddr) {
      throw new Error(
        "ChainlinkFunctionsOracle not in platform deployment — " +
          "re-run deploy-v2.ts on testnet"
      );
    }

    const cbor = envOrThrow("MUHAVEN_CHAINLINK_CBOR");
    if (!cbor.startsWith("0x")) {
      throw new Error("MUHAVEN_CHAINLINK_CBOR must be hex-encoded (0x...)");
    }
    const subscriptionId =
      Number(process.env.CHAINLINK_FUNCTIONS_SUBSCRIPTION_ID) ||
      platform.external.chainlinkFunctionsSubscriptionId ||
      0;
    if (!subscriptionId) {
      throw new Error(
        "Chainlink subscription ID required: set CHAINLINK_FUNCTIONS_SUBSCRIPTION_ID env var " +
          "or persist it into deployments JSON via deploy-v2.ts"
      );
    }
    const callbackGasLimit = envOr("MUHAVEN_CHAINLINK_GAS_LIMIT", 300_000);
    const donId = platform.external.chainlinkFunctionsDonId;

    console.log("Configuring ChainlinkFunctionsOracle for this token...");
    const oracle = await ethers.getContractAt(
      "ChainlinkFunctionsOracle",
      chainlinkOracleAddr
    );

    if (maxStaleness > 0n) {
      await (await oracle.setMaxStaleness(tokenAddr, maxStaleness)).wait();
      console.log(`   oracle.setMaxStaleness(${maxStaleness}) ✓`);
    }

    await (
      await oracle.setMaxDeviationBps(tokenAddr, maxDeviationBps)
    ).wait();
    console.log(`   oracle.setMaxDeviationBps(${maxDeviationBps}) ✓`);

    await (
      await oracle.setTokenConfig(
        tokenAddr,
        subscriptionId,
        callbackGasLimit,
        donId,
        cbor
      )
    ).wait();
    console.log(
      `   oracle.setTokenConfig(sub=${subscriptionId}, gas=${callbackGasLimit}) ✓`
    );

    await (await oracle.setNavRequester(tokenAddr, navRequester)).wait();
    console.log(`   oracle.setNavRequester(${navRequester}) ✓`);

    effectivePaused = true;
    console.log(
      `   ⚠ Initial NAV will be 0 until first DON fulfillment. Token will ` +
        `be registered PAUSED. After triggering oracle.requestNAV(${tokenAddr}) ` +
        `(owner or navRequester) and confirming the fulfillment lands, run ` +
        `tokenRegistry.setPaused(${tokenAddr}, false) to open purchases.`
    );

    registeredOracle = chainlinkOracleAddr;
    chainlinkMeta = {
      subscriptionId,
      callbackGasLimit,
      donId,
      cborSet: true,
    };
  }
  console.log();

  // ── 8. Register the token in TokenRegistry ─────────────────────────────
  console.log("Registering token in TokenRegistry...");
  const tokenRegistry = await ethers.getContractAt(
    "TokenRegistry",
    tokenRegistryAddr!
  );
  await (
    await tokenRegistry.registerToken(tokenAddr, {
      active: true,
      treasury: treasuryAddr,
      queue: queueAddr,
      oracle: registeredOracle,
      issuer,
      minInvestment,
      instantRedeemCap: instantCap,
      epochDuration,
      paused: effectivePaused,
    })
  ).wait();
  console.log(`   tokenRegistry.registerToken(${symbol}) ✓\n`);

  // ── 9. Optional treasury seed (wrap PUSDC → mhUSDC → transfer in) ─────
  if (treasurySeed > 0n) {
    if (isLocal) {
      console.log(
        `Skipping treasury seed on local network (no real PUSDC float)\n`
      );
    } else {
      console.log(
        `Seeding treasury with ${treasurySeed.toString()} legacy PUSDC base units...`
      );
      // Step 1: grant MuHavenStable operator rights on legacy PUSDC so it
      // can pull during `wrap`.
      const legacyPusdc = await ethers.getContractAt(
        "IFHERC20",
        legacyPusdcAddr
      );
      console.log("   legacyPusdc.setOperator(MuHavenStable) ...");
      await (
        await legacyPusdc.setOperator(stableAddr!, 281474976710655n) // type(uint48).max
      ).wait();

      // Step 2: encrypt the wrap amount + call wrap on the wrapper. The
      // deployer ends up holding mhUSDC.
      const cofheClient = await createCofheClient(hre, deployer);
      const [encWrap] = await cofheClient
        .encryptInputs([Encryptable.uint64(treasurySeed)])
        .execute();

      const stable = await ethers.getContractAt("MuHavenStable", stableAddr!);
      // ephemeralEOA = deployer.address (it's the only key the deployer has;
      // grants cancel out post-transfer when the deployer's mhUSDC balance
      // hits zero on the next step).
      console.log("   stable.wrap(treasurySeed) ...");
      await (await stable.wrap(encWrap, deployer.address)).wait();

      // Step 3: transfer mhUSDC to the treasury via the wrapper's modern
      // surface. Treasury issuer must trigger the deposit() event later if
      // it wants the analytics marker (deposit() is a pure event marker per
      // ADR-002, it doesn't actually move funds).
      const [encXfer] = await cofheClient
        .encryptInputs([Encryptable.uint64(treasurySeed)])
        .execute();
      console.log("   stable.transfer(treasury, treasurySeed) ...");
      // Disambiguate the modern-surface InEuint64 overload — MuHavenStable
      // also exposes a `transfer(address,euint64,address)` form.
      const transferFn = stable.getFunction(
        "transfer(address,(uint256,uint8,uint8,bytes),address)"
      );
      await (await transferFn(treasuryAddr, encXfer, deployer.address)).wait();
      console.log("   treasury seeded ✓\n");
    }
  }

  // ── 10. Persist + summarise ────────────────────────────────────────────
  const tokenRecord: TokenRecord = {
    symbol,
    name: tokenName,
    issuer,
    oracleKind,
    registeredOracle,
    initialNav: oracleKind === "issuer" ? navInitial.toString() : null,
    treasurySeed: treasurySeed.toString(),
    contracts: record,
    chainlink: chainlinkMeta,
    registeredAt: new Date().toISOString(),
  };

  // Archive previous deployment file before overwrite.
  const historyDir = join(outDir, "history");
  mkdirSync(historyDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  copyFileSync(
    platformPath,
    join(historyDir, `${net}-v2${envSuffix}.${ts}.json`)
  );

  platform.tokens[symbol] = tokenRecord;
  platform.timestamp = new Date().toISOString();
  writeFileSync(platformPath, JSON.stringify(platform, null, 2));

  console.log("=== Onboarding Summary ===");
  console.log(`Token symbol:     ${symbol}`);
  console.log(`Token proxy:      ${tokenAddr}`);
  console.log(`Treasury proxy:   ${treasuryAddr}`);
  console.log(`Queue proxy:      ${queueAddr}`);
  console.log(`Active oracle:    ${registeredOracle} (${oracleKind})`);
  console.log(`\nDeployments updated → deployments/${net}-v2${envSuffix}.json`);

  if (!isLocal) {
    console.log("\nNext steps:");
    console.log(`  1. Verify implementation contracts on Arbiscan:`);
    for (const [name, entry] of Object.entries(record)) {
      if (entry.implementation) {
        console.log(
          `       npx hardhat verify --network arb-sepolia ${entry.implementation}`
        );
      }
    }
    if (oracleKind === "chainlink") {
      console.log(
        `  2. Trigger first NAV request: ChainlinkFunctionsOracle.requestNAV(${tokenAddr})`
      );
      console.log(
        `     (deployer or navRequester signs; DON fulfilment lands within ~30-60s)`
      );
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
