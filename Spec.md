# RO-Crate Photos Specification

## 1. Purpose and Scope

Maintains "at rest" collections of photographs and scans on a filesystem as nested RO-Crate packages, two levels deep by default. Metadata is optionally synchronised between images and the RO-Crate structure where possible, plus a further layer of descriptive data linking images to people, other agents, and events.

Every crate directory also gets a static HTML view, so a collection is navigable — by date, subject, and other metadata — in a plain web browser, with no application required.

Key features:
- Stand-off annotation of images (keywords, face regions, etc.)
- Optional write-back of metadata to image files, in place or on export
- Face recognition
- Albums / collections for managing export

Coming soon:
- A persistent set of contextual entity-descriptions for people, place, organizations etc with relationships beweteen entities such as parent-child, using the Records In Context relationship schema.
- Photo presentations and photo books 

## 2. Data Model

### 2.1 File structure

1. The root of the collection is an RO-Crate (`ro-crate-metadata.json`).
2. Nested beneath it, at any depth, sub-collection crates each cover one directory of files (a day's photos, a camera upload, a set of scans), suiting date-based (`/yyyy/mm/dd/`), upload-based, or subject-based layouts.
3. Crate depth is capped at two levels — root and sub-collection — by a top-down walk: the first directory containing an image becomes a sub-collection crate, and everything nested beneath that point is absorbed into it rather than becoming crates of its own.

`_rocphotos/` holds `config/`, `trash/`, and `backup/` (backup not yet implemented).

### 2.2 RO-Crate data

Each crate is its own standalone `ro-crate-metadata.json`, with the usual RO-Crate root `Dataset` (`./`) and descriptor, and the same `@context` throughout:

```json
{ "@context": [
    "https://w3id.org/ro/crate/1.2/context",
    { "@vocab": "http://schema.org/",
      "oa": "http://www.w3.org/ns/oa#" } ] }
```

`oa` is bound on every crate, whether or not it currently holds a standoff region, because RO-Crate's own context defines `prov` but not `oa` — unbound, the `oa:` terms below would not be compact IRIs at all. A crate written before this gains the binding the next time anything rewrites it.

- **The root crate**, one per collection: lists each sub-collection as a `Dataset` in `hasPart`, holds `ImageGallery` entities (Albums, Section 3), and is where each `Person`/`Pet` in the collection is described — the place a person's own context (relationships, dates, and the rest of Section 1's "coming soon") is meant to accumulate. If the root directory holds images directly (Section 3.1), it holds their `ImageObject` entities too and is the collection's only crate.
- **Sub-collection crates**, one per sub-collection directory: an `ImageObject` per photo, an `ImageRegion` per tagged face/pet, and — between the two — an *instance* of each `Person`/`Pet` depicted there (below). The shared identity is duplicated into each crate as well, per RO-Crate convention, so a crate reads standalone rather than depending on the root's copy.
- **The faces crate** (`_rocphotos/faces/ro-crate-metadata.json`): one `FaceEmbedding` entity per confirmed face-recognition reference, linking back to its source `ImageRegion`/Person rather than duplicating image data — a mirror for inspection only. Matching and review query its companion `_rocphotos/faces/faces-index.sqlite` instead. Similar standalone crates may hold other kinds of reference data in future.

`rocphotos-index.sqlite` (Section 3.2) is a read-only, queryable index of the root and sub-collection crates combined; the PCDM `Collection`/`Object` typing lives there, not in the crates. The faces crate and its SQLite file are separate and not folded into it.

#### A photo, in a sub-collection crate

One photo carrying everything this app records: EXIF, keywords, a rating, a title and caption, a face tagged in the file itself, and a face confirmed here but not (yet) written back. `@graph` order is not significant; entries are ordered here for reading.

```json
{ "@id": "./", "@type": "Dataset", "name": "2025/03/10",
  "hasPart": { "@id": "IMG_0042.jpg" } }

{ "@id": "IMG_0042.jpg", "@type": "ImageObject",
  "name": "IMG_0042.jpg",
  "title": "Afternoon at the beach",
  "description": "Low tide, just before the rain came in.",
  "dateCreated": "2025-03-10T14:32:05.000Z",
  "dateModified": "2025-03-11T09:00:00.000Z",
  "keywords": ["Beach", "Holiday"],
  "rating": 4,
  "exifData": [{ "@id": "IMG_0042.jpg#exif-Make" }, { "@id": "IMG_0042.jpg#exif-Model" }],
  "about": [
    { "@id": "#person-JaneSmith" },
    { "@id": "#pet-Rex" },
    { "@id": "#person-BobJones" }
  ],
  "regions": [
    { "@id": "IMG_0042.jpg#region-0" },
    { "@id": "IMG_0042.jpg#region-1" },
    { "@id": "IMG_0042.jpg#region-standoff-0" }
  ],
  "thumbnail": { "@id": "thumbnails/IMG_0042.jpg.thumb.jpg" } }

{ "@id": "thumbnails/IMG_0042.jpg.thumb.jpg", "@type": "ImageObject",
  "name": "Thumbnail of IMG_0042.jpg" }

{ "@id": "IMG_0042.jpg#exif-Make", "@type": "PropertyValue",
  "name": "Make", "value": "Google" }
```

- `name` is the filename; `title` always has a value (IPTC/XMP title, else the filename), `description` only when the file has a caption.
- `dateCreated` is EXIF `DateTimeOriginal`. `dateModified` is the *source file's* mtime as of the last time it was processed — what a rescan compares against to decide whether to re-read the file at all.
- `keywords` excludes any name also recorded as a region (tagging tools commonly write both).
- `exifData` holds only the handful of fields shown in the preview's EXIF table, each as its own `PropertyValue` with a stable `#exif-<Field>` id so a rescan overwrites it rather than accumulating a new one.
- `about` lists every Person/Pet depicted, `regions` every region, whichever kind.
- `processingError` (not shown) carries the EXIF and/or thumbnail failure for a file that could not be fully processed; it is removed once the file processes cleanly.

#### Faces and pets

A Person/Pet id is derived from the name (`arcp://name,rocphoto/person/<NameSlug>`, letters and digits only, case-sensitive — see Section 3.2's People), so the same name is the same entity everywhere. In a sub-collection crate that identity appears twice over: the shared node, and **an instance of them in this crate** which everything else points at.

```json
{ "@id": "arcp://name,rocphoto/person/JaneSmith", "@type": "Person",
  "name": "Jane Smith" }

{ "@id": "#person-JaneSmith", "@type": "Person",
  "name": "Jane Smith",
  "prov:specializationOf": { "@id": "arcp://name,rocphoto/person/JaneSmith" } }
```

The instance is a bare fragment (`#person-<NameSlug>`, `#pet-<NameSlug>` — their own id spaces, so a Person and a Pet of one name never collide), resolved against the crate itself, and there is exactly one per person per crate however many photos in it depict them. **Every** reference inside a crate goes through it: an image's `about`, an EXIF-derived region's `about`, and a standoff region's body proxy all name the instance, never the `arcp://` id directly.

The point of the proxy pattern is that a person is not always known by one name. A sub-collection is usually a slice of time, so its instance is the natural place to record who they were *then* — a maiden name in the 2005 crates and a married name in the 2025 ones, both `prov:specializationOf` one identity, which is what makes them one person to the People tab, the facets and face recognition alike. The same applies to a name that was simply wrong in one place. (Merging two identities currently rewrites the instance names to the surviving one; setting a name per crate deliberately is a future feature, this lays the model down for it.)

The shared node is what the *root* crate holds in full, listed on its root dataset's `mentions`:

```json
{ "@id": "./", "@type": "Dataset", "name": "Photo Collection",
  "mentions": [{ "@id": "arcp://name,rocphoto/person/JaneSmith" }] }

{ "@id": "arcp://name,rocphoto/person/JaneSmith", "@type": "Person",
  "name": "Jane Smith" }
```

Rebuilt from the index on every scan and after every merge, so it always names exactly the people currently depicted — but only `name` is kept in step, and anything else recorded on the entity is left alone, since that description is the reason the root crate carries them.

A crate written before instances existed points `about` straight at the `arcp://` id. Since a scan only rewrites an image whose file has actually changed, both shapes can sit in one crate indefinitely; everything that reads a person copes with either (the shared node carries `@type` and `name` just as an instance does), and a merge matches either and writes the instance, migrating that reference as it goes. `--reprocess` converts a collection outright.

A region tagged in the photo file itself (MWG, from digiKam/Lightroom/Photos) is rebuilt from EXIF on every rescan, with a stable `#region-N` id. Its area is MWG's own convention: the **centre** point plus width/height, as fractions of the image.

```json
{ "@id": "IMG_0042.jpg#region-0", "@type": "ImageRegion",
  "name": "Jane Smith",
  "regionType": "Face",
  "about": { "@id": "#person-JaneSmith" },
  "xPosition": 0.35, "yPosition": 0.28, "width": 0.12, "height": 0.16 }
```

A region confirmed in this app is a *standoff* annotation instead — recorded whether or not it is ever written into the photo file (Section 3's Face Recognition), in its own `#region-standoff-N` id space so a rescan's renumbering of the EXIF-derived regions can never collide with it. Modelled on the W3C Web Annotation vocabulary, with the subject reached through a per-region body proxy — the same indirection Albums use, so this one sighting could later carry its own properties without touching the shared Person. Its target is a W3C Media Fragment, whose `xywh` is a **top-left** corner and size (as a percentage), not MWG's centre point.

```json
{ "@id": "IMG_0042.jpg#region-standoff-0",
  "@type": ["ImageRegion", "oa:Annotation"],
  "name": "Bob Jones",
  "regionType": "Face",
  "oa:motivatedBy": { "@id": "oa:identifying" },
  "oa:hasTarget": { "@id": "IMG_0042.jpg#xywh=percent:55,30,10,14" },
  "oa:hasBody": { "@id": "IMG_0042.jpg#region-standoff-0-body" },
  "writtenToFile": false }

{ "@id": "IMG_0042.jpg#region-standoff-0-body", "@type": "Person",
  "prov:specializationOf": { "@id": "#person-BobJones" } }
```

`writtenToFile` records whether this region has made it into the photo file's own XMP. Once a rescan finds the same name among the file's real EXIF regions, the standoff region and its body proxy are deleted and the EXIF-derived one takes over.

#### The root crate

Sub-collections and albums, both under the root `Dataset`'s `hasPart`. An album's membership *is* its `hasPart`, in display order, each entry a proxy rather than a direct reference to the image, so an image's appearance in this album could later have its own caption:

```json
{ "@id": "./", "@type": "Dataset", "name": "Photo Collection",
  "hasPart": [
    { "@id": "2025/03/10/" },
    { "@id": "arcp://name,rocphoto/album/BeachTrip" }
  ] }

{ "@id": "2025/03/10/", "@type": "Dataset", "name": "2025/03/10" }

{ "@id": "arcp://name,rocphoto/album/BeachTrip", "@type": "ImageGallery",
  "name": "Beach Trip",
  "description": "Best of the March long weekend.",
  "hasPart": [{ "@id": "arcp://name,rocphoto/album/BeachTrip#item-0" }] }

{ "@id": "arcp://name,rocphoto/album/BeachTrip#item-0", "@type": "ImageObject",
  "prov:specializationOf": { "@id": "2025/03/10/IMG_0042.jpg" } }
```

#### The faces crate

One entity per reference embedding, `about` the Person it belongs to (absent entirely for a permanently-ignored stranger), and pointing back at the region it was computed from rather than holding any image data:

```json
{ "@id": "b7c1f6e2-3a4d-4f1b-9c2e-8d5a0f3b1c77", "@type": "FaceEmbedding",
  "name": "Jane Smith",
  "about": { "@id": "arcp://name,rocphoto/person/JaneSmith" },
  "sourceImage": "2025/03/10/IMG_0042.jpg",
  "sourceRegion": "2025/03/10/IMG_0042.jpg#region-0",
  "embedding": [-0.0731, 0.1042, 0.0356],
  "embeddingModel": "face-api.js",
  "embeddingModelVersion": "0.22.2" }
```

`embedding` is the model's full 128-d vector (truncated above). A model version bump makes every reference obsolete, which is why the model is recorded per entity.

#### Vocabulary status

Every term resolves. `oa:` and `prov:` are prefixes (see the context above); the terms this app coins, because schema.org has no equivalent — `Pet`, `ImageRegion`, `FaceEmbedding`, `regions`, `regionType`, `xPosition`/`yPosition`, `writtenToFile`, `rating`, `processingError`, `embedding`/`embeddingModel`/`embeddingModelVersion`/`sourceImage`/`sourceRegion` — are bound individually to `https://w3id.org/ldac/rocphotos/terms#<term>`. Term definitions rather than a prefix, so the crates are unchanged: a crate still writes `regionType`, and the binding is what stops it reading as a `http://schema.org/` IRI that schema.org does not define. `width` and `height`, which a region also uses, are left as schema.org's own rather than redefined to mean a fraction.

These IRIs are the ones named by the rocphotos MASP profile (Section 3.5), which is where the terms are described.

## 3. Application Behaviour

On first use, the application walks the file tree and builds an overview map (`rocphotos-overview.json`, at the collection root): one row per sub-collection — path, image count, and status (`not-scanned`, `out-of-date`, `up-to-date`, or `invalid` — an existing crate file that fails to load, e.g. from an incompatible tool) — computed cheaply, without reading image bytes or EXIF. The user picks which sub-collections to actually process, via a collapsible tree grouped by directory structure (year, then month, say): every folder starts collapsed, shows a rolled-up status-count summary, and only a leaf (a sub-collection) is actually selectable — checking a folder selects everything beneath it, with an indeterminate state when only some are selected. Expansion and selection survive "Refresh Status" and processing. Re-opening the app finds and shows the existing map; "Refresh Status" recomputes it on demand.

Processing a selection creates/updates the root and sub-collection crates, adds an Image entity for any file not already present, and generates thumbnails. Non-image files are ignored.

This screen — Scan, in `rocphotos serve`'s web view (Section 4.1) — is shared, unchanged, with the browser SPA: `webview/overviewUI.js` for the tree UI, `scanCollection.js` for the scan itself (also what the CLI's `scan` command uses). `rocphotos serve` bootstraps an empty root crate and config on first run rather than requiring a prior CLI scan, and switches to Scan automatically, once, on a fully-unscanned collection. A selection is scanned one sub-collection at a time, reporting progress ("Scanning 2006/01/03… (3 of 7)"). The "Always process everything on open" checkbox (browser SPA only) bypasses this screen entirely.

`rocphotos serve`'s web view is a single page with four switchable modes — **Explore** (facets/grid/viewer), **People** (below), **Scan** (above), **Settings** (below) — via a `#mode-bar` at the top, no reload. Explore is the default.

**Settings screen** edits `rocphotos.config.json`: the write-back checkbox (see Face Recognition, below), the export path and the export-metadata checkbox (see Albums, below), and `excludeDirectories`/`excludeFiles` as one-pattern-per-line lists — the same settings the browser SPA's own Settings section has always had, now editable from `rocphotos serve` too. Backed by `GET`/`POST /api/admin/config`. The write-back setting takes effect on the next `rocphotos serve` restart; exclude patterns apply from the next scan; the export settings apply to the next export. It also has a "Regenerate Preview HTML" button (see Section 3.4).

A file is only re-read (EXIF + thumbnail) if its modification time has changed since last processed, whether or not that attempt succeeded — so a failed file is not retried until it changes, and a new extraction field does not retroactively apply to unchanged files. `--reprocess` forces re-extraction of everything regardless of mtime.

An EXIF or thumbnail-generation failure does not skip the image: both are recorded together in its `processingError` property, used for retry logic and for flagging the file in the generated HTML preview.

`title` (IPTC `ObjectName`/XMP `dc:title`) always has a value, falling back to the filename; `description` (IPTC `Caption-Abstract`/XMP `dc:description`) has none when absent. Both are editable (see Editing).

`rocphotos scan <directory> --subdir=<name>` (repeatable) scans only the named sub-collection(s); everything else is left untouched this run (not even read) but still reflected in the root's preview/`hasPart` from whatever the index already has. A sub-collection whose existing crate file fails to load is reported and skipped rather than aborting the whole scan.

The application also maintains a SQLite index, per the [AROCAPI specification](https://github.com/crate-works/ro-crate-api) — see Section 3.2.

### 3.1 Excluding Directories and Files from the Walk

There is an ignore-list for files which includes `.*` by default and the `thumbnails/` cache this app adds.

Beyond that, a collection may contain directories or files that should never be scanned (a static HTML gallery from another tool, stray loose images). `rocphotos.config.json`, at the collection root:

```json
{ "excludeDirectories": ["^\\.", "^HTML"], "excludeFiles": ["^Thumbs\\.db$"] }
```

Each is a list of regular expressions matched against a directory's or file's own name, at any depth. An excluded file is treated as if it did not exist. `excludeDirectories`, if present, replaces the `.*` default rather than adding to it; `excludeFiles` has no default. Read through the same filesystem interface as everything else, so it's honoured identically by the CLI and the browser SPA.

The same file holds `writeMetadataToFiles` (boolean, default `false`) — the opt-in for writing metadata into the photo files themselves: confirmed faces (Face Recognition, below) and any keyword, title, caption or rating edited in the app (Editing, below) — plus `exportPath` (string, default none) and `exportWithMetadata` (boolean, default `false`), which say where album exports land and whether this app's own metadata is written into them (Albums, below). All are editable via the Settings screen (Section 4.1) as well as by hand.

#### Loose Images in the Collection Root

An image sitting loose in the collection root (alongside year/month/day subdirectories) would otherwise make the walker treat the whole root as the sole crate, hiding every subdirectory's crate. (Not an issue when the root holding images is the *only* content — that's the intended single-folder case.)

The CLI detects this and prompts (interactively, requiring a real terminal) to either move the loose files into a new folder (becoming their own sub-collection crate), add them to `excludeFiles`, or cancel. Non-interactively: `--loose-root-images=move [--loose-root-images-folder=<name>]` or `=ignore`.

The browser SPA has neither the prompt nor the flags; it only honours whatever `excludeFiles` is already configured.

### Editing

The web view can edit metadata, not just browse it — a second writer to the crate JSON and index (AROCAPI's own endpoints stay read-only).

Grid tiles are checkable ("Select All" selects everything the current search shows); a selection bar then offers bulk actions, also available for the single photo open in the viewer:

- **Delete** — moves the file into `_rocphotos/trash` (preserving its relative path) and removes it from the crate/index. Its thumbnail is deleted outright; a depicted Person/Pet entity is left alone.
- **Add keyword** — a dialog adds several keywords in one edit, with autocomplete and a click-to-add list of every keyword already used in the collection.
- **Remove keyword** — removes one keyword across every selected image.
- **Set rating** — bulk 1-5 stars from the selection bar, or clears it if left blank. A single image's rating is set directly via a star row on its thumbnail/viewer.
- **Edit title** / **Edit description** — single-image only, from the viewer. Title falls back to the filename when blank; description just clears.

A cleared value is removed from the entity rather than written as an empty one, so a rescan cannot resurrect it and a reader never has to treat `""`/`[]` as "none":

```json
{ "@id": "IMG_0042.jpg", "@type": "ImageObject", "name": "IMG_0042.jpg",
  "title": "IMG_0042.jpg" }
```

(the same photo as Section 2.2, with its keywords, rating and caption all cleared; `title` falls back to the filename rather than disappearing.)

An edit writes directly to the crate and the index, reflected immediately (no rescan needed) — the read routes' crate cache is updated in the same step. A rescan of an unchanged file leaves an edit alone; `--reprocess` overwrites it from EXIF.

**Into the file too, on request.** With `writeMetadataToFiles` on (Section 3.1), an edit is also written into the photo itself via `exiftool` — the same wholesale `writeImageMetadata` the export feature uses, pointed at the original rather than a copy, so one switch covers both a confirmed face and an edited keyword, title, caption or rating. Best-effort and last, exactly like the faces write-back: the edit has already succeeded in the crate and the index, so a failure here is reported alongside it rather than undoing it. The file is re-read afterwards (`rescanImageMetadata`) to keep its recorded modification time in step, or the next scan would see every edited file as changed. Off by default, and it still modifies originals with no backup — Section 2's backup mechanism remains undecided, which is the reason for the warning on the setting rather than for the feature's absence.

Face recognition (below) finds and confirms people automatically, instead of relying only on manual tagging in another tool.

### Albums (ImageGallery virtual collections)

An album is an ordered, named virtual collection of images ("New Album" button; "Add to album" on a selection, offering the 3 most-recently-used albums plus search).

Status:
- Create an album — **implemented.**
- Add images — **implemented.**
- Export to `_exports/` — **implemented**, without accompanying RO-Crate metadata yet.
- Stand-alone single-file HTML album view (data-URI images, slideshow) — not yet implemented.

**Implementation.** An album is an entity (`ENTITY_TYPE_ALBUM`, `schema:ImageGallery`), keyed by name (`albumEntityId`, its own `.../album/` id space), living only in the root crate. `date_created` doubles as "last used". Membership is the album's own `hasPart`, in display order, each entry a small proxy (`<albumId>#item-<n>`) `prov:specializationOf` the real image — the same indirection `ImageRegion` uses — so a member's appearance *in this album* could later carry its own caption without touching the shared image entity.

Two photos in order (see Section 2.2's root-crate example for the album entity itself) — the proxy ids carry the position, so reordering is a rewrite of `hasPart`, and neither image's own entity is touched:

```json
{ "@id": "arcp://name,rocphoto/album/BeachTrip#item-0", "@type": "ImageObject",
  "prov:specializationOf": { "@id": "2025/03/10/IMG_0042.jpg" } }

{ "@id": "arcp://name,rocphoto/album/BeachTrip#item-1", "@type": "ImageObject",
  "prov:specializationOf": { "@id": "2025/03/11/IMG_0067.jpg" } }
```

Routes (not AROCAPI): `POST /albums` (create/update), `GET /albums` (list, `?q=` to search), `GET /albums/{id}` (members, ordered), `POST /albums/{id}/add`. `albums` is also a real facet (`STORED_FACETS`), populated by the add route rather than derived from EXIF, so an album composes with every other filter and appears in the sidebar's Albums panel and the generic facets list alike (`toggleFilter('albums', name)` either way).

**Export** (`src/core/export.js`) copies an album's member files into `_exports/<album-name-slug>/`, preserving each file's collection-relative path — files only, no crate/metadata yet. `_exports/` is excluded from the scan walk. Re-exporting overwrites. Reachable via `rocphotos export-album <directory> <album name>` (CLI) or the web view's "Export \<name\> Album" button (shown only while that album is the active filter).

**Metadata in exported files.** Settings' "Copy metadata into exported files" (`exportWithMetadata`, default off) writes what this app knows — confirmed face/pet regions, keywords, title, caption, rating, as `readImageRecord` has them — into each exported copy via `exiftool` (`writeImageMetadata`), so an export stands on its own in any other photo tool rather than only making sense beside this collection's crates. Copying already carries the original's EXIF along with the bytes; this adds everything since recorded here but never written into the file. Each value goes to both its XMP and its IPTC home (keywords also to Lightroom's hierarchical extension), since a reader may prefer any one of them and a half-written set would leave a stale value in whichever field wins — confirmed by round-tripping an export back through `scan`. This is the one place the crate's model is written back out as file metadata. Every region goes out in MWG's centre-based form regardless of which shape it had in the crate: Jane Smith's EXIF-derived `xPosition`/`yPosition` pass straight through, while Bob Jones's standoff `xywh=percent:55,30,10,14` (a top-left corner) becomes the centre `0.6, 0.37` — the same normalisation `readImageRecord` does for every other consumer (Section 2.2):

```json
{ "XMP-mwg-rs:RegionInfo": {
    "AppliedToDimensions": { "W": 4080, "H": 3072, "Unit": "pixel" },
    "RegionList": [
      { "Type": "Face", "Name": "Jane Smith",
        "Area": { "X": 0.35, "Y": 0.28, "W": 0.12, "H": 0.16 } },
      { "Type": "Face", "Name": "Bob Jones",
        "Area": { "X": 0.6, "Y": 0.37, "W": 0.1, "H": 0.14 } }
    ] },
  "XMP-dc:Subject": ["Beach", "Holiday"],
  "XMP-lr:HierarchicalSubject": ["Beach", "Holiday"],
  "IPTC:Keywords": ["Beach", "Holiday"],
  "XMP-dc:Title": "Afternoon at the beach",
  "XMP-dc:Description": "Low tide, just before the rain came in.",
  "XMP:Rating": 4 }
```

Unlike `writeMetadataToFiles`, this needs no warning and no separate opt-in beyond the checkbox: it only ever touches the export just made. Needs `exiftool` and a destination the run mode can name on disk (`absolutePathFor`, Node only); without either, the copies still export and the response says what was skipped (`metadata.unsupported`) rather than failing.

**Export path.** Settings' "Export path" (`exportPath` in `rocphotos.config.json`) sends exports somewhere else entirely — an absolute path, or one starting with `~`, anywhere on disk; blank keeps the built-in `_exports/`. A configured path *is* the export root (the album's slug directory sits directly under it, with no `_exports/` level inside). Files are read through the collection's own adapter and written through a second one rooted at the configured path (`resolveExportTarget`, `exportFiles`'s `destFsAdapter`), built by the Node run modes only (`createAbsoluteFsAdapter`, which also expands `~`) — the browser tab's File System Access API handle cannot reach outside the granted directory at all, so exporting there with a path set refuses, saying so, rather than silently landing the files somewhere the setting didn't ask for. A relative path is rejected at save time for the same reason: it would save cleanly and then be ignored.

### Face Recognition

Extends the Person and `ImageRegion` model (Section 3.2). A confirmed face is always recorded as a standoff region first (`addStandoffFaceRegion`) — a crate-only write — and only then, best-effort, written into the photo file's own XMP (via `exiftool`) and re-extracted, superseding the standoff region. The confirmation itself succeeds either way.

**Library and runtime.** [face-api.js](https://github.com/justadudewhohacks/face-api.js) (TensorFlow.js, client-side) does detection and produces a 128-d embedding per face, loaded from `webview/vendor/`. Detection/embedding run identically in both run modes; only the best-effort file write needs `exiftool`, so it only ever happens from `rocphotos serve`.

**Write-back is off by default, per collection, and confirming a face never depends on it.** `writeFaceRegion` (`src/adapters/exiftoolWriteback.js`) uses exiftool's `-overwrite_original` (no backup beyond the user's own). `/confirm` attempts it only if `exiftool` is available and the collection has opted in (`writeBackEnabled`, Section 3.1); neither a missing piece nor a failed write turns into a request failure. Default `writeBackEnabled: false` so a caller that forgets to pass it fails safe. Toggled via the Settings screen (Section 4.1).

A permanently-ignored stranger is a reference with no Person at all — no `about`, and no `sourceRegion`, since it is deliberately never written back to a photo as a real region (see Section 2.2 for the named case):

```json
{ "@id": "e3d9f0a1-5b2c-4d6e-8f10-2a3b4c5d6e7f", "@type": "FaceEmbedding",
  "name": "Ignored stranger",
  "sourceImage": "2025/03/10/IMG_0051.jpg",
  "embedding": [0.0204, -0.1137],
  "embeddingModel": "face-api.js",
  "embeddingModelVersion": "0.22.2" }
```

**Reference data.** `_rocphotos/faces/ro-crate-metadata.json` holds one `FaceEmbedding` entity per confirmed reference, for inspection; matching and review query its companion `_rocphotos/faces/faces-index.sqlite` instead, which tracks `scanned_images` (mtime-keyed, skips unchanged files; a model bump forces a re-scan), `reference_faces`, and `detections` (`pending`/`confirmed`/`ignored`/`auto_ignored`). Matching compares embeddings in memory (Euclidean distance) — no vector-search infrastructure needed at this scale.

**Match confidence** (`src/core/faces/matching.js`). Two guards against a wrong-but-confident-looking suggestion: `MATCH_THRESHOLD` (0.5, tightened from face-api.js's own 0.6 default) and `MATCH_MARGIN` (0.075) — the closest reference must be within threshold *and* clearly closer than the nearest reference belonging to a different identity (every reference for the same Person reinforces the match rather than competing with it; every stranger reference counts as one such "other" identity, regardless of which specific stranger). A candidate this ambiguous returns no suggestion at all, not a guess, favouring a missed match (falls to "Unidentified" for manual review) over a wrong one (risking a rubber-stamped "Confirm all").

**Detection quality** (`webview/faceQuality.js`, "find new faces" only — never applied to backfilling an embedding for an already-named region, where a poor detection still beats none at all): a detector confidence floor (`DETECTION_MIN_CONFIDENCE`, 0.7, raised from face-api.js's 0.5 default) filters out low-confidence non-faces; a minimum size (`MIN_FACE_SIZE_PX`, 40px) filters out faces too small to embed reliably; and `frontalRatio` — the ratio of the two nose-to-eye horizontal distances from the 68-point landmarks, 1 for a perfectly frontal face, near 0 for a strong profile turn — filters out side-on faces (`MIN_FRONTAL_RATIO`, 0.5), which face-api's recognition net, trained mostly on frontal faces, embeds much less reliably.

**Scope.** Finding faces operates on whatever the grid currently shows (any combination of active filters, not only a directory).

**Learning from already-tagged faces.** A face tagged by another tool or an earlier session has a name and box but no embedding — backfilled once, collection-wide (unlike finding new faces, which is scoped to the current view), so the reference set is seeded before any suggestions can be made. An image whose regions are all backfilled (or given up on, see below), as of its current mtime, is skipped without re-reading its crate. `POST /api/faces/existing-regions` lists what still needs it; the browser detects a face matching each tagged region (full-image, then a padded crop at a lower threshold if that fails) and `POST /api/faces/backfill-reference` records it — no review step, since a human already confirmed the name. A region's `Area` is checked both as-is and EXIF-orientation-corrected (`correctAreaForOrientation`, `bestOverlapEitherOrientation`), since different tagging tools disagree about which frame it's measured against; overlap is by containment (`containmentOverlapRatio`), not IoU, since tools draw boxes at different scales for the same face.

**Giving up on an undetectable face.** A face face-api.js can never re-detect (side profile, sunglasses, motion blur, backlighting) is reported via `POST /api/faces/backfill-undetectable` and recorded in `backfill_undetectable_regions`, treated as resolved for backfill purposes without ever counting as a match. A model version bump retries it. The status line reports how many were given up on.

**Workflow.** "Recognize Faces", next to Select All:
1. Backfills already-tagged faces, loads the face-api.js models, checks `POST /api/faces/scan-status` for unscanned images in view.
2. Detects and submits results (`POST /api/faces/detections`) for each; a detection overlapping an already-named region is dropped (would otherwise duplicate it every run). Matches: close to a Person → suggested; close to a stranger reference → `auto_ignored`; otherwise unmatched, pending review.
3. Opens a review screen of pending detections as cropped thumbnails, grouped by suggested Person. A detection with no suggestion at all is instead grouped with any other unsuggested detection it is visually similar to (`clusterUnmatched`, `src/core/faces/matching.js` — complete-linkage on a tighter `CLUSTER_THRESHOLD`, computed server-side so raw embeddings never need to reach the client, only a cluster's member ids do); only a face unlike anything else pending gets its own single card under "Unidentified". Clicking a crop opens the whole photo full-screen with that box highlighted, to judge it in context.
    - A cluster's own **[-]** pulls one face out of it — purely client-side (a cluster is a presentation of still-pending detections, never a stored fact), moving it to its own "Unidentified" card; a cluster down to one member dissolves into a card the same way, rather than lingering as a group of one.
    - Every "Unidentified" card also has a checkbox — a manual complement to automatic clustering, for a match the embedding similarity missed (or just two faces the reviewer recognises as the same person on sight): checking any subset reveals a bar to name all of them, or ignore all of them, in one action.
    - **Confirm all as \<name\>** — accepts every thumbnail in a group with a suggested Person.
    - **Reassign all to…** — same group, different target name.
    - **None of these are \<name\>** — bulk reject: re-matches every detection in the group against everyone else, excluding this Person.
    - **Ignore all** — bulk dismiss, no confirm or reject.
    - A cluster with no suggested name at all has none of the three above (nothing to confirm, reject, or re-suggest) — its name-input row (below) is the only, and primary, way to resolve it, typing one name to confirm every member at once.
    - **Reassign** — per-thumbnail, pre-fillable from suggestions; also how a new name is given to an unmatched face or an unnamed cluster's own member.
    - **[-] (reject)** — on a thumbnail with a suggested Person only: "not this Person"; re-matches against the reference set excluding every Person rejected so far.
    - **Ignore** — dismisses this detection only (a future model version starts fresh).
    - **Ignore as stranger** — adds a reference with no Person, so future close matches are auto-ignored.
4. Confirming records a standoff region (Section 3.2) — fully visible immediately (viewer tags, "Show faces", people/pets facets) — then, if write-back is enabled, attempts the real file write, which supersedes the standoff region. Either way adds the embedding as a new reference example. Response reports `writtenToFile: true/false`.

Not yet implemented: a provenance marker distinguishing a machine-confirmed region from a human-tagged one, a UI for a Person's reference examples, grouping the review screen by suggested Person, re-embedding after a model upgrade.

**Known limitation:** Person identity is derived from name, case-sensitively (`nameSlug`), throughout the app — "Jane Smith" and "jane smith" are different Person entities. Making this case-insensitive would need a collection-wide id migration, not done as a side effect of face recognition work; the People tab below is the manual fix for whenever it happens.

### People

A People tab lists every Person with an image count (`facetCounts`, not the paginated `GET /entities`), with a type-to-narrow filter over the list. Each name is itself a link to that person's photos: it switches to Explore filtered to them, replacing the active filters rather than adding to them, so the grid's count always matches the count shown beside the name. Checked names can be renamed or merged. One checked name is a rename; two or more merge into one identity — the manual remedy for two names (a case variant, a typo, a duplicate spelling) that should have been the same Person, or the deliberate joining of two that now are. Either way the new name is asked for in the same "Who is this?" dialog face confirmation uses, prefilled with the first name checked, and can be an existing name or a new one.

Renaming and merging are one operation, not two: identity is name-derived (`personEntityId`), so both come down to "every one of these names now means this name instead", and renaming onto a name already in use simply merges into it. Only the button's label and the wording distinguish them, since to someone using it they are plainly different things. A rename left at the name it already has does nothing rather than reporting an empty success.

**Routes** (`src/core/people/handler.js`, `/api/people/*`, both run modes): `GET /` (the list above); `POST /merge` (`{sourceNames, targetName}`, one name renames, several merge).

Renaming "jane smith" to "Jane Smith" rewrites every reference to them in each crate that depicts them — the image's `about`, the region's `about` and its duplicated `name` — and drops the old Person node once nothing points at it:

```json
{ "@id": "p.jpg", "about": [{ "@id": "#person-janesmith" }] }
{ "@id": "p.jpg#region-0", "name": "jane smith", "about": { "@id": "#person-janesmith" } }
{ "@id": "#person-janesmith", "@type": "Person", "name": "jane smith",
  "prov:specializationOf": { "@id": "arcp://name,rocphoto/person/janesmith" } }
{ "@id": "arcp://name,rocphoto/person/janesmith", "@type": "Person", "name": "jane smith" }
```

becomes

```json
{ "@id": "p.jpg", "about": [{ "@id": "#person-JaneSmith" }] }
{ "@id": "p.jpg#region-0", "name": "Jane Smith", "about": { "@id": "#person-JaneSmith" } }
{ "@id": "#person-JaneSmith", "@type": "Person", "name": "Jane Smith",
  "prov:specializationOf": { "@id": "arcp://name,rocphoto/person/JaneSmith" } }
{ "@id": "arcp://name,rocphoto/person/JaneSmith", "@type": "Person", "name": "Jane Smith" }
```

A standoff region needs no rewriting of its own: its body proxy points at the instance, so swapping the instance moves the region with it. The root crate's `mentions` is rebuilt afterwards, dropping the merged-away identity.

**Mechanics.** Never touches an original photo file, only crate JSON-LD and the two SQLite indexes, so it behaves identically in every run mode. For each source name not already spelled exactly like `targetName`: pages through every image tagged with it (`searchEntities`/`countSearchResults`, not the default 100-row page), re-points each one's `about` and its regions' `about`/body-proxy `prov:specializationOf` at the target id (`renamePersonInCrate`), and deletes the now-unreferenced source Person node from every crate that held it. Every touched image's facet rows are then re-derived straight from its rewritten crate record (`syncImageIndexFromCrate`) rather than hand-patched, so they can't drift from what the crate now actually says; the source's own now-orphaned `entities` row is deleted once nothing points to it any more. The faces companion index (`reference_faces`, `backfill_undetectable_regions`, `detections.suggested_person_id`/`resolved_person_id`/`rejected_person_ids`) is re-pointed the same way (`mergePersonInFacesStore`), including its own dedup/conflict handling where two rows collide afterwards. Wrapped in one `serializeWrites` call, the same read-modify-write-then-persist shape as `/edit/*` and `/faces/confirm`.

Not yet implemented: renaming/merging Pets (the mechanics apply equally; the tab only lists Person for now), undoing either.

### 3.2 The SQLite Index (AROCAPI)

`rocphotos-index.sqlite`, at the collection root, is a read-only materialised view of the root and every sub-collection crate — one file per collection, not per sub-crate. It is never a second source of truth: nothing writes to a crate's JSON through it.

The schema is a minimal subset of the [AROCAPI specification](https://github.com/crate-works/ro-crate-api), drawn from [PCDM](http://pcdm.org/models). Every entry point that opens an existing index must call `ensureSchema` first, not only `scan`, which builds one.

- `ro_crates(id, path, name, created_at, updated_at)` — one row per crate directory.
- `entities(id, ro_crate_id, entity_type, name, title, description, processing_error, member_of, metadata_license_id, content_license_id, access_metadata, access_content, date_created)` — one row per crate (Collection) and per image (Object).
- `files(id, entity_id, filename, media_type, size, relative_path, access_content)` — the image bytes backing an Object.
- `entity_facets(entity_id, facet_name, value)` — one row per (entity, facet, value), indexed on `(facet_name, value)` and `entity_id`.

`entity_facets` is one generic table for every faceted field, single- or multi-valued per entity alike — a new facet is new rows, no schema change. Current facets (image entities only, derived from EXIF/IPTC/XMP at scan time): `camera` (Make+Model), `lens` (LensModel, falling back to LensMake), `keyword` (IPTC Keywords/XMP `dc:subject`/Lightroom `hierarchicalSubject`, split on `|`), `rating` (XMP star rating 1-5; 0 means unrated), `people`/`pets` (named MWG regions). `year` is derived from `date_created` at query time, not stored. A facet's own selected value never narrows its own counts, only every other active filter does.

Entity types follow PCDM: crates are `pcdm:Collection`, images `pcdm:Object`, `member_of` pointing to their crate. Ids reuse the collection-relative path convention (`2025/03/10/`, `2025/03/10/photo.jpg`, `./` for root).

A named MWG region becomes its own entity too, not just a facet value: a `Face` region → `schema:Person`, a `Pet` region → this app's own `Pet` type. Id is name-based, not path-based (`arcp://name,rocphoto/person/<slug>`, `.../pet/<slug>`) — the same name always the same id; a Person and a Pet with the same name never collide. Identity is by name string only. Recorded once, then duplicated into every crate that depicts them, per RO-Crate convention. A region's name is excluded from the image's own `keyword` facet, so it isn't double-counted.

Each region occurrence is also its own `ImageRegion` entity (`<image>#region-<index>`, stable across rescans) — what "Show faces" draws. Distinct from the image's `about` (linking to the shared Person/Pet, for facets): Person/Pet is deduplicated across photos, `ImageRegion` is one photo's one occurrence. Not an external vocabulary term; `xPosition`/`yPosition`/`width`/`height` (fractional, centre-based, mirroring MWG's `Area`) are application-specific.

**Standoff region data model.** A confirmed face is recorded using the [W3C Web Annotation Vocabulary](https://www.w3.org/TR/annotation-vocab/) (`oa:`, `http://www.w3.org/ns/oa#`) instead of the bespoke shape above — a second, independent shape, not a replacement: EXIF-derived regions (`regionsFromExif`) still use the plain shape; only a region confirmed but not yet written to the file (`addStandoffFaceRegion`) uses this one. `readImageRecord` normalizes both into the same centre-based `{x,y,w,h}` for every other consumer. See Section 2.2 for both shapes side by side.

`oa:hasBody` points at a per-region proxy, `prov:specializationOf` this crate's instance of the Person/Pet (which in turn specializes the shared identity) — the same indirection Albums use, so this one sighting could later carry its own properties.

`oa:hasTarget` is a bare `{"@id": ...}` reference: the image's id plus a [Media Fragments](https://www.w3.org/TR/media-frags/) `#xywh=percent:x,y,w,h` fragment — top-left, 0-100%, matching face-api.js's own box convention (converted to MWG's centre convention only when actually written to a file's XMP).

**TODO:** `regionType` is still a bare, unprefixed string, arguably redundant with the proxy's own `@type`. Left as-is for now.

`writtenToFile`: `true` for a region read from the file's EXIF; `false` for one confirmed but not (yet, or not allowed to be) written to the file. This is what makes a confirmed face fully visible immediately (viewer tags, "Show faces", people/pets facets) regardless of the write-back setting.

**Implementation.** `addStandoffFaceRegion(crate, path, { name, subjectId, subjectType, box })` creates both nodes. Its id namespace, `#region-standoff-<n>`, is separate from EXIF-derived `#region-<index>` so the two never collide across a rescan. `addImageEntity`'s region-rebuild preserves a standoff region not yet matched by a fresh EXIF region (merging its name into `people`/`pets`); one that now matches is dropped along with its proxy. `removeImageEntity` does the same cleanup on delete. `syncImageIndexFromCrate` (`scanImage.js`) keeps the SQL index in sync for a crate-only write (`/faces/confirm`'s standoff path), the same logic `rescanImageMetadata` runs after an actual file read.

`ro_crates.id`/`entities.ro_crate_id`/`entities.member_of` all use the same crate-entity-id convention (`./` root, `<path>/` sub-crate), so every relationship is traceable by matching ids directly; `ro_crates.path` keeps the raw directory path.

AROCAPI requires a `metadataLicenseId`/`contentLicenseId` and access flags on every entity; a fixed placeholder is used, since the application has no licensing/access-control model yet — it MUST only serve data on a local port.

The index is built via `node:sqlite`, CLI/desktop-only; a browser-side equivalent (WASM SQLite, same file format) is planned but not implemented.

`rocphotos export-excel <directory>` dumps the index to a three-sheet `.xlsx` workbook (RO-Crates, Entities, Files) for manual review; `--include-entity-crates` adds each entity's full resolved JSON-LD as a fourth sheet (debugging only).

#### AROCAPI Endpoints and the Web View

A read-only AROCAPI handler serves the index: `GET /capabilities`, `GET /entities` (filterable by `entityType`, `memberOf`, facets), `GET /entity/{id}`, `GET /entity/{id}/metadata` (full resolved JSON-LD), `GET /files`, `GET /file/{id}` (image bytes), `GET /ro-crates`, `GET /ro-crate/{id}`, `GET /ro-crate/{id}/metadata`, and `POST /search` (filters + requested facets, returning matches and value/count breakdowns). An id containing `/` is one percent-encoded path segment. No write/deposit support: crates are only ever created/updated by scanning.

`GET /entity/{id}/thumbnail` (not AROCAPI) serves an entity's thumbnail bytes.

The handler is a pure function of a SQLite driver and filesystem adapter, reused by more than one transport. `rocphotos serve <directory>` hosts it over `node:http`, bound to `127.0.0.1`, under `/api/*`, alongside a small static web view (`webview/`) that queries `/api/search` to browse and facet-filter by camera, lens, keyword, rating, people, pets, and year, with thumbnails and a full-screen viewer.

A "Collection Folders" panel lists every sub-crate (`GET /ro-crates`) as a directory tree (an intermediate directory with no crate of its own is an unclickable grouping label); clicking one sets `memberOf`. "All Folders" clears it. A "Dates" panel gives the same tree navigation derived from `dateCreated` instead: Year, then Month, then Day, each level fetched lazily on expansion (`GET /api/date-facet?granularity=year|month|day[&year=][&month=]`, kept separate from AROCAPI's own `/search` facets — an unscoped month/day count is a much odder thing for a generic client to ask for than year). Clicking a node applies exactly that scope, replacing whichever of month/day was previously active (the same `applyDateFilter` the viewer's own date breadcrumb uses). Both panels are collapsible `<details>`, rolled up by default.

The viewer fetches an entity's full metadata (`GET /entity/{id}/metadata`) for its keywords/people/pets as clickable tags, a "Show faces" overlay when the photo has named regions, a camera/lens/dimensions line, and a clickable date breadcrumb ("2024 › 09 › 03") that filters the grid the same way the Dates panel does. The breadcrumb degrades to a shorter form if only a year or year+month is known (not yet exercised — every current date source supplies a full date). Prev/Next and arrow keys step through whatever result set was on screen when the viewer opened.

The same handler is also hosted inside the browser-tab mode via a Service Worker (`src/sw.js`) intercepting same-origin `/api/*`, so the same `webview/` files work there unchanged. The Service Worker gets its directory handle via `postMessage` from the main page (it cannot call `showDirectoryPicker` itself) and persists it in IndexedDB across its own restarts. If access has not been re-granted, or the collection is unscanned, `/api/*` returns a clear JSON error.

### 3.3 Thumbnails

OS thumbnail caches (Windows `Thumbs.db`, macOS previews, freedesktop.org) are not used — they live outside the granted directory, aren't portable with the crate, and are sometimes proprietary.

The application generates its own thumbnails when a sub-collection crate is created/rescanned, skipping unchanged files. Browser SPA: Canvas API; CLI: `sharp`. A failure still adds the image to the crate (recorded, not retried until the file changes) and falls back to the full-size image in generated pages. Stored in a `thumbnails/` subdirectory per sub-collection crate, listed as `hasPart`. One size by default (e.g. 400px longest edge, JPEG); more sizes possible later without a data model change.

### 3.4 HTML Preview Pages

At scan time, a static `ro-crate-preview.html` is written into every crate directory alongside its `ro-crate-metadata.json`.

- Sub-collection crate: a thumbnail grid, each caption showing filename, date, any extraction error, and a collapsed EXIF table.
- Clicking a thumbnail opens a full-screen viewer (pure HTML/CSS, no JS, works over `file://`) with the full-resolution image and the same EXIF table.
- Root crate: date-based navigation — sub-collections grouped by year then month, most recent first, only the most recent year/month expanded by default; undated sub-collections under "Undated". A sub-collection's date is the earliest EXIF date among its images.
- If the root itself holds images directly, its preview is a thumbnail grid instead.
- Both levels carry a **People** box: a scrollable list of everyone depicted with their photo count, and a search field to narrow it. Picking someone opens a panel of their photos inline below the list, so several people can be looked at in turn without closing anything. A sub-collection's page shows all of a person's photos there and points each at the same in-page viewer its main grid uses; the root page covers the whole collection, so it caps each person at `ROOT_PERSON_THUMBNAIL_LIMIT` (saying what it is not showing) and links each photo to the file rather than carrying a second copy of every viewer.

Opening, closing and highlighting a person are plain CSS — a hidden radio per person, checked by the list's own `<label>`, rather than `:target`, which the image viewer already uses: radio state is independent of the URL fragment, so opening a photo from someone's panel leaves that panel open to come back to. The one thing CSS cannot do is narrow a list by typed text, so the search field alone is driven by a few inline lines of JavaScript; it starts hidden and is revealed by that script, leaving a complete, fully working list when scripts are blocked rather than a search box that does nothing.

Links are complete, percent-encoded relative paths, so they resolve under `file://` regardless of special characters in filenames. Regenerated in full on every scan, or on demand from Settings' "Regenerate Preview HTML" (`POST /api/admin/regenerate-previews`, `src/core/previews.js`), which rewrites every page from the crates and index as they stand without re-reading a photo — the quick way to pick up a change to the template, or to see a rename or merge reflected. Not part of the crate's own metadata graph. A source image's `ImageObject` links to its thumbnail `ImageObject` via schema.org `thumbnail`.

### 3.5 Future Features

- `POST /search`'s write-side (deposits) is out of scope: crates are created/updated only by scanning.
- Events and other contextual facets, extending the facet set the way camera/lens/keyword/people did.
- A face-crop thumbnail per person, not just a labelled box on the full photo.
- Writing an edit back to the original image's own metadata, not just the crate — pending a decision on backup (`_rocphotos/backup`).
- Pet recognition: face-api.js is human-faces-only, so this needs a separate model/pipeline.
- A general-purpose manual tagger: draw an arbitrary box and label it free-text, not limited to MWG's Face/Pet types.
- The RO-Crate MASP profile for this structure is drafted (in the [ro-crate-masp](https://github.com/Language-Research-Technology/ro-crate-masp) repo, `profiles/rocphotos/`): class and property rules for all three crate shapes, validating clean against real crates. Still to do there: describe `oa:identifying` as an entity so a standoff region's motivation can be range-checked, and carry a copy of each `Person` in the faces crate so its `FaceEmbedding`s resolve the way the photo crates' references do.

## 4. Implementation Basics

### 4.1 Application Type

Three modes:

1. **Browser-tab**: entirely in Chrome, no server, file access via the File System Access API; SQLite index built client-side (`sql.js`, same file format as `node:sqlite`). Initial screen (`index.html`/`src/main.js`), **Settings / Find Photos**: a Settings section ("Always process everything on open", a `localStorage` preference; "Write recognized faces back into photo files", per-collection) above Find Photos (Open Directory, then the sub-collection overview tree).
2. **`rocphotos serve`**: a long-running local process serving the same web view and endpoints over `127.0.0.1`, opened in a normal tab. Bootstraps an empty root crate/config on first run rather than requiring a prior CLI scan. Shares its implementation with mode 3.
3. **CLI**: `rocphotos scan`, `export-excel`, `export-album`, `serve`, with full filesystem access via Node.js.

### 4.2 File System Access

The application accesses the local filesystem via the browser's File System Access API: the user grants a directory handle for the session; all reads/writes (crate files, photos, thumbnails) go through it. No files are uploaded to a remote server.

### 4.3 Technology Stack

- **Language:** JavaScript (ES modules).
- **Build tooling:** Vite, consistent with the build framework used by the [collection2crate](https://github.com/Language-Research-Technology/collection2crate) project.
- **RO-Crate handling:** The [`ro-crate`](https://www.npmjs.com/package/ro-crate) npm package (source repository [`ro-crate-js`](https://github.com/Language-Research-Technology/ro-crate-js)) is used for construction, parsing, and validation of RO-Crate metadata.
- **Target runtime:** Google Chrome (or other browsers implementing the File System Access API). No support for legacy browsers is required.

### 4.4 Architecture Constraints

- No backend server or database beyond what it manages itself: persistent state is the selected directory tree, its RO-Crate files, and the SQLite index (Section 3.2) — always regenerable from scratch.
- Where it runs a server (mode 2), it binds to `127.0.0.1` only.
- No photo files or metadata are transmitted to an external service.
- Operates on a single directory tree per session.
- Every crate writer (AROCAPI's `/edit/*`, the faces handler's `/confirm`) reads, modifies in memory, and writes the whole file back — never in place. Two overlapping writes to the same crate can otherwise race and silently lose one; fixed with a process-wide write queue (`src/core/writeQueue.js`) all writers share, serializing every crate write regardless of route.

### 4.5 Testability and Filesystem Abstraction

Core operations (directory traversal, crate boundary detection, EXIF extraction, RO-Crate construction) are pure functions against a minimal filesystem adapter interface (list/read/write), unit-testable and reusable unmodified between the Node CLI (full filesystem access) and the browser SPA.
