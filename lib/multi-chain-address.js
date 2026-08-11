// Derives a wallet's address on every chain this site's "My Wallets"
// tool supports, from the same gnokey-keyring pubkey — no private key,
// mnemonic, or password ever touches this file. See tools/my-wallets.html
// and vendor/MANIFEST.md for how each piece was verified against a real
// gnokey oracle before being trusted here.

import { decodeBech32, encodeBech32 } from "./bech32-convert.js";
import { sha256 } from "../../vendor/noble-hashes/sha2.js";
import { ripemd160 } from "../../vendor/noble-hashes/legacy.js";
import { keccak_256 } from "../../vendor/noble-hashes/sha3.js";
import { createBase58check } from "../../vendor/scure-base/index.js";
import { secp256k1 } from "../../vendor/noble-curves/secp256k1.js";

// `gnokey list`'s "pub: gpub1..." field decodes to a 58-byte protobuf
// `Any` wrapper — type_url "/tm.PubKeySecp256k1" plus a nested field
// around the real 33-byte compressed key. Verified live against a real
// keyring entry (not assumed): decoding a real gpub1... value, taking
// its last 33 bytes, and running RIPEMD160(SHA256(...)) on them
// reproduced that same key's real g1... address byte-for-byte — so this
// fixed-offset slice is a confirmed-correct extraction, not a guess.
// Sanity-checked every time regardless, so a future non-secp256k1 gno.land
// key type fails loudly here instead of silently producing a wrong address.
export function extractRawPubkey(pubkeyBech32) {
  let bytes;
  try {
    ({ bytes } = decodeBech32(pubkeyBech32));
  } catch (err) {
    return { pubkey: null, error: `Couldn't decode pubkey: ${err.message}` };
  }
  if (bytes.length !== 58) {
    return { pubkey: null, error: `Unexpected pubkey blob length ${bytes.length} (expected 58 for a secp256k1 key) — this may not be a secp256k1 key.` };
  }
  const raw = bytes.slice(-33);
  if (raw[0] !== 0x02 && raw[0] !== 0x03) {
    return { pubkey: null, error: `Unexpected leading byte 0x${raw[0].toString(16)} — not a valid compressed secp256k1 key.` };
  }
  return { pubkey: raw, error: null };
}

// Every Cosmos SDK chain (gno.land included) derives its address the
// same way: secp256k1 pubkey -> RIPEMD160(SHA256(pubkey)) -> bech32 with
// a chain-specific prefix. Re-encoding an already-known gno.land address
// under another prefix (rather than re-hashing the pubkey) is exactly
// what tools/lib/bech32-convert.js already does, reused verbatim here.
export function deriveCosmosAddress(gnoAddress, prefix) {
  const { bytes } = decodeBech32(gnoAddress);
  return encodeBech32(prefix, bytes);
}

// Bitcoin P2PKH (legacy, mainnet): base58check(0x00 ++ RIPEMD160(SHA256(pubkey))).
// createBase58check applies Bitcoin's exact double-SHA256 checksum (see
// vendor/scure-base/index.js's own docstring) — the caller supplies the
// version byte as part of the payload, done here via the 0x00 prefix.
export function deriveBtcAddress(rawPubkey) {
  const hash160 = ripemd160(sha256(rawPubkey));
  const payload = new Uint8Array(1 + hash160.length);
  payload[0] = 0x00;
  payload.set(hash160, 1);
  return createBase58check(sha256).encode(payload);
}

// Ethereum: decompress the 33-byte pubkey to the 65-byte uncompressed
// form (0x04 ++ X ++ Y), keccak256 of the 64-byte X||Y (dropping the
// 0x04 marker), last 20 bytes, hex-encoded with an EIP-55 mixed-case
// checksum derived from keccak256 of the lowercase hex address itself.
export function deriveEthAddress(rawPubkey) {
  const uncompressed = secp256k1.Point.fromBytes(rawPubkey).toBytes(false); // 65 bytes: 0x04 || X || Y
  const hash = keccak_256(uncompressed.slice(1));
  const addrBytes = hash.slice(-20);
  const addrHex = [...addrBytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const checksumHash = keccak_256(new TextEncoder().encode(addrHex));
  let checksummed = "";
  for (let i = 0; i < addrHex.length; i++) {
    const c = addrHex[i];
    if (/[a-f]/.test(c)) {
      // EIP-55: nibble i of the checksum hash >= 8 -> uppercase this hex char.
      const nibble = (checksumHash[i >> 1] >> (i % 2 === 0 ? 4 : 0)) & 0xf;
      checksummed += nibble >= 8 ? c.toUpperCase() : c;
    } else {
      checksummed += c;
    }
  }
  return "0x" + checksummed;
}

// Solana addresses are ed25519 public keys, base58-encoded directly — a
// completely different key type from the secp256k1 keys gno.land, every
// Cosmos chain, Bitcoin, and Ethereum all use here. There is no valid
// derivation from a secp256k1 key to an ed25519 one; this isn't a gap to
// fill later, it's a real cryptographic dead end for this wallet type.
export const SOLANA_UNAVAILABLE_REASON = "not derivable — needs an ed25519 key (gno.land wallets are secp256k1)";
