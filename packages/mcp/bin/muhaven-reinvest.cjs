#!/usr/bin/env node
/* eslint-disable */
const { runCli } = require('../dist/reinvest.cjs');

runCli(process.argv.slice(2)).then(
  (code) => process.exit(code ?? 0),
  (err) => {
    process.stderr.write(`fatal: ${err && err.stack ? err.stack : String(err)}\n`);
    process.exit(1);
  },
);
