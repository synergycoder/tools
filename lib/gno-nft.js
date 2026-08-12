// NFT detection for gno.land wallets — read-only, no keys, no signing.
//
// There's no universal NFT registry on gno.land and GRC721 has no
// standard "tokens of owner" query, so this can only report holdings for
// collections it already knows about (see nft-discovery.js for how that
// list is built and kept current) and can only enumerate specific token
// IDs when a collection happens to emit
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

// There's no totalSupply()/tokenByIndex() standard, but a realm's own
// Render() markdown often states a supply/minted count in prose (no
// standard field name — confirmed live: one collection writes "Total
// supply: 2", another "Minted: 3 / 20"). Best-effort scan-range hint
// only — never trusted for anything else, and a miss just means the
// brute-force scan below falls back to its full default range.
async function fetchMintedCountHint(net, collectionPath) {
  try {
    const raw = await abciQuery(net, "vm/qrender", `${collectionPath}:`);
    if (!raw) return null;
    const m = /(?:total supply|minted)\s*[:*]*\s*(\d+)/i.exec(raw);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

// collectionPath -> "int" | "string", learned the first time OwnerOf
// actually succeeds for that collection so every id after the first
// doesn't have to try both argument forms.
const ownerOfArgFormat = new Map();

// Fallback for when fetchOwnedTokenIds finds nothing (its event-log
// replay is best-effort — a collection is free to not emit exactly
// Mint/Transfer/Burn with a tokenId attribute, and confirmed live that
// some collections' Mint calls are routed through a separate minter
// realm entirely, meaning the *storage* realm's own transaction history
// has zero relevant events even though it's the real GRC721 contract).
// OwnerOf(id) is part of the standard GRC721 surface and reads *current*
// ownership directly, no event-log guessing involved — confirmed live:
// gno.land/r/.../solarmint's OwnerOf(0)/OwnerOf(2)/OwnerOf(3) all
// resolved correctly, matching BalanceOf. Ids start at 0 (confirmed
// live), and the int-vs-string argument-type inconsistency is the same
// one fetchOwnedTokenMetadata already has to handle for TokenURI.
export async function bruteForceOwnedTokenIds(net, collectionPath, ownerAddress, targetCount, opts = {}) {
  const { maxScan = 80, onProgress } = opts;
  const hint = await fetchMintedCountHint(net, collectionPath);
  const scanCount = Math.min(hint != null ? hint + 5 : maxScan, maxScan);
  const ids = Array.from({ length: scanCount }, (_, i) => i);
  const found = [];
  let checked = 0;
  const knownFormat = ownerOfArgFormat.get(collectionPath);
  const literalsFor = (id) =>
    knownFormat === "string" ? [`"${id}"`] : knownFormat === "int" ? [String(id)] : [String(id), `"${id}"`];

  await mapLimit(ids, 10, async (id) => {
    if (found.length < targetCount) {
      for (const literal of literalsFor(id)) {
        try {
          const raw = await abciQuery(net, "vm/qeval", `${collectionPath}.OwnerOf(${literal})`);
          const m = /"(g1[a-z0-9]+)"\s*\.uverse\.address/.exec(raw || "");
          if (m) {
            if (!knownFormat) ownerOfArgFormat.set(collectionPath, literal.startsWith('"') ? "string" : "int");
            if (m[1] === ownerAddress) found.push(String(id));
            break;
          }
        } catch {
          // this id/literal combination doesn't exist — try the next one
        }
      }
    }
    checked++;
    if (onProgress) onProgress(checked, ids.length);
  });
  return found.sort((a, b) => Number(a) - Number(b));
}

function decodeBase64Utf8(b64) {
  return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
}

// Gno's qeval formatter renders a string value using Go string-literal
// escaping (\" \\ \n \t ...) — confirmed live that a naive `[^"]*` capture
// truncates at the *first* embedded quote, silently failing for any
// string containing one. solarmint's TokenURI returns raw JSON text
// (see parseMetadataURI below), which is full of escaped quotes around
// every key/value — this was the actual reason its previews never loaded
// even though the RPC response itself always came back complete and
// correct.
function unescapeGnoString(s) {
  return s.replace(/\\(.)/g, (_, c) => ({ n: "\n", t: "\t", r: "\r" }[c] ?? c));
}

function encodeBase64Utf8(s) {
  return btoa(unescape(encodeURIComponent(s)));
}

function normalizeImageUri(uri) {
  if (!uri) return null;
  if (uri.startsWith("ipfs://")) return `https://ipfs.io/ipfs/${uri.slice(7)}`;
  // Some on-chain SVG artwork omits the xmlns declaration a standalone
  // SVG document technically needs — confirmed live against a real held
  // token that the image data itself was always complete and valid
  // (decodes to well-formed SVG), but several browsers refuse to
  // rasterize it inside <img src="data:image/svg+xml..."> without an
  // explicit xmlns present, so it was rendering as a broken thumbnail
  // even though nothing was actually wrong with the fetched data.
  const svgMatch = /^data:image\/svg\+xml;base64,(.+)$/.exec(uri);
  if (svgMatch) {
    try {
      const svg = decodeBase64Utf8(svgMatch[1]);
      if (/^\s*<svg\b/i.test(svg) && !/<svg[^>]*\bxmlns=/i.test(svg)) {
        const patched = svg.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
        return `data:image/svg+xml;base64,${encodeBase64Utf8(patched)}`;
      }
    } catch {
      // if it doesn't decode cleanly, hand back the original untouched
    }
  }
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
  // Not every realm follows the data:application/json;base64 convention —
  // confirmed live that solarmint's TokenURI returns the metadata JSON as
  // plain, unwrapped text (no data-URI prefix at all).
  const trimmed = uri.trim();
  if (trimmed.startsWith("{")) {
    try {
      const json = JSON.parse(trimmed);
      return {
        image: normalizeImageUri(json.image),
        name: json.name || null,
        description: json.description || null,
        externalUrl: json.external_url || null,
      };
    } catch {
      // not valid JSON either — fall through to the plain-URI case below
    }
  }
  if (/^(ipfs:|https?:|data:image\/)/.test(uri)) {
    return { image: normalizeImageUri(uri), name: null, description: null, externalUrl: null };
  }
  return null;
}

// collectionPath -> true once GetTokenURI/TokenURI have failed for any
// token in that collection — confirmed live that a broken/absent
// TokenURI is a per-collection trait, not a per-token fluke, so every
// token after the first no longer wastes 4 doomed RPC calls (2 fn names
// x 2 literal forms) before falling through to TokenMetadata. That
// redundant load was very likely why previews loaded inconsistently
// ("first thumbnail loads, second doesn't") — a public RPC node under
// several near-simultaneous requests per token just drops some.
const tokenUriUnsupported = new Set();

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
  if (!tokenUriUnsupported.has(collectionPath)) {
    let found = false;
    for (const fn of ["GetTokenURI", "TokenURI"]) {
      for (const literal of literals) {
        try {
          const raw = await abciQuery(net, "vm/qeval", `${collectionPath}.${fn}(${literal})`);
          const firstLine = (raw || "").trim().split("\n")[0];
          const m = /^\("((?:[^"\\]|\\.)*)" string\)$/.exec(firstLine);
          if (!m) continue;
          const meta = parseMetadataURI(unescapeGnoString(m[1]));
          if (meta) { found = true; return { tokenId, ...meta }; }
        } catch {
          // try the next literal form / function name
        }
      }
    }
    if (!found) tokenUriUnsupported.add(collectionPath);
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
      const fields = [...firstLine.matchAll(/\((?:"((?:[^"\\]|\\.)*)")?\s*string\)/g)].map((mm) => (mm[1] != null ? unescapeGnoString(mm[1]) : ""));
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
