# Third-party code

## T3 Code

`vendor/t3/` holds an unmodified subset of [T3 Code](https://github.com/pingdotgg/t3code)
(the `contracts`, `client-runtime` and `shared` packages and the small packages they import),
copied at the tag named in `vendor/t3/UPSTREAM` by `scripts/sync-upstream`. Only the package
manifests are trimmed, and `vendor/t3/exports-patch.json` adds three subpath exports for
files upstream already ships.

T3 Code is copyright (c) 2026 T3 Tools Inc. and released under the MIT License. The full
license text is in `vendor/t3/LICENSE`.

## Bundled packages

`dist/tercet.js`, the file a global install runs, is built by `scripts/build` and inlines these
packages along with the vendored T3 code above. All are under the MIT License (per their
`package.json`); after `bun install`, most ship the full text in `node_modules/<package>/LICENSE`.

| Package               | Version | Copyright                           |
| --------------------- | ------- | ----------------------------------- |
| `react`               | 19.3.0  | Meta Platforms, Inc. and affiliates |
| `react-reconciler`    | 0.33.0  | Meta Platforms, Inc. and affiliates |
| `scheduler`           | 0.27.0  | Meta Platforms, Inc. and affiliates |
| `react-devtools-core` | 7.0.1   | Meta Platforms, Inc. and affiliates |
| `@opentui/react`      | 0.8.3   | opentui                             |
| `effect`              | 4.1.2   | Effectful Technologies Inc.         |
| `@xterm/headless`     | 6.0.0   | the xterm.js authors                |
| `@noble/hashes`       | 1.8.0   | Paul Miller                         |

`@opentui/core` is not bundled; Bun installs it next to tercet as a normal dependency.

This project is a community client. It is not made or endorsed by T3 Tools Inc.
