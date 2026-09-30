#!/usr/bin/env node
'use strict';
/* CLOUD WA TOOLS - main executable entry */
require('../src/cli/main.js').main().catch((err) => {
  console.error('[cloud-wa] Fatal:', err && err.message ? err.message : err);
  process.exit(1);
});
