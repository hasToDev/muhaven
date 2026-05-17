#!/usr/bin/env node
/* eslint-disable */
//
// `muhaven-mcp` bin entrypoint.
//
// Production: MCPB hosts (Claude Desktop / Cursor / Claude Code) spawn this
// binary over STDIO and immediately start a JSON-RPC handshake. The host
// never passes argv flags — but operators occasionally run `muhaven-mcp
// --version` / `--help` from the shell to sanity-check the install. Those
// flags short-circuit BEFORE we wire up the STDIO transport so they exit
// cleanly without spinning up the broker IPC + tool registry.
//
// Keep this shim tiny — the production path is `runMcpStdioCli()` from the
// bundled dist. Anything richer goes in src/ where it's testable.
//

const args = process.argv.slice(2);

if (args.includes('--version') || args.includes('-v')) {
  const pkg = require('../package.json');
  process.stdout.write(`muhaven-mcp ${pkg.version}\n`);
  process.exit(0);
}

if (args.includes('--help') || args.includes('-h')) {
  const pkg = require('../package.json');
  process.stdout.write(
    [
      `muhaven-mcp ${pkg.version} — MuHaven MCP STDIO server`,
      ``,
      `Usage:`,
      `  muhaven-mcp                        Run the MCP server over STDIO`,
      `                                     (called by Claude Desktop / Cursor /`,
      `                                     Claude Code — not directly by humans)`,
      `  muhaven-mcp --version | -v         Print the @muhaven/mcp package version`,
      `  muhaven-mcp --help    | -h         Show this help`,
      ``,
      `For first-time setup, run:   muhaven-broker setup`,
      `For troubleshooting, run:    muhaven-broker doctor`,
      ``,
      `Docs: https://github.com/hasToDev/muhaven/blob/master/packages/mcp/README.md`,
      ``,
    ].join('\n'),
  );
  process.exit(0);
}

const { runMcpStdioCli } = require('../dist/index.cjs');

runMcpStdioCli().then(
  () => process.exit(0),
  (err) => {
    process.stderr.write(`fatal: ${err && err.stack ? err.stack : String(err)}\n`);
    process.exit(1);
  },
);
