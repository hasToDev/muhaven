/**
 * CI / pre-build script: regenerate `tool-hashes.json` from the live
 * `TOOL_DESCRIPTORS` and either write it (default) or assert it matches
 * the on-disk version (`--check` mode).
 *
 * Wire `--check` into CI: a PR that mutates a tool description without
 * regenerating hashes fails the build, surfacing the change in review.
 */

import { writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { TOOL_DESCRIPTORS, hashToolDescriptor } from '../src/tools/descriptions.js';

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, '..', 'tool-hashes.json');

async function main(): Promise<number> {
  const checkMode = process.argv.includes('--check');
  const tools = TOOL_DESCRIPTORS.map((d) => ({
    name: d.name,
    sha256: hashToolDescriptor(d),
  }));
  const payload = { generatedAt: new Date().toISOString(), tools };
  const next = JSON.stringify(payload, null, 2) + '\n';

  if (checkMode) {
    let current: string;
    try {
      current = await readFile(target, 'utf8');
    } catch {
      process.stderr.write(`tool-hashes.json missing — run \`pnpm verify-tool-hashes\` to generate.\n`);
      return 1;
    }
    // Compare hash maps only (ignore generatedAt drift).
    const a = JSON.parse(current) as { tools?: { name: string; sha256: string }[] };
    if (!a.tools || a.tools.length !== tools.length) {
      process.stderr.write(`tool-hashes.json out of date.\n`);
      return 1;
    }
    const aMap = new Map(a.tools.map((t) => [t.name, t.sha256]));
    for (const t of tools) {
      if (aMap.get(t.name) !== t.sha256) {
        process.stderr.write(`drift on ${t.name}: pinned=${aMap.get(t.name)} live=${t.sha256}\n`);
        return 1;
      }
    }
    process.stdout.write('tool-hashes.json up to date ✓\n');
    return 0;
  }

  await writeFile(target, next);
  process.stdout.write(`wrote ${target} (${tools.length} tools)\n`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`fatal: ${err && err.stack ? err.stack : String(err)}\n`);
    process.exit(1);
  },
);
