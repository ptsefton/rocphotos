This application is an RO-Crate based photo manager, described in the [specification](./Spec.md)

It's experimental. Back up your photos first.

## In Chrome

Go to <https://ptsefton.com/rocphotos/> and pick a folder of photos. Nothing gets uploaded; it all runs in the browser.

## Install

You need Node 24 or later.

```sh
git clone https://github.com/ptsefton/rocphotos.git
cd rocphotos
npm install
```

## Run it as a server

```sh
npx rocphotos serve ~/Pictures/my-photos
```

Then open <http://127.0.0.1:8420>. If the folder hasn't been scanned yet it'll take you to the Scan screen.

## Command line

```sh
npx rocphotos scan ~/Pictures/my-photos
npx rocphotos export-album ~/Pictures/my-photos "Beach trip"
npx rocphotos export-excel ~/Pictures/my-photos
```

Run `npx rocphotos` on its own for the full list of options.

## License

Apache 2.0, see [LICENSE](LICENSE).
