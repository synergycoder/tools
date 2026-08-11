// NFT detection for gno.land wallets — read-only, no keys, no signing.
//
// There's no universal NFT registry on gno.land and GRC721 has no
// standard "tokens of owner" query, so this can only report holdings for
// collections it already knows about (see data/nft-realms.json) and can
// only enumerate specific token IDs when a collection happens to emit
// Mint/Transfer/Burn events with a tokenId attribute — neither is
// guaranteed. This approach (and every function here) mirrors the one
// already verified working in the sibling ~/gno-observer project, not
// invented fresh — see that project's index.html for the original.
//
// BalanceOf(address) itself is reliable — confirmed live against a
// wallet independently known to hold exactly one gingernft2 token.

import { abciQuery, graphqlQuery, mapLimit } from "./gno-rpc.js";

function parseGnoEvalNumber(raw) {
  const m = /^\((-?\d+)/.exec((raw || "").trim());
  return m ? Number(m[1]) : null;
}

// Reliable — every GRC721-standard collection implements this.
export async function checkNftBalance(net, collectionPath, address) {
  const raw = await abciQuery(net, "vm/qeval", `${collectionPath}.BalanceOf("${address}")`);
  return parseGnoEvalNumber(raw);
}

// Best-effort. Replays a collection's own Mint/Transfer/Burn indexer
// events into a tokenId -> current-owner map, then filters to the
// address asked about. A collection that doesn't emit these exact event
// names/attrs (not guaranteed by the GRC721 standard) yields an empty
// result here even if checkNftBalance() shows it's genuinely held —
// callers should treat an empty array as "couldn't enumerate", not
// "holds nothing", whenever the balance check says otherwise.
export async function fetchOwnedTokenIds(net, collectionPath, ownerAddress) {
  const query = `query { getTransactions(where: {
    success: { eq: true },
    messages: { value: { MsgCall: { pkg_path: { eq: "${collectionPath}" } } } }
  }) { block_height response { events { __typename ... on GnoEvent { type attrs { key value } } } } } }`;
  const data = await graphqlQuery(net, query);
  const txs = [...(data.getTransactions || [])].sort((a, b) => a.block_height - b.block_height);

  const owners = new Map();
  for (const tx of txs) {
    for (const ev of tx.response?.events || []) {
      if (ev.__typename !== "GnoEvent") continue;
      if (!["Mint", "Transfer", "Burn"].includes(ev.type)) continue;
      const attrs = Object.fromEntries((ev.attrs || []).map((a) => [a.key, a.value]));
      if (!attrs.tokenId) continue;
      if (ev.type === "Burn") owners.delete(attrs.tokenId);
      else if (attrs.to) owners.set(attrs.tokenId, attrs.to);
    }
  }
  return [...owners.entries()].filter(([, owner]) => owner === ownerAddress).map(([tokenId]) => tokenId).sort();
}

// Fallback for when fetchOwnedTokenIds finds nothing (its event-log
// replay is best-effort — a collection is free to not emit exactly
// Mint/Transfer/Burn with a tokenId attribute). OwnerOf(id) is part of
// the standard GRC721 surface and reads *current* ownership directly, no
// event-log guessing involved — confirmed live against a real held
// wallet: gno.land/r/.../solarmint's OwnerOf(2)/OwnerOf(3) correctly
// returned the same owner address BalanceOf already reported holding 2
// of. There's no totalSupply()/tokenByIndex() standard to know the real
// id range up front, so this just scans a bounded window of small
// integer ids (every collection checked so far numbers tokens this way)
// and stops collecting once targetCount owned tokens are found.
export async function bruteForceOwnedTokenIds(net, collectionPath, ownerAddress, targetCount, maxScan = 150) {
  const found = [];
  const ids = Array.from({ length: maxScan }, (_, i) => i + 1);
  await mapLimit(ids, 8, async (id) => {
    if (found.length >= targetCount) return;
    try {
      const raw = await abciQuery(net, "vm/qeval", `${collectionPath}.OwnerOf(${id})`);
      const m = /"(g1[a-z0-9]+)"\s*\.uverse\.address/.exec(raw || "");
      if (m && m[1] === ownerAddress) found.push(String(id));
    } catch {
      // id doesn't exist, or OwnerOf isn't implemented on this collection
    }
  });
  return found.sort((a, b) => Number(a) - Number(b));
}

function decodeBase64Utf8(b64) {
  return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
}

function normalizeImageUri(uri) {
  if (!uri) return null;
  if (uri.startsWith("ipfs://")) return `https://ipfs.io/ipfs/${uri.slice(7)}`;
  return uri;
}

function parseMetadataURI(uri) {
  if (!uri) return null;
  const dataMatch = /^data:application\/json;base64,(.+)$/.exec(uri);
  if (dataMatch) {
    try {
      const json = JSON.parse(decodeBase64Utf8(dataMatch[1]));
      return {
        image: normalizeImageUri(json.image),
        name: json.name || null,
        description: json.description || null,
        externalUrl: json.external_url || null,
      };
    } catch {
      return null;
    }
  }
  if (/^(ipfs:|https?:|data:image\/)/.test(uri)) {
    return { image: normalizeImageUri(uri), name: null, description: null, externalUrl: null };
  }
  return null;
}

// Tries GetTokenURI/TokenURI (a JSON-metadata or direct-image URI), then
// falls back to a plain TokenMetadata() struct for collections that
// expose one directly instead. Never throws — a collection matching
// neither convention just yields nulls, rendered as a placeholder by the
// caller rather than treated as an error.
export async function fetchOwnedTokenMetadata(net, collectionPath, tokenId) {
  // Argument type isn't standardized — confirmed live that some
  // collections declare tokenId as a string, others (e.g. solarmint) as
  // an int64 (a bare-string literal there fails preprocessing with
  // "cannot use untyped string as Int64Kind"). Try both rather than
  // guessing wrong and silently getting no preview image.
  const literals = [JSON.stringify(String(tokenId))];
  if (/^-?\d+$/.test(String(tokenId))) literals.push(String(Number(tokenId)));
  for (const fn of ["GetTokenURI", "TokenURI"]) {
    for (const literal of literals) {
      try {
        const raw = await abciQuery(net, "vm/qeval", `${collectionPath}.${fn}(${literal})`);
        const firstLine = (raw || "").trim().split("\n")[0];
        const m = /^\("([^"]*)" string\)$/.exec(firstLine);
        if (!m) continue;
        const meta = parseMetadataURI(m[1]);
        if (meta) return { tokenId, ...meta };
      } catch {
        // try the next literal form / function name
      }
    }
  }
  for (const literal of literals) {
    try {
      const raw = await abciQuery(net, "vm/qeval", `${collectionPath}.TokenMetadata(${literal})`);
      const firstLine = (raw || "").trim().split("\n")[0];
      // grc721.Metadata field order: Image, ImageData, ExternalURL, Description,
      // Name, Attributes, BackgroundColor, AnimationURL, YoutubeURL — an empty
      // string field prints as `( string)` with no quotes at all, so the
      // capture group has to stay optional or every field after the first
      // empty one shifts left (confirmed against gno-observer's own decoding).
      const fields = [...firstLine.matchAll(/\((?:"([^"]*)")?\s*string\)/g)].map((mm) => mm[1] ?? "");
      if (fields.length) {
        return {
          tokenId,
          image: normalizeImageUri(fields[0]),
          externalUrl: fields[2] || null,
          description: fields[3] || null,
          name: fields[4] || null,
        };
      }
    } catch {
      // try the next literal form
    }
  }
  // no metadata convention worked for this collection
  return { tokenId, image: null, name: null, description: null, externalUrl: null };
}
