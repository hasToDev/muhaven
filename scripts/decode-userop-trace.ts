#!/usr/bin/env tsx
/**
 * Decoder for the `pathDBundlerTrace` field surfaced by
 * `@muhaven/mcp@0.2.8+` on Path D fallback. Paste the entire trace
 * JSON via stdin and this prints:
 *
 *   - The kernel.execute target + value + inner callData
 *   - The inner `purchase(...)` args decoded (token, encShares,
 *     maxSharesHint, ephemeralEOA)
 *   - A side-by-side check against the project's known
 *     MuHavenSubscription + MuHavenToken addresses
 *
 * Usage (PowerShell or git-bash):
 *
 *   cat trace.json | tsx scripts/decode-userop-trace.ts
 *
 * Or paste inline:
 *
 *   echo '[{"method":"zd_sponsorUserOperation", ...}]' | tsx scripts/decode-userop-trace.ts
 *
 * The trace must be the JSON array straight from the
 * `pathDBundlerTrace` field; other shapes are ignored with a clear
 * error.
 */

import { decodeFunctionData, parseAbi, type Hex } from 'viem';

const KERNEL_EXECUTE_BATCH_TYPE = '0x0100000000000000000000000000000000000000000000000000000000000000';
const KERNEL_EXECUTE_SINGLE_TYPE = '0x0000000000000000000000000000000000000000000000000000000000000000';

const KERNEL_ABI = parseAbi([
  'function execute(bytes32 execMode, bytes executionCalldata)',
]);

const PURCHASE_ABI = parseAbi([
  'function purchase(address token, (uint256 ctHash, uint8 securityZone, uint8 utype, bytes signature) encShares, uint128 maxSharesHint, address ephemeralEOA)',
]);

async function main(): Promise<void> {
  const stdinChunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    stdinChunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(stdinChunks).toString('utf8').trim();
  if (!raw) {
    console.error('No stdin. Paste the pathDBundlerTrace JSON array.');
    process.exit(2);
  }

  let trace: unknown;
  try {
    trace = JSON.parse(raw);
  } catch (err) {
    console.error('Stdin is not valid JSON:', (err as Error).message);
    process.exit(2);
  }

  if (!Array.isArray(trace)) {
    console.error('Expected a JSON array (pathDBundlerTrace), got:', typeof trace);
    process.exit(2);
  }

  const sponsorEvent = trace.find(
    (e) => typeof e === 'object' && e !== null && (e as { method?: string }).method === 'zd_sponsorUserOperation',
  ) as { requestBody?: string } | undefined;

  if (!sponsorEvent) {
    console.error('No zd_sponsorUserOperation event in trace. Methods present:');
    for (const e of trace) {
      console.error('  -', (e as { method?: string })?.method);
    }
    process.exit(1);
  }

  if (!sponsorEvent.requestBody) {
    console.error('zd_sponsorUserOperation event has no requestBody.');
    process.exit(1);
  }

  let req: { params?: [{ chainId?: number; userOp?: Record<string, string>; entryPointAddress?: string }] };
  try {
    req = JSON.parse(sponsorEvent.requestBody);
  } catch (err) {
    console.error('requestBody is not JSON:', (err as Error).message);
    process.exit(1);
  }

  const env = req.params?.[0];
  if (!env) {
    console.error('No params[0] in sponsor request.');
    process.exit(1);
  }

  console.log('==> zd_sponsorUserOperation envelope');
  console.log('    chainId:', env.chainId);
  console.log('    entryPointAddress:', env.entryPointAddress);
  console.log();

  const userOp = env.userOp ?? {};
  console.log('==> UserOp');
  console.log('    sender:           ', userOp.sender);
  console.log('    nonce:            ', userOp.nonce);
  console.log('    maxFeePerGas:     ', userOp.maxFeePerGas);
  console.log('    maxPriorityFeePerGas:', userOp.maxPriorityFeePerGas);
  console.log('    callGasLimit:     ', userOp.callGasLimit);
  console.log('    verificationGasLimit:', userOp.verificationGasLimit);
  console.log('    preVerificationGas:', userOp.preVerificationGas);
  console.log('    signature[..10]:  ', userOp.signature?.slice(0, 10), '(length:', userOp.signature?.length, ')');
  console.log();

  if (!userOp.callData || !userOp.callData.startsWith('0x')) {
    console.error('userOp.callData missing or malformed.');
    process.exit(1);
  }

  // Decode kernel.execute(bytes32 execMode, bytes executionCalldata)
  console.log('==> kernel.execute(...) decoding');
  let decoded;
  try {
    decoded = decodeFunctionData({
      abi: KERNEL_ABI,
      data: userOp.callData as Hex,
    });
  } catch (err) {
    console.error('Failed to decode kernel.execute:', (err as Error).message);
    console.error('Raw callData:', userOp.callData);
    process.exit(1);
  }

  const [execMode, executionCalldata] = decoded.args as [Hex, Hex];
  console.log('    execMode:', execMode);
  console.log('    execMode kind:',
    execMode === KERNEL_EXECUTE_SINGLE_TYPE ? 'single-call (CALLTYPE=0x00, EXECTYPE=0x00)' :
    execMode === KERNEL_EXECUTE_BATCH_TYPE  ? 'batch-call (CALLTYPE=0x01)' :
    'OTHER — examine bytes 0..3 manually'
  );
  console.log('    executionCalldata[..20]:', executionCalldata.slice(0, 42), '...');
  console.log();

  // For single-call execMode, executionCalldata = abi.encodePacked(target20, value32, callData)
  // Target = first 20 bytes; value = next 32 bytes; callData = rest
  if (execMode === KERNEL_EXECUTE_SINGLE_TYPE) {
    const targetBytes = executionCalldata.slice(2, 2 + 40); // 20 bytes
    const target = ('0x' + targetBytes) as `0x${string}`;
    const valueHex = '0x' + executionCalldata.slice(2 + 40, 2 + 40 + 64); // 32 bytes
    const innerCallData = ('0x' + executionCalldata.slice(2 + 40 + 64)) as Hex;
    console.log('==> Inner call (extracted from packed executionCalldata)');
    console.log('    target:           ', target);
    console.log('    value:            ', valueHex, `(${BigInt(valueHex)})`);
    console.log('    innerCallData[..10]:', innerCallData.slice(0, 10), '(selector)');
    console.log();

    // Try to decode as subscription.purchase
    try {
      const inner = decodeFunctionData({ abi: PURCHASE_ABI, data: innerCallData });
      console.log('==> Inner call decoded as MuHavenSubscription.purchase(...)');
      const [tokenArg, encShares, maxSharesHint, ephemeralEOA] = inner.args as [
        `0x${string}`,
        { ctHash: bigint; securityZone: number; utype: number; signature: Hex },
        bigint,
        `0x${string}`,
      ];
      console.log('    arg0 token:          ', tokenArg);
      console.log('    arg1 encShares:');
      console.log('         ctHash:         ', '0x' + encShares.ctHash.toString(16).padStart(64, '0'));
      console.log('         securityZone:   ', encShares.securityZone);
      console.log('         utype:          ', encShares.utype);
      console.log('         signature[..20]:', encShares.signature.slice(0, 42));
      console.log('    arg2 maxSharesHint:  ', maxSharesHint.toString());
      console.log('    arg3 ephemeralEOA:   ', ephemeralEOA);
      console.log();
      console.log('==> Address-vs-deployment cross-check');
      console.log(`    kernel.execute target (= MuHavenSubscription?): ${target}`);
      console.log(`    purchase.token (= MuHavenToken?):                ${tokenArg}`);
      console.log();
      console.log('    Expected from .mcp.json + deployments/arb-sepolia-v2.json:');
      console.log('      MuHavenSubscription:  0x39D49B2614d24ba189B613bEAa903d829A73eA9e');
      console.log('      MuHavenToken (CETES): 0xF3945c52DB79eBc6BFEA1dc460Ead77D70858B43');
      console.log();
      if (target.toLowerCase() === '0xf3945c52db79ebc6bfea1dc460ead77d70858b43') {
        console.log('    ⚠️  kernel.execute target = CETES MuHavenToken (NOT the subscription!) — THIS IS THE BUG');
      } else if (target.toLowerCase() === '0x39d49b2614d24ba189b613beaa903d829a73ea9e') {
        console.log('    ✓ kernel.execute target = MuHavenSubscription (correct)');
      } else {
        console.log('    ❓ kernel.execute target is neither MuHavenSubscription nor CETES — unexpected');
      }
    } catch (err) {
      console.error('Failed to decode inner call as purchase(...):', (err as Error).message);
      console.error('Inner selector:', innerCallData.slice(0, 10));
      console.error('Innercalldata:', innerCallData);
    }
  } else {
    console.log('execMode is not single-call; manual decode needed.');
  }
}

main().catch((e) => {
  console.error('Unexpected error:', e);
  process.exit(1);
});
