#!/usr/bin/env node
/* npm postinstall hook - initialize directories/config/database quietly.
 * Never fails the install: any error is non-fatal here. */
'use strict';
const path = require('path');
try {
  const entry = path.join(__dirname, '..', 'bin', 'cloud-wa.js');
  require('child_process').execFileSync(process.execPath, [entry, 'init', '--quiet'], {
    stdio: 'ignore',
    timeout: 60000,
  });
} catch (_) {
  /* non-fatal: `cloud-wa init` can be run manually later */
}
process.exit(0);
