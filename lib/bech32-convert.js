// Generic bech32/bech32m codec for re-prefixing addresses across chains.
// No key material, no derivation — a Cosmos SDK address (gno.land
// included) is just a 20-byte hash bech32-encoded with a chain-specific
// human-readable prefix (HRP). Converting to another chain that uses the
// same derivation is purely: decode to raw bytes, discard the source
// prefix, re-encode the same bytes with the target prefix. Verified via
// round-trip: decoding a real gno.land address to bytes, re-encoding with
// a different prefix, decoding that back, and confirming identical bytes.

import { bech32, bech32m } from "../../vendor/scure-base/index.js";
export { bytesToHex, hexToBytes } from "../../vendor/noble-hashes/utils.js";

// Tries plain bech32 first — what gno.land and virtually every Cosmos SDK
// chain uses — and falls back to bech32m (BIP 350, used by Bitcoin
// segwit-v1 and a handful of other specs) only if that fails, since a
// bech32m string always fails bech32's checksum and vice versa. Throws
// the bech32 error on a double failure, since that's the overwhelmingly
// common case for what this tool is actually used for.
export function decodeBech32(str) {
  try {
    const { prefix, bytes } = bech32.decodeToBytes(str);
    return { prefix, bytes, variant: "bech32" };
  } catch (bech32Err) {
    try {
      const { prefix, bytes } = bech32m.decodeToBytes(str);
      return { prefix, bytes, variant: "bech32m" };
    } catch {
      throw bech32Err;
    }
  }
}

export function encodeBech32(prefix, bytes, variant = "bech32") {
  const codec = variant === "bech32m" ? bech32m : bech32;
  return codec.encodeFromBytes(prefix, bytes);
}
