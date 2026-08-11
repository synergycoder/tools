# Vendored crypto libraries

Copied verbatim from npm (no hand-edited import paths) — used by the vanity
address generator to derive real secp256k1 keys and gno.land (`g1...`)
addresses entirely client-side. All MIT-licensed; see each package's own
`LICENSE` file. Cross-package imports (e.g. `@noble/hashes/sha2.js`) are
resolved via the import map in `tools/vanity-address.html` and
`tools/lib/vanity-worker.js` — nothing here has been rewritten.

| package | version | source |
|---|---|---|
| `@scure/base` | 2.0.0 | https://www.npmjs.com/package/@scure/base |
| `@scure/bip32` | 2.2.0 | https://www.npmjs.com/package/@scure/bip32 |
| `@scure/bip39` | 2.2.0 | https://www.npmjs.com/package/@scure/bip39 |
| `@noble/hashes` | 2.2.0 | https://www.npmjs.com/package/@noble/hashes |
| `@noble/curves` | 2.0.0 | https://www.npmjs.com/package/@noble/curves |

Only the files actually reachable from `@scure/bip39`, `@scure/bip32`,
`@noble/curves/secp256k1.js`, and `@scure/base`'s entry points were copied
(traced via each file's own `import` statements) — not full package
contents. `@scure/bip39`'s non-English wordlists were skipped; only
`wordlists/english.js` is used.

`noble-hashes/sha3.js` was added later (same `2.2.0`, fetched from
`unpkg.com/@noble/hashes@2.2.0/sha3.js`) for `tools/lib/multi-chain-address.js`'s
Ethereum address derivation (`keccak_256`) — it already only imports
`./_u64.js` and `./utils.js`, both already present here.
