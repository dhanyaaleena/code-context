#!/usr/bin/env node
/**
 * Restore the demo repository from fixtures/sample.bundle.
 *
 * The sample needs real Git history — symbol-scoped log, an introducing
 * commit, an AI-assisted change — and a repository can't be committed inside
 * another one. So its history travels as a single bundle file and is unpacked
 * here, on `npm install` or `npm run sample`. An existing sample/ is left alone.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const bundle = path.join(root, 'fixtures', 'sample.bundle');
const target = path.join(root, 'sample');

if (fs.existsSync(path.join(target, '.git'))) {
  console.log('sample/ already present — leaving it as is.');
  process.exit(0);
}
if (!fs.existsSync(bundle)) {
  console.warn('fixtures/sample.bundle not found — skipping the sample repository.');
  process.exit(0);
}
try {
  execFileSync('git', ['clone', '--quiet', bundle, target], { stdio: 'inherit' });
  console.log('sample/ restored from fixtures/sample.bundle.');
} catch {
  // Never fail an install over the demo fixture.
  console.warn('Could not restore sample/ (is git installed?). The extension itself is unaffected.');
}
