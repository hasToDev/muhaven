/**
 * Wave 4 P8 — Lethal-trifecta CI lint.
 *
 * Willison's lethal trifecta = a single agent / MCP / skill process that
 * combines all three of:
 *
 *   (a) Untrusted external input  — chat, web fetch, third-party API
 *   (b) Signing capability        — kernel session key, plain ECDSA, EIP-712
 *   (c) Filesystem / network egress — `fs.write`, raw HTTP fetch
 *
 * If a process holds all three, an attacker who slips an instruction into
 * (a) can use (b) to sign and (c) to exfiltrate. The Wave 4 design pre-
 * commits to never co-bundling them. This lint is the watchdog that the
 * design stays honored as the codebase grows.
 *
 * The script scans the per-surface manifests + their primary entrypoints
 * and tallies the three primitives. If any single surface scores all three
 * we exit with code 70 (`EX_CONFIG`) and print the offending lines.
 *
 * Usage:
 *   pnpm tsx scripts/lethal-trifecta-lint.ts          # report only
 *   pnpm tsx scripts/lethal-trifecta-lint.ts --strict # exit 70 on violation
 *
 * Wired in CI by the workflow that runs `pnpm test` (P10 will gate the
 * `develop` merge on the strict run).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface SurfaceSpec {
  name: string;
  files: string[];
  /**
   * Documented exception — for surfaces that legitimately need network +
   * fs (e.g., `backend/` itself does heavy lifting). Lint focuses on the
   * AGENT-FACING surfaces; we never want HavenBot SSE handler / MCP entry /
   * OpenClaw skill to hold all three primitives.
   */
  agentFacing: boolean;
}

const SURFACES: SurfaceSpec[] = [
  {
    name: 'havenbot.chat-stream',
    files: [
      'backend/api/v1/agent/chat/stream.ts',
      'backend/src/infrastructure/agent/chat-llm.service.ts',
      'backend/src/infrastructure/agent/tool-dispatcher.ts',
    ],
    agentFacing: true,
  },
  {
    name: 'mcp.server',
    files: [
      'packages/mcp/src/server.ts',
      'packages/mcp/src/index.ts',
    ],
    agentFacing: true,
  },
  {
    name: 'mcp.broker-daemon',
    files: [
      'packages/mcp/src/broker/daemon.ts',
    ],
    agentFacing: true,
  },
  {
    name: 'openclaw.skill',
    files: [
      'packages/openclaw-skill/src/index.ts',
    ],
    agentFacing: true,
  },
  {
    name: 'policy-engine.cron',
    files: [
      'backend/src/infrastructure/agent/policy-engine-cron.ts',
      'backend/src/application/use-case/agent/policy/policy-engine-tick.use-case.ts',
      'backend/src/infrastructure/agent/on-chain-risk-params.adapter.ts',
      'backend/src/infrastructure/agent/risk-params.adapter.ts',
    ],
    agentFacing: true,
  },
];

interface PrimitiveMatch {
  primitive: 'untrusted_input' | 'signing' | 'egress';
  file: string;
  line: number;
  excerpt: string;
}

const PATTERNS: Record<PrimitiveMatch['primitive'], RegExp[]> = {
  untrusted_input: [
    /streamChat\s*\(/,
    /generateContentStream\s*\(/,
    /req\.body\b/,
    /readFromStdin/,
    /\bonMessage\s*\(/,
    /chat-stream/,
    /AgentChatStreamDtoSchema/,
  ],
  signing: [
    /\bsignMessage\s*\(/,
    /\bsignTypedData\s*\(/,
    /\bsignTransaction\s*\(/,
    /privateKeyToAccount/,
    /sign_hash\b/,
    /\bWebAuthn\b/,
    /\bcreateUserOp\s*\(/,
    /\bsendUserOperation\s*\(/,
  ],
  egress: [
    /\bfetch\s*\(/,
    /\bgot\s*\(/,
    /\baxios\b/,
    /\bhttps?\s*\.\s*request\s*\(/,
    /\bnet\s*\.\s*createConnection\s*\(/,
    /createPublicClient\s*\(/,
    /\bcreateWalletClient\s*\(/,
    /viem.*publicClient/,
    /writeFileSync\s*\(/,
    /\.appendFileSync\s*\(/,
    /\.unlinkSync\s*\(/,
  ],
};

/**
 * False-positive damping — a surface that *imports* a primitive but never
 * actually invokes it isn't a trifecta vector. Comments + import lines are
 * stripped before the regexes fire.
 */
function strip(line: string): string {
  // Drop // comments
  const dropComment = line.replace(/\/\/.*$/u, '');
  return dropComment;
}

function scanFile(file: string): PrimitiveMatch[] {
  const path = resolve(process.cwd(), file);
  let body = '';
  try {
    body = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const matches: PrimitiveMatch[] = [];
  body.split('\n').forEach((rawLine, idx) => {
    const line = strip(rawLine);
    if (!line.trim()) return;
    if (line.trim().startsWith('import ')) return;
    if (line.trim().startsWith('* ') || line.trim().startsWith('/*')) return;
    for (const [primitive, patterns] of Object.entries(PATTERNS) as [
      PrimitiveMatch['primitive'],
      RegExp[],
    ][]) {
      for (const re of patterns) {
        if (re.test(line)) {
          matches.push({
            primitive,
            file,
            line: idx + 1,
            excerpt: line.trim().slice(0, 120),
          });
        }
      }
    }
  });
  return matches;
}

function collapse(perFile: PrimitiveMatch[][]): {
  hasUntrusted: boolean;
  hasSigning: boolean;
  hasEgress: boolean;
  matches: PrimitiveMatch[];
} {
  const all = perFile.flat();
  return {
    hasUntrusted: all.some((m) => m.primitive === 'untrusted_input'),
    hasSigning: all.some((m) => m.primitive === 'signing'),
    hasEgress: all.some((m) => m.primitive === 'egress'),
    matches: all,
  };
}

function main(): void {
  const strict = process.argv.includes('--strict');

  let violations = 0;
  for (const surface of SURFACES) {
    const perFile = surface.files.map(scanFile);
    const { hasUntrusted, hasSigning, hasEgress, matches } = collapse(perFile);
    const primitives = [
      hasUntrusted ? 'untrusted_input' : null,
      hasSigning ? 'signing' : null,
      hasEgress ? 'egress' : null,
    ].filter(Boolean);

    const isTrifecta = hasUntrusted && hasSigning && hasEgress;
    const banner = isTrifecta ? 'TRIFECTA' : 'OK';
    console.log(`[${banner}] ${surface.name}: ${primitives.join(' + ') || '(none)'}`);

    if (isTrifecta && surface.agentFacing) {
      violations += 1;
      console.error(
        `\n  VIOLATION: ${surface.name} co-bundles untrusted_input + signing + egress. `
        + 'See `safety/lethal-trifecta.md` for the design contract.\n',
      );
      for (const m of matches) {
        console.error(`    ${m.primitive.padEnd(16)} ${m.file}:${m.line}  ${m.excerpt}`);
      }
      console.error('');
    }
  }

  if (violations > 0) {
    console.error(`\n${violations} surface(s) violated the lethal-trifecta invariant.`);
    if (strict) {
      // EX_CONFIG (sysexits.h) — same exit shape used by `verify-tool-hashes`.
      process.exit(70);
    }
  } else {
    console.log('\nLethal-trifecta lint: clean.');
  }
}

main();
