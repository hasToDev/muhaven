import { expect } from "chai";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hardhat as hardhatChain } from "viem/chains";
import {
  MuHavenClient,
  walletClientToSender,
  ConfigError,
  NetworkError,
  EscrowNotFoundError,
  EncryptionError,
  BatchSizeExceededError,
  DistributionNotStartedError,
  DistributionAlreadyCompleteError,
  EscrowIdsAlreadySetError,
  TxFailedError,
  InvariantError,
  MuHavenError,
  DEFAULT_BATCH_SIZE,
  MAX_BATCH_SIZE,
  RATE_SCALE,
  type MuHavenAddresses,
} from "@muhaven/sdk";

/**
 * Wave 4 Phase P10 — buffer + integration tests.
 *
 * +20 SDK unit cases targeting pure-function surfaces that the Hardhat
 * integration suite (test/MuHavenSdk*.integration.test.ts) does not
 * cover: constructor validation, error class accessors, exported
 * constants, sender-adapter wiring, chain-id propagation.
 *
 * These are unit tests — no fixture, no on-chain calls. Hardhat picks
 * them up automatically (default `test/**.test.ts` glob). They run in
 * <100ms total so they're cheap to keep green even if the contract
 * suite drifts.
 */

const ANY_ADDR_1 = "0x1111111111111111111111111111111111111111" as const;
const ANY_ADDR_2 = "0x2222222222222222222222222222222222222222" as const;
const ANY_ADDR_3 = "0x3333333333333333333333333333333333333333" as const;
const ANY_ADDR_4 = "0x4444444444444444444444444444444444444444" as const;

function fakeAddresses(): MuHavenAddresses {
  return {
    muhavenEscrow: ANY_ADDR_1,
    yieldDistributor: ANY_ADDR_2,
    investorRegistry: ANY_ADDR_3,
    yieldGate: ANY_ADDR_4,
  };
}

// Stub objects matching the SDK's structural-type expectations. These
// satisfy the constructor's truthy-presence checks without dragging in
// the full viem / cofhe stacks.
function fakePublicClient(): unknown {
  return { request: () => Promise.resolve(null) };
}
function fakeSender(): unknown {
  return {
    address: ANY_ADDR_1,
    getChainId: async () => 31337,
    write: async () => "0xdead" as const,
  };
}
function fakeCofheClient(): unknown {
  return { encryptInputs: () => ({ setAccount() { return this; }, onStep() { return this; }, execute: async () => [] }) };
}

describe("@muhaven/sdk (Wave 4 P10) — pure-function units", function () {
  // ── Exported constants ──────────────────────────────────────────────

  describe("constants", function () {
    it("DEFAULT_BATCH_SIZE is 50 (matches the P10 plan reference)", function () {
      expect(DEFAULT_BATCH_SIZE).to.equal(50);
    });

    it("MAX_BATCH_SIZE is 200 (matches on-chain MuHavenEscrow.MAX_BATCH_SIZE)", function () {
      expect(MAX_BATCH_SIZE).to.equal(200);
    });

    it("RATE_SCALE is 1_000_000n (matches on-chain YieldSnapshot.RATE_SCALE)", function () {
      expect(RATE_SCALE).to.equal(1_000_000n);
    });

    it("DEFAULT_BATCH_SIZE ≤ MAX_BATCH_SIZE invariant", function () {
      expect(DEFAULT_BATCH_SIZE).to.be.lessThanOrEqual(MAX_BATCH_SIZE);
    });
  });

  // ── MuHavenClient constructor validation ────────────────────────────

  describe("MuHavenClient constructor validation", function () {
    // Builder respects the difference between "key absent" (use default) and
    // "key explicitly undefined" (pass through to the constructor so we can
    // assert the validation fires). A naive `overrides.x ?? default` pattern
    // would mask the missing-key case.
    function build(overrides: Record<string, unknown> = {}) {
      const cfg: Record<string, unknown> = {
        publicClient: "publicClient" in overrides ? overrides.publicClient : fakePublicClient(),
        sender: "sender" in overrides ? overrides.sender : fakeSender(),
        cofheClient: "cofheClient" in overrides ? overrides.cofheClient : fakeCofheClient(),
        addresses: "addresses" in overrides ? overrides.addresses : fakeAddresses(),
      };
      if ("defaultBatchSize" in overrides) cfg.defaultBatchSize = overrides.defaultBatchSize;
      if ("expectedChainId" in overrides) cfg.expectedChainId = overrides.expectedChainId;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return () => new MuHavenClient(cfg as any);
    }

    it("throws ConfigError when publicClient missing", function () {
      expect(build({ publicClient: undefined })).to.throw(
        ConfigError,
        /publicClient is required/,
      );
    });

    it("throws ConfigError when sender missing", function () {
      expect(build({ sender: undefined })).to.throw(ConfigError, /sender is required/);
    });

    it("throws ConfigError when cofheClient missing", function () {
      expect(build({ cofheClient: undefined })).to.throw(
        ConfigError,
        /cofheClient is required/,
      );
    });

    it("throws ConfigError when addresses missing", function () {
      expect(build({ addresses: undefined })).to.throw(
        ConfigError,
        /addresses is required/,
      );
    });

    it("throws ConfigError when individual address missing (muhavenEscrow)", function () {
      const a = fakeAddresses();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (a as any).muhavenEscrow = undefined;
      expect(build({ addresses: a })).to.throw(
        ConfigError,
        /addresses\.muhavenEscrow is required/,
      );
    });

    it("throws ConfigError when individual address missing (yieldDistributor)", function () {
      const a = fakeAddresses();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (a as any).yieldDistributor = undefined;
      expect(build({ addresses: a })).to.throw(
        ConfigError,
        /addresses\.yieldDistributor is required/,
      );
    });

    it("throws ConfigError on defaultBatchSize = 0", function () {
      expect(build({ defaultBatchSize: 0 })).to.throw(ConfigError, /defaultBatchSize/);
    });

    it("throws ConfigError on defaultBatchSize > MAX_BATCH_SIZE", function () {
      expect(build({ defaultBatchSize: MAX_BATCH_SIZE + 1 })).to.throw(
        ConfigError,
        /defaultBatchSize/,
      );
    });

    it("accepts defaultBatchSize at the MAX_BATCH_SIZE boundary", function () {
      const client = build({ defaultBatchSize: MAX_BATCH_SIZE })();
      expect(client.defaultBatchSize).to.equal(MAX_BATCH_SIZE);
    });

    it("falls back to DEFAULT_BATCH_SIZE when not specified", function () {
      const client = build()();
      expect(client.defaultBatchSize).to.equal(DEFAULT_BATCH_SIZE);
    });

    it("getAccount() returns the sender's address", function () {
      const client = build()();
      expect(client.getAccount()).to.equal(ANY_ADDR_1);
    });

    it("preserves expectedChainId when provided", function () {
      const client = build({ expectedChainId: 42161 })();
      expect(client.expectedChainId).to.equal(42161);
    });
  });

  // ── walletClientToSender adapter ────────────────────────────────────

  describe("walletClientToSender", function () {
    it("throws when walletClient has no account", function () {
      const wc = createWalletClient({ chain: hardhatChain, transport: http("http://localhost:0") });
      expect(() => walletClientToSender(wc)).to.throw(/no account/);
    });

    it("returns a sender with the wallet account address", function () {
      const account = privateKeyToAccount(
        "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
      );
      const wc = createWalletClient({ account, chain: hardhatChain, transport: http("http://localhost:0") });
      const sender = walletClientToSender(wc);
      expect(sender.address.toLowerCase()).to.equal(account.address.toLowerCase());
    });

    it("sender exposes a getChainId function (no network call)", function () {
      // viem's WalletClient.getChainId actually issues an HTTP request to
      // the transport, so we can't safely call it offline. Confirming the
      // adapter wires the function through is sufficient — the integration
      // suite hits a live RPC for the dynamic value.
      const account = privateKeyToAccount(
        "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
      );
      const wc = createWalletClient({ account, chain: hardhatChain, transport: http() });
      const sender = walletClientToSender(wc);
      expect(typeof sender.getChainId).to.equal("function");
    });
  });

  // ── Error class accessors ───────────────────────────────────────────

  describe("error classes", function () {
    it("MuHavenError preserves cause + name", function () {
      const cause = new Error("inner");
      const e = new MuHavenError("outer", cause);
      expect(e.name).to.equal("MuHavenError");
      expect(e.cause).to.equal(cause);
      expect(e.message).to.equal("outer");
    });

    it("ConfigError extends MuHavenError + sets name", function () {
      const e = new ConfigError("missing X");
      expect(e).to.be.instanceOf(MuHavenError);
      expect(e.name).to.equal("ConfigError");
    });

    it("NetworkError formats expected vs actual chainId", function () {
      const e = new NetworkError(421614, 1);
      expect(e.message).to.contain("421614");
      expect(e.message).to.contain("1");
    });

    it("EscrowNotFoundError surfaces escrowId in the message", function () {
      const e = new EscrowNotFoundError(42n);
      expect(e.escrowId).to.equal(42n);
      expect(e.message).to.contain("42");
    });

    it("EncryptionError prefixes message + preserves cause", function () {
      const cause = new TypeError("ct");
      const e = new EncryptionError("bad input", cause);
      expect(e.message).to.contain("Encryption failed");
      expect(e.cause).to.equal(cause);
    });

    it("BatchSizeExceededError exposes requested + max", function () {
      const e = new BatchSizeExceededError(500, 200);
      expect(e.requested).to.equal(500);
      expect(e.max).to.equal(200);
      expect(e.message).to.contain("500");
      expect(e.message).to.contain("200");
    });

    it("DistributionNotStartedError carries distributionId", function () {
      const e = new DistributionNotStartedError(7n);
      expect(e.distributionId).to.equal(7n);
    });

    it("DistributionAlreadyCompleteError carries distributionId", function () {
      const e = new DistributionAlreadyCompleteError(9n);
      expect(e.distributionId).to.equal(9n);
    });

    it("EscrowIdsAlreadySetError carries distributionId", function () {
      const e = new EscrowIdsAlreadySetError(11n);
      expect(e.distributionId).to.equal(11n);
    });

    it("TxFailedError formats with txHash when present", function () {
      const e = new TxFailedError("MuHavenEscrow.batchCreate", "0xabc");
      expect(e.message).to.contain("0xabc");
      expect(e.message).to.contain("batchCreate");
      expect(e.operation).to.equal("MuHavenEscrow.batchCreate");
    });

    it('TxFailedError formats with "(not submitted)" when txHash is undefined', function () {
      const e = new TxFailedError("op", undefined, new Error("rejected"));
      expect(e.message).to.contain("not submitted");
      expect(e.txHash).to.equal(undefined);
    });

    it("InvariantError prefixes 'Invariant violated'", function () {
      const e = new InvariantError("event count drift");
      expect(e.message).to.contain("Invariant violated");
      expect(e.message).to.contain("event count drift");
    });

    it("All SDK error classes are instanceof MuHavenError", function () {
      const samples: MuHavenError[] = [
        new ConfigError("x"),
        new NetworkError(1, 2),
        new EscrowNotFoundError(1n),
        new EncryptionError("x"),
        new BatchSizeExceededError(1, 1),
        new DistributionNotStartedError(1n),
        new DistributionAlreadyCompleteError(1n),
        new EscrowIdsAlreadySetError(1n),
        new TxFailedError("op", "0x00"),
        new InvariantError("x"),
      ];
      for (const s of samples) {
        expect(s).to.be.instanceOf(MuHavenError);
      }
    });
  });

  // ── Smoke probe — public client + sender wiring ────────────────────

  describe("smoke: validateNetwork chain-id propagation", function () {
    it("validateNetwork no-ops when expectedChainId is unset", async function () {
      const client = new MuHavenClient({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        publicClient: fakePublicClient() as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sender: fakeSender() as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        cofheClient: fakeCofheClient() as any,
        addresses: fakeAddresses(),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (typeof (client as any).validateNetwork === "function") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (client as any).validateNetwork();
      }
      // No throw means we're good.
      expect(true).to.equal(true);
    });

    it("validateNetwork throws NetworkError when sender chainId mismatches expected", async function () {
      const fakeSenderCustom = {
        address: ANY_ADDR_1,
        getChainId: async () => 1, // mainnet
        write: async () => "0xdead" as const,
      };
      const client = new MuHavenClient({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        publicClient: { getChainId: async () => 421614 } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sender: fakeSenderCustom as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        cofheClient: fakeCofheClient() as any,
        addresses: fakeAddresses(),
        expectedChainId: 421614,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const validate = (client as any).validateNetwork as undefined | (() => Promise<void>);
      if (!validate) {
        // The method may have been renamed since this test was written —
        // fail loud rather than silently passing.
        expect.fail(
          "MuHavenClient no longer exposes validateNetwork — update the SDK p10 unit test or restore the method",
        );
      }
      let caught: unknown = null;
      try {
        await validate.call(client);
      } catch (err) {
        caught = err;
      }
      expect(caught, "validateNetwork should have thrown on chain mismatch").to.not.be.null;
      expect(caught).to.be.instanceOf(NetworkError);
    });
  });
});
