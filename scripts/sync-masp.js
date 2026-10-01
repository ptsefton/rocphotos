#!/usr/bin/env node
/**
 * Refreshes vendor/masp/ from a local checkout of the MASP repository
 * (https://github.com/Language-Research-Technology/ro-crate-maps).
 *
 * rocphotos keeps its own copy of the validator and of the rocphotos
 * profile crate rather than reading them out of a sibling checkout, so
 * that editing the profile over there cannot change what this app
 * enforces until someone runs this script and looks at the diff. The
 * copies are byte-for-byte: nothing here rewrites, minifies or
 * transforms them, so `git diff vendor/masp/` after a sync shows exactly
 * what changed upstream and nothing else. That also keeps the door open
 * to dropping the vendored validator for a published package later —
 * see vendor/masp/README.md.
 *
 * Usage:
 *   npm run sync:masp                       # the default sibling checkout
 *   npm run sync:masp -- --from /path/to/ro-crate-masp
 *   ROCPHOTOS_MASP_DIR=/path/to/ro-crate-masp npm run sync:masp
 *   npm run sync:masp -- --check            # exit 1 if vendor/ is out of date
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VENDOR_DIR = path.join(REPO_DIR, 'vendor', 'masp');
const DEFAULT_SOURCE = path.resolve(REPO_DIR, '..', '..', 'language-research-technology', 'masp', 'ro-crate-masp');

// Source path within the MASP checkout -> name it takes in vendor/masp/.
// The validator keeps its CommonJS `.cjs` extension because it is copied
// verbatim: Node's ESM loader and Vite both import it as-is that way,
// where a `.js` CommonJS file inside this ESM package would not load.
const FILES = [
  ['lib/masp-validator.js', 'masp-validator.cjs'],
  ['profiles/rocphotos/profile-crate/ro-crate-metadata.json', 'rocphotos-profile.json'],
];

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function gitProvenance(sourceDir) {
  const git = (...args) => execFileSync('git', ['-C', sourceDir, ...args], { encoding: 'utf8' }).trim();
  try {
    return {
      commit: git('rev-parse', 'HEAD'),
      // A sync from a checkout with uncommitted work is the normal case
      // while a profile is still being drafted, so it is recorded rather
      // than refused — but it is recorded, because the commit alone then
      // does not identify what was copied.
      dirty: git('status', '--porcelain').length > 0,
      remote: git('remote', 'get-url', 'origin'),
    };
  } catch {
    return { commit: null, dirty: null, remote: null };
  }
}

function parseArgs(argv) {
  const args = { from: process.env.ROCPHOTOS_MASP_DIR || DEFAULT_SOURCE, check: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--check') args.check = true;
    else if (argv[i] === '--from') args.from = argv[++i];
    else if (argv[i].startsWith('--from=')) args.from = argv[i].slice('--from='.length);
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

function main() {
  const { from, check } = parseArgs(process.argv.slice(2));
  const sourceDir = path.resolve(from);
  if (!fs.existsSync(sourceDir)) {
    console.error(`No MASP checkout at ${sourceDir}.`);
    console.error('Pass --from <path>, or set ROCPHOTOS_MASP_DIR.');
    process.exit(1);
  }

  const copied = [];
  let changed = false;
  for (const [sourceRelPath, vendorName] of FILES) {
    const sourcePath = path.join(sourceDir, sourceRelPath);
    if (!fs.existsSync(sourcePath)) {
      console.error(`Missing from the MASP checkout: ${sourceRelPath}`);
      process.exit(1);
    }
    const bytes = fs.readFileSync(sourcePath);
    const vendorPath = path.join(VENDOR_DIR, vendorName);
    const existing = fs.existsSync(vendorPath) ? fs.readFileSync(vendorPath) : null;
    if (!existing || !existing.equals(bytes)) {
      changed = true;
      if (!check) {
        fs.mkdirSync(VENDOR_DIR, { recursive: true });
        fs.writeFileSync(vendorPath, bytes);
      }
    }
    copied.push({ from: sourceRelPath, file: vendorName, bytes: bytes.length, sha256: sha256(bytes) });
    console.log(`${changed && !check ? 'wrote' : 'checked'} vendor/masp/${vendorName}  (${bytes.length} bytes)`);
  }

  if (check) {
    console.log(changed ? 'vendor/masp/ is OUT OF DATE' : 'vendor/masp/ matches the checkout');
    process.exit(changed ? 1 : 0);
  }

  const source = gitProvenance(sourceDir);
  fs.writeFileSync(
    path.join(VENDOR_DIR, 'SOURCE.json'),
    `${JSON.stringify({ source: { dir: sourceDir, ...source }, syncedAt: new Date().toISOString(), files: copied }, null, 2)}\n`,
  );
  console.log(`\nSynced from ${sourceDir}`);
  console.log(`  commit ${source.commit ?? 'unknown'}${source.dirty ? ' (with uncommitted changes)' : ''}`);
}

main();
