#!/usr/bin/env node
/* eslint-disable */
const { runMcpStdioCli } = require('../dist/index.cjs');

runMcpStdioCli().then(
  () => process.exit(0),
  (err) => {
    process.stderr.write(`fatal: ${err && err.stack ? err.stack : String(err)}\n`);
    process.exit(1);
  },
);
