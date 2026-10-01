# Vendored MASP

Byte-for-byte copies of two files from the MASP repository
([Language-Research-Technology/ro-crate-maps](https://github.com/Language-Research-Technology/ro-crate-maps)):

| File | Copied from |
| --- | --- |
| `masp-validator.cjs` | `lib/masp-validator.js` |
| `rocphotos-profile.json` | `profiles/rocphotos/profile-crate/ro-crate-metadata.json` |

`SOURCE.json` records which checkout and which commit they came from, and
whether that checkout had uncommitted work at the time.

## Why these are copied rather than imported

The profile is still being drafted, in a repository rocphotos does not
control. If this app read the profile straight out of a sibling checkout,
an experiment over there would change what the editor offers and what it
accepts here, with no diff to look at. Copying the profile in means a
change upstream reaches rocphotos only when somebody runs the sync and
reads `git diff vendor/masp/`.

## Refreshing them

```sh
npm run sync:masp                       # the default sibling checkout
npm run sync:masp -- --from /path/to/ro-crate-masp
npm run sync:masp -- --check            # exit 1 if these are out of date
```

Nothing in `scripts/sync-masp.js` rewrites what it copies, so the diff
after a sync is exactly the upstream diff.

## The validator should become a package

`masp-validator.cjs` is library code, not a profile, and vendoring a
2,000-line library is the weakest part of this arrangement: a fix made
upstream reaches rocphotos only by hand. The file is copied unmodified
precisely so that this stays easy to undo — once MASP publishes the
validator, `src/masp/validator.js` is the single place that names the
vendored path, and switching it to a package import is a one-line change
with no other caller to chase. The profile copy should stay either way;
pinning the profile is the point of this directory.
