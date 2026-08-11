// gno.land key/address derivation — runs entirely client-side, no network
// calls anywhere in this module. Standard verified against gno's own source
// (~/gno-src/gno): RIPEMD160(SHA256(compressed secp256k1 pubkey)) bech32-
// encoded with human prefix "g" (tm2/pkg/crypto/secp256k1/secp256k1.go,
// tm2/pkg/crypto/globals.go), mnemonic modes use the standard Cosmos HD
// path m/44'/118'/0'/0/0 (tm2/pkg/crypto/keys/client/add.go). Cross-checked
// end-to-end against the real `gnokey` binary: the well-known public test
// mnemonic ("abandon"x11 + "about") reproduces the exact same address
// gnokey itself derives, g19rl4cm2hmr8afy4kldpxz3fka4jguq0a0u3773.

import { generateMnemonic, mnemonicToSeedSync } from "../../vendor/scure-bip39/index.js";
import { wordlist } from "../../vendor/scure-bip39/wordlists/english.js";
import { HDKey } from "../../vendor/scure-bip32/index.js";
import { secp256k1 } from "../../vendor/noble-curves/secp256k1.js";
import { sha256 } from "../../vendor/noble-hashes/sha2.js";
import { ripemd160 } from "../../vendor/noble-hashes/legacy.js";
import { bytesToHex } from "../../vendor/noble-hashes/utils.js";
import { bech32 } from "../../vendor/scure-base/index.js";

export const ADDRESS_HRP = "g";
export const DERIVATION_PATH = "m/44'/118'/0'/0/0";

// BIP173 bech32 alphabet, confirmed against gno's own tm2/pkg/bech32 (which
// implements the same table) — 32 lowercase symbols, no 1/b/i/o.
export const ADDRESS_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

// 20-byte address -> 32 data words (ceil(160/5)) + 6 checksum chars, after
// the fixed "g1" prefix.
export const ADDRESS_BODY_LENGTH = 38;

function addressFromPubKey(compressedPubKey) {
  const hash = ripemd160(sha256(compressedPubKey));
  return bech32.encode(ADDRESS_HRP, bech32.toWords(hash));
}

/**
 * mode: "12" | "24" | "key"
 * Returns { secretType: "mnemonic" | "key", secret, address }.
 */
export function generateWallet(mode) {
  if (mode === "key") {
    const { secretKey, publicKey } = secp256k1.keygen();
    return {
      secretType: "key",
      secret: bytesToHex(secretKey),
      address: addressFromPubKey(publicKey),
    };
  }

  const strength = mode === "24" ? 256 : 128;
  const mnemonic = generateMnemonic(wordlist, strength);
  const seed = mnemonicToSeedSync(mnemonic);
  const child = HDKey.fromMasterSeed(seed).derive(DERIVATION_PATH);
  return {
    secretType: "mnemonic",
    secret: mnemonic,
    address: addressFromPubKey(child.publicKey),
  };
}

// Loose "does this look like a gno.land address" check for input
// validation — a length/prefix/charset sanity check, not a full bech32
// checksum verification. Shared by any page that accepts a typed/pasted
// destination address (pay.html, batch-send.html).
const PLAUSIBLE_ADDRESS_RE = /^g1[a-z0-9]{20,60}$/;
export function isPlausibleAddress(str) {
  return PLAUSIBLE_ADDRESS_RE.test(str);
}

// Validates a vanity target string against gno.land's bech32 alphabet.
// Returns { clean, invalidChars } — `clean` is lowercased and safe to
// search with; `invalidChars` lists any rejected characters for feedback.
export function validateTarget(raw) {
  const clean = [];
  const invalidChars = new Set();
  for (const ch of raw.toLowerCase()) {
    if (ADDRESS_CHARSET.includes(ch)) clean.push(ch);
    else if (ch.trim() !== "") invalidChars.add(ch);
  }
  return { clean: clean.join(""), invalidChars: [...invalidChars] };
}

// position: "start" | "end" | "anywhere". Matches against the address body
// only (i.e. after the fixed "g1" prefix, which isn't a real vanity match).
export function matchesTarget(address, target, position) {
  if (!target) return true;
  const body = address.slice(2);
  if (position === "start") return body.startsWith(target);
  if (position === "end") return body.endsWith(target);
  return body.includes(target);
}

// Expected number of attempts to find a match, given target length and
// position — pure probability, no benchmark needed.
export function estimateAttempts(targetLength, position) {
  if (targetLength === 0) return 1;
  const space = Math.pow(ADDRESS_CHARSET.length, targetLength);
  if (position !== "anywhere") return space;
  const positions = Math.max(1, ADDRESS_BODY_LENGTH - targetLength + 1);
  return space / positions;
}
