// Live NFT-collection discovery — gno.land has no on-chain NFT registry
// (unlike GRC20's grc20reg) and its tx-indexer can't filter by emitted
// event attributes (confirmed via live GraphQL schema introspection: the
// only queryable fields are getBlocks/getTransactions, filterable on
// message-level fields like pkg_path/caller, not on event attrs) — so
// there's no single query that answers "every collection address X holds
// a token in." The only real way to find every NFT collection on a chain
// is to walk every realm and inspect its source, same technique already
// verified working in ~/gno-observer's own precomputed scan
// (scripts/build-cache.mjs) — this is that technique run live, in-browser.
//
// Heuristic (identical to gno-observer's, not invented fresh): the string
// "grc721"/"grc1155" appears anywhere in the realm's source (import or
// comments/types) AND the realm itself defines a matching function —
// Mint/OwnerOf/TokenURI/SafeTransferFrom — as either a free function or a
// method. Catches vendored/hand-rolled implementations that don't import
// any shared grc721 package (e.g. a collection with its own BasicNFT type)
// as well as ones that do. Imperfect: a wrapper that merely references
// another collection without implementing the standard could still pass,
// and a genuinely non-standard collection that avoids all four function
// names would be missed entirely — same caveats gno-observer already
// carries, not new ones introduced here.

import { abciQuery, mapLimit } from "./gno-rpc.js";

// ~/gno-observer already runs this exact same discovery (its own
// build-cache.mjs, same heuristic below) on a schedule and publishes the
// result as a small per-network file -- reusing it turns "walk every
// realm on chain" into one static-file fetch with zero RPC calls,
// whenever it's reachable. Cross-repo coordination confirmed live
// (2026-08-16): gno-observer added data/<net>-nft-realms.json alongside
// its existing <net>-nft-images.json specifically for this. Keyed by
// chainId, not gno-tools' own NETWORKS key (which calls sapphire-1
// "testnet") -- chainId is the one identity both projects agree on.
// gno-observer's own now-sunset "testnet" (topaz-1) is deliberately not
// listed here -- gno-tools never queries that chain.
const OBSERVER_BASE = "https://gno.observer/data";
const OBSERVER_NET_BY_CHAIN_ID = { "sapphire-1": "sapphire", "gnoland1": "betanet" };

async function fetchSharedNftRealms(chainId) {
  const netKey = OBSERVER_NET_BY_CHAIN_ID[chainId];
  if (!netKey) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(`${OBSERVER_BASE}/${netKey}-nft-realms.json`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) return null;
    return data.map((r) => ({ path: r.path, name: r.name || r.path.split("/").pop(), symbol: r.symbol || undefined }));
  } catch {
    // Any failure here -- the file not shipped yet, a network hiccup,
    // CORS, an unexpected shape -- just means "fall back to the real walk
    // below", not a hard error the caller needs to handle.
    return null;
  }
}

const NFT_FUNC_RE = /\bfunc\s*(\(\s*\w+\s+\*?\w+\s*\)\s*)?(Mint\w*|OwnerOf|TokenURI|SafeTransferFrom)\s*\(/;
const GRC_MENTION_RE = /grc721|grc1155/i;

async function listFiles(net, pkgPath) {
  try {
    const raw = await abciQuery(net, "vm/qfile", pkgPath);
    if (!raw) return [];
    return raw.split("\n").map((f) => f.trim()).filter((f) => f.endsWith(".gno") && !f.endsWith("_test.gno") && !f.endsWith("_filetest.gno"));
  } catch {
    return [];
  }
}

async function fetchSource(net, pkgPath, file) {
  try {
    return await abciQuery(net, "vm/qfile", `${pkgPath}/${file}`);
  } catch {
    return "";
  }
}

async function looksLikeNftRealm(net, pkgPath) {
  const files = await listFiles(net, pkgPath);
  if (!files.length) return false;
  // Concatenated, not per-file — a real collection sometimes spreads the
  // grc721 mention (e.g. an import comment) and the function definitions
  // across separate files in the same package.
  const sources = await Promise.all(files.map((f) => fetchSource(net, pkgPath, f)));
  const combined = sources.join("\n");
  return GRC_MENTION_RE.test(combined) && NFT_FUNC_RE.test(combined);
}

function parseGnoStringEval(raw) {
  const m = /^\("(.*)"\s+string\)/.exec((raw || "").trim());
  return m ? m[1] : null;
}

// Name()/Symbol() aren't guaranteed by the GRC721 standard, but every real
// collection seen on-chain so far implements both — a miss just falls
// back to the bare path/last segment rather than blocking the result.
async function fetchNameSymbol(net, pkgPath) {
  const [nameRaw, symRaw] = await Promise.all([
    abciQuery(net, "vm/qeval", `${pkgPath}.Name()`).catch(() => null),
    abciQuery(net, "vm/qeval", `${pkgPath}.Symbol()`).catch(() => null),
  ]);
  return { name: parseGnoStringEval(nameRaw), symbol: parseGnoStringEval(symRaw) };
}

// Walks every realm on the given network and returns the ones that look
// like NFT collections, as {path, name, symbol}. Tries gno-observer's own
// precomputed, scheduled scan first (see fetchSharedNftRealms above) —
// only falls back to the real (expensive, full-chain) walk below if
// that's unavailable for any reason. onProgress(checked, total) fires as
// each realm's heuristic check completes, in no particular order
// (mapLimit runs them concurrently) — only relevant to the one-time cost
// of an uncached fallback scan; never fires when the shared cache hits.
export async function discoverNftCollections(net, { onProgress, concurrency = 8 } = {}) {
  const shared = await fetchSharedNftRealms(net.chainId);
  if (shared) return shared;

  const pathList = await abciQuery(net, "vm/qpaths", "gno.land/r/");
  const paths = (pathList || "").split("\n").map((p) => p.trim()).filter(Boolean);

  let checked = 0;
  const hits = [];
  await mapLimit(paths, concurrency, async (pkgPath) => {
    const isNft = await looksLikeNftRealm(net, pkgPath);
    checked++;
    onProgress?.(checked, paths.length);
    if (isNft) hits.push(pkgPath);
  });

  return mapLimit(hits, 6, async (pkgPath) => {
    const meta = await fetchNameSymbol(net, pkgPath);
    return { path: pkgPath, name: meta.name || pkgPath.split("/").pop(), symbol: meta.symbol || undefined };
  });
}
