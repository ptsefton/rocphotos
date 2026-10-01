// The one place in rocphotos that names the vendored MASP validator.
//
// The copy under vendor/masp/ is byte-for-byte upstream's
// lib/masp-validator.js (see vendor/masp/README.md and scripts/
// sync-masp.js), kept as CommonJS because that is what upstream is:
// transforming it to ESM would make `git diff vendor/masp/` after a sync
// show our rewrite rather than upstream's change. Node's ESM loader
// imports a `.cjs` file's module.exports as its default export, and Vite
// converts the same file when it bundles src/sw.js, so both the `serve`
// process and the Service Worker get it from here.
//
// When MASP publishes the validator, this file becomes a re-export of
// that package and nothing else has to change.
import maspValidator from '../../vendor/masp/masp-validator.cjs';

export const { MaspValidator, ClassRule, PropertyRule } = maspValidator;
