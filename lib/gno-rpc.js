// Read-only gno.land chain access — no keys, no signing, no writes.
// Ported from the proven implementation in ~/gno-observer/index.html
// (abciQuery, mapLimit, grc20reg parsing) rather than re-derived.

export const NETWORKS = {
  testnet: {
    label: "sapphire-1 (testnet)",
    rpcUrl: "https://rpc.sapphire.testnets.gno.land",
    // Fallback pool for when the official endpoint is down -- confirmed
    // happening for a full day straight, 2026-08-16/17. Community-run
    // nodes shared in gno.land's own Telegram (no official list exists),
    // vetted 2026-08-16: real chain-id + block height/time agreement
    // with the official node (within a few seconds of each other, hard
    // to fake since it's consensus-committed), a working vm/qeval, and
    // cross-referenced against gno-validator.nodesync.top's public
    // sapphire-1 validator set. Two other candidates that came from the
    // same source (gnoland-sapphire-rpc.luckystar.asia and
    // .oshvank.xyz) are deliberately excluded here -- confirmed live
    // (curl -D -) that both send a DUPLICATED Access-Control-Allow-Origin
    // header, which a real browser's CORS check rejects outright even
    // though curl and server-side/Node callers don't care. This file is
    // browser-only, so only the two that send a single clean header are
    // listed. abciQuery tries these in order (after the official
    // endpoint, or first if it was the last one to actually work) --
    // see abciQuery's own doc comment. Re-verify both checks (chain-id/
    // height agreement, single clean ACAO header) before adding a new
    // candidate here.
    rpcFallbackUrls: [
      "https://gnoland-sapphire-rpc.corenodehq.xyz",
      "https://gnoland-sapphire-rpc.hazennetworksolutions.com",
    ],
    chainId: "sapphire-1",
    // Unlike betanet's indexer, this one sends real CORS headers
    // (confirmed live: access-control-allow-origin: *) — no proxy needed.
    indexerUrl: "https://indexer.sapphire.testnets.gno.land/graphql/query",
  },
  betanet: {
    label: "gnoland1 (betanet)",
    rpcUrl: "https://rpc.gno.land",
    chainId: "gnoland1",
    // Betanet's own indexer (indexer.gno.land) sends no CORS headers at
    // all (confirmed live — the preflight succeeds but the real response
    // never carries Access-Control-Allow-Origin), so a browser can't
    // query it directly. This is the same DreamHost-hosted proxy
    // ~/gno-observer already uses for the same reason — it only ever
    // forwards to this one hardcoded indexer URL, so it isn't a
    // general-purpose open proxy.
    indexerUrl: "https://indexer.gno.land/graphql/query",
    indexerProxyUrl: "https://gno-proxy.tardigradesnft.com/gno-betanet-proxy.php",
  },
};

// Maps a chainId as reported live by a connected wallet (e.g. Adena's
// GetAccount().chainId) back to a NETWORKS key. Returns null for anything
// unrecognized — deliberately no guessing, since a page building a real
// transaction needs to know for certain which chain it's targeting.
export function networkForChainId(chainId) {
  for (const [key, net] of Object.entries(NETWORKS)) {
    if (net.chainId === chainId) return key;
  }
  return null;
}

// Broader than NETWORKS above: every gno.land chainId a connected wallet
// might actually report, including ones no single tool here queries by
// default (e.g. a wallet still connected to topaz-1, which nothing here
// queries anymore) — this is only for the shared header's "which chain is
// my wallet on" display + native-balance lookup, not for picking which
// chain a tool reads from.
export const CHAIN_INFO = {
  "topaz-1": { label: "Testnet (topaz-1)", short: "Topaz", rpcUrl: "https://rpc.topaz.testnets.gno.land" },
  "sapphire-1": { label: "Testnet (sapphire-1)", short: "Sapphire", rpcUrl: "https://rpc.sapphire.testnets.gno.land" },
  "gnoland1": { label: "Mainnet-beta (gnoland1)", short: "Mainnet", rpcUrl: "https://rpc.gno.land" },
};

export function chainInfoFor(chainId) {
  return CHAIN_INFO[chainId] || { label: chainId || "Unknown chain", short: chainId || "Unknown", rpcUrl: null };
}

// Plain atob() decodes base64 into a "binary string" -- one JS char per
// BYTE, not per Unicode code point. Fine for ASCII-only payloads (data
// URIs, hex colors, plain identifiers), but silently mangles anything
// with a multi-byte UTF-8 character (an em-dash's 3 bytes become 3
// separate mis-mapped Latin-1 chars, e.g. "—" -> "â€"") -- confirmed
// live: a real gems-mint.html gallery name garbled exactly this way.
// escape()+decodeURIComponent() is the standard (if old-fashioned, pre-
// TextDecoder) trick to reinterpret those raw bytes as UTF-8 correctly.
// Always safe to use even on ASCII-only input, so this replaces bare
// atob() everywhere a decoded value might contain non-ASCII text.
export function b64ToUtf8(b64) {
  return decodeURIComponent(escape(atob(b64)));
}

// Builds the "the RPC endpoint itself is the problem" error -- tagged
// with isEndpointUnreachable/endpoint so callers (see gems-mint.html's
// showEndpointUnreachableBanner) can show a clear, specific message
// instead of a generic failure, and tell it apart from a normal qeval
// failure (e.g. a bad expression) that isn't a connectivity problem.
// `tried` is every URL abciQuery actually attempted (see its own doc
// comment) -- the message mentions how many when there was more than
// one, so "still down after trying every fallback" reads differently
// from a single-endpoint failure. err.endpoint stays net.rpcUrl (the
// primary) regardless, matching what callers have always shown.
function unreachableError(net, tried, detail) {
  const which = tried.length > 1 ? `${tried.length} known endpoints, including ${net.rpcUrl}` : net.rpcUrl;
  const err = new Error(`The gno.land RPC endpoint (${which}) is not reachable right now — ${detail}. Please try again later.`);
  err.isEndpointUnreachable = true;
  err.endpoint = net.rpcUrl;
  err.triedUrls = tried;
  return err;
}

// Remembers whichever RPC URL last actually answered successfully,
// keyed by the network's PRIMARY rpcUrl -- so once the official endpoint
// goes down for an extended period (confirmed happening for a full day
// straight, 2026-08-16/17) later calls try the last known-good fallback
// FIRST instead of re-paying a full timeout against the dead primary on
// every single query. Module-level, not persisted -- resets on page
// load, so a real recovery of the official endpoint gets noticed on the
// next visit without needing anything special.
const lastGoodRpcUrl = new Map();

function candidateRpcUrls(net) {
  const all = [net.rpcUrl, ...(net.rpcFallbackUrls || [])];
  const sticky = lastGoodRpcUrl.get(net.rpcUrl);
  return sticky && sticky !== all[0] && all.includes(sticky) ? [sticky, ...all.filter((u) => u !== sticky)] : all;
}

// Some public RPC nodes occasionally accept a connection and never
// respond (not slow — genuinely hangs), so every attempt is wrapped with
// an AbortController timeout rather than relying on fetch to fail on its
// own.
//
// fetch() only rejects on a genuine network failure -- an HTTP error
// status (e.g. a 403 from an upstream load balancer, confirmed live
// during a real gno.land testnet RPC outage) still resolves normally,
// with a non-JSON (HTML) body. Calling res.json() on that unconditionally
// used to throw a cryptic "Unexpected token '<'" parse error with no
// indication of what actually failed -- res.ok is checked explicitly so
// a real outage produces a clear, specific message instead. Returns the
// raw abciQuery result on success or throws a plain Error (caller
// decides what "unreachable" means across every candidate) -- this is
// the single-URL primitive; abciQuery below is what actually rotates
// through candidates.
async function abciQueryOnce(url, path, dataStr, timeoutMs) {
  const data = btoa(unescape(encodeURIComponent(dataStr)));
  const reqUrl = `${url}/abci_query?path=${encodeURIComponent('"' + path + '"')}&data=${encodeURIComponent('"' + data + '"')}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(reqUrl, { signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") throw new Error(`timed out after ${timeoutMs / 1000}s`);
    throw new Error(err.message || "network error");
  }
  clearTimeout(timer);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  let json;
  try {
    json = await res.json();
  } catch (err) {
    throw new Error("returned an unexpected (non-JSON) response");
  }
  if (json.error) throw new Error(json.error.message);
  const raw = json.result.response.ResponseBase.Data;
  if (json.result.response.ResponseBase.Error) {
    return null; // e.g. "invalid package path" for a path with no render/file
  }
  return raw ? b64ToUtf8(raw) : "";
}

// Tries every RPC URL configured for this network in order -- the
// official endpoint first (unless a fallback was the last one to
// actually answer, see lastGoodRpcUrl above), then net.rpcFallbackUrls
// (see NETWORKS' own doc comment for how those were vetted) -- and
// short-circuits on the first one that answers successfully. Only
// throws (as unreachableError) once every candidate has failed: a real
// "the whole collection is unreachable" case, not just one flaky node.
export async function abciQuery(net, path, dataStr, timeoutMs = 15000) {
  const candidates = candidateRpcUrls(net);
  let lastErr;
  for (const url of candidates) {
    try {
      const result = await abciQueryOnce(url, path, dataStr, timeoutMs);
      lastGoodRpcUrl.set(net.rpcUrl, url);
      return result;
    } catch (err) {
      lastErr = err;
    }
  }
  throw unreachableError(net, candidates, lastErr?.message || "unknown error");
}

// A block's own timestamp never changes once committed, so this caches
// keyed by "net.rpcUrl:height" for the page's lifetime -- a message list
// with many rows sharing nearby (or, after an edit, identical) heights
// shouldn't re-fetch the same block over and over.
const blockTimeCache = new Map();

// Resolves a block height to its real wall-clock commit time (an ISO
// string straight from the node's own header.time), via the standard
// CometBFT-style /block?height=N RPC endpoint -- confirmed live against
// sapphire-1 (returns block.header.time). Used to show a human timestamp
// next to a message's CreatedHeight/EditedHeight without the contract
// itself needing any notion of wall-clock time (gno.land realms only
// ever see block height, not real time).
export async function fetchBlockTime(net, height) {
  const candidates = candidateRpcUrls(net);
  let lastErr;
  for (const url of candidates) {
    const cacheKey = `${url}:${height}`;
    if (blockTimeCache.has(cacheKey)) return blockTimeCache.get(cacheKey);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(`${url}/block?height=${height}`, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const timeStr = json?.result?.block?.header?.time || json?.result?.block_meta?.header?.time;
      if (!timeStr) throw new Error("response had no block header time");
      lastGoodRpcUrl.set(net.rpcUrl, url);
      blockTimeCache.set(cacheKey, timeStr);
      return timeStr;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err.name === "AbortError" ? new Error(`timed out after 15s`) : err;
    }
  }
  throw unreachableError(net, candidates, lastErr?.message || "unknown error");
}

// onItemDone(result, item, idx), if given, fires as soon as each item's own
// fn() resolves -- not in original list order, in whatever order the
// bounded-concurrency workers actually finish. Lets a caller render each
// result the moment it's available (e.g. append a row/card) instead of
// waiting for the whole list, without giving up the concurrency cap.
// Optional and backward compatible -- existing callers that only care
// about the final `results` array are unaffected.
export async function mapLimit(items, limit, fn, onItemDone) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      const result = await fn(items[idx], idx);
      results[idx] = result;
      if (onItemDone) onItemDone(result, items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Bounded concurrency for a queue that grows over TIME rather than being
// known up front (mapLimit needs the whole item list before it starts) --
// e.g. kicking off a per-item follow-up task the moment that item is
// confirmed relevant, without waiting for every other item's own check to
// finish first, while still capping how many follow-ups run at once.
// createLimiter(3) returns a run(fn) you call per task as it's discovered;
// each call returns a promise that resolves once that task actually runs
// and completes, so `Promise.all(tasks.map(run))` (or pushing each `run(fn)`
// result into an array and awaiting it later) waits for everything while
// the queue internally throttles concurrency to `limit`.
export function createLimiter(limit) {
  let active = 0;
  const queue = [];
  function next() {
    if (active >= limit || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  }
  return function run(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
  };
}

// POSTs to the indexer (via its CORS proxy, when the network has one —
// see indexerProxyUrl above) and unwraps GraphQL's own error shape into a
// thrown Error, same convention as abciQuery.
export async function graphqlQuery(net, query, timeoutMs = 20000) {
  const url = net.indexerProxyUrl || net.indexerUrl;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === "AbortError") throw new Error(`Indexer timed out after ${timeoutMs / 1000}s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`Indexer returned HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0]?.message || "indexer query error");
  return json.data;
}

// One wallet's own outgoing native-GNOT bank sends — no recipient filter,
// deliberately: a query naming two of a caller's own wallets together
// (e.g. "did A send to B") tells the indexer operator those two wallets
// are being cross-referenced, no matter which IP sent it. Fetching one
// wallet's own history and matching recipients client-side against a
// wallet set avoids that entirely. Verified live against real historical
// data (2,538 real BankMsgSend transactions exist on betanet; a real
// wallet's own history came back with real hashes/heights/amounts,
// schema confirmed via introspection, not guessed). getTransactions
// legitimately returns null — not an error, not an empty array — when
// nothing matches the filter (confirmed live: a filter with zero matches
// returns null the same way a real one returns an array).
export async function fetchTransfersFrom(net, fromAddr) {
  const query = `query { getTransactions(where: { messages: { value: { BankMsgSend: {
    from_address: { eq: "${fromAddr}" }
  } } } }) { hash block_height messages { value { __typename ... on BankMsgSend { from_address to_address amount } } } } }`;
  const data = await graphqlQuery(net, query);
  const txs = data.getTransactions || [];
  const transfers = [];
  for (const tx of txs) {
    for (const m of tx.messages) {
      if (m.value.__typename !== "BankMsgSend" || m.value.from_address !== fromAddr) continue;
      // BankMsgSend.amount is a full coin string ("5000000ugnot"), not a
      // bare number — pull out just the ugnot amount so callers can treat
      // this the same as a Cosmos SDK chain's raw amount (fromBaseUnits
      // requires a plain digit string).
      const match = /^(\d+)ugnot$/.exec(m.value.amount || "");
      transfers.push({ toAddress: m.value.to_address, hash: tx.hash, height: tx.block_height, amountRaw: match ? match[1] : null });
    }
  }
  return { transfers, truncated: false }; // no artificial cap observed on this indexer — see cosmos-registry.js for the contrast
}

// One wallet's own MsgCall history (every realm call it has ever made, any
// pkg_path/func) — not filtered to a specific package, since the point is
// answering "has this address done *anything* on this chain besides one
// specific transaction", the same question the gingernft2 mint audit asked
// about mainnet. Same one-wallet-named-per-request privacy shape as
// fetchTransfersFrom above. Returns transactions oldest-first is not
// guaranteed by the indexer, so callers that care about order should sort
// by block_height themselves.
export async function fetchCallsFrom(net, callerAddr) {
  const query = `query { getTransactions(where: { messages: { value: { MsgCall: {
    caller: { eq: "${callerAddr}" }
  } } } }) { hash block_height messages { value { __typename ... on MsgCall { caller pkg_path func } } } } }`;
  const data = await graphqlQuery(net, query);
  const txs = data.getTransactions || [];
  const calls = [];
  for (const tx of txs) {
    for (const m of tx.messages) {
      if (m.value.__typename !== "MsgCall" || m.value.caller !== callerAddr) continue;
      calls.push({ hash: tx.hash, height: tx.block_height, pkgPath: m.value.pkg_path, func: m.value.func });
    }
  }
  return calls;
}

// Every /vm.m_addpkg this wallet has ever sent -- confirmed live against
// the real indexer schema (MsgAddPackage.creator, package.{name,path}),
// same one-wallet-named-per-request shape as fetchTransfersFrom/
// fetchCallsFrom above. Used to let a page recall "collections I've
// already deployed" without the user having to paste the full package
// path back in from memory. Newest-last is not guaranteed by the
// indexer -- callers that care about order should sort by height
// themselves (nft-minter shows most-recent-first).
export async function fetchDeployedPackagesFrom(net, creatorAddr) {
  const query = `query { getTransactions(where: { messages: { value: { MsgAddPackage: {
    creator: { eq: "${creatorAddr}" }
  } } } }) { hash block_height messages { value { __typename ... on MsgAddPackage { creator package { name path } } } } } }`;
  const data = await graphqlQuery(net, query);
  const txs = data.getTransactions || [];
  const packages = [];
  for (const tx of txs) {
    for (const m of tx.messages) {
      if (m.value.__typename !== "MsgAddPackage" || m.value.creator !== creatorAddr) continue;
      packages.push({ path: m.value.package.path, name: m.value.package.name, hash: tx.hash, height: tx.block_height });
    }
  }
  return packages;
}

// grc20reg renders one line per registered token. The trailing ".SYMBOL"
// on the link is only present on some deployments (e.g. testnet);
// betanet's renders without it, so the symbol group is optional here.
// - **Name** - [path](url)[.SYMBOL] - [info](...)
const TOKEN_LINE_RE = /^- \*\*(.+?)\*\* - \[(.+?)\]\([^)]*\)(?:\.(\S+))? - /gm;

export async function loadFungibleTokens(net) {
  const markdown = (await abciQuery(net, "vm/qrender", "gno.land/r/demo/defi/grc20reg:")) || "";
  const rows = [];
  let m;
  const re = new RegExp(TOKEN_LINE_RE);
  while ((m = re.exec(markdown)) !== null) {
    rows.push({ name: m[1], path: m[2], symbol: m[3] || "—" });
  }
  return rows;
}

// vm/qeval returns a Gno-formatted value string, e.g. "(295887460856091
// int64)" or, for (int64, error) returns, two lines like "(37
// int64)\n(undefined)". The first integer literal is always the value.
function parseGnoEvalNumber(raw) {
  if (!raw) return null;
  const m = /-?\d+/.exec(raw);
  return m ? Number(m[0]) : null;
}

export async function fetchBalance(net, tokenPath, address) {
  const literal = JSON.stringify(address); // bech32 addresses need no extra escaping
  const raw = await abciQuery(net, "vm/qeval", `${tokenPath}.BalanceOf(${literal})`);
  return parseGnoEvalNumber(raw);
}

// Cross-references grc20reg for a display name/symbol on a given token
// path. Returns null if the path isn't a registered token on this
// network — a caller can use that to warn "not a known registered token"
// rather than silently trusting an arbitrary pkg_path.
export async function resolveToken(net, tokenPath) {
  const tokens = await loadFungibleTokens(net);
  return tokens.find(t => t.path === tokenPath) || null;
}

// Best-effort only — see gno-tools' shared dev notes: unlike BalanceOf,
// a GRC20 realm is NOT guaranteed to expose its decimals at all. The
// underlying shared package's method is GetDecimals(), but individual
// realms commonly wrap it under a plain Decimals() name instead (or not
// at all) — confirmed live: gno.land/r/gnoswap/gns exposes Decimals(),
// gno.land/r/gnoland/wugnot exposes neither. Returns null, never throws,
// when nothing resolves — callers must treat that as "unknown", not 0.
export async function fetchTokenDecimals(net, tokenPath) {
  for (const fn of ["Decimals", "GetDecimals"]) {
    try {
      const raw = await abciQuery(net, "vm/qeval", `${tokenPath}.${fn}()`);
      const n = parseGnoEvalNumber(raw);
      if (n != null) return n;
    } catch {
      // this token doesn't expose this function name — try the next one
    }
  }
  return null;
}

// Decimal-string <-> base-unit-integer-string conversion for building
// payment amounts. Deliberately string/BigInt arithmetic throughout, not
// floating point — parseFloat(amount) * 10**decimals can misround real
// money (e.g. 1.1 * 1e6 in JS is 1099999.9999999999), which is not
// acceptable for a value that ends up literally inside a transaction.

// "1.5" + 6 decimals -> "1500000". Throws on a shape that can't be
// represented exactly (more fractional digits than `decimals` allows) or
// isn't a plain non-negative decimal to begin with — silently truncating
// precision on a payment amount would be worse than refusing it.
export function toBaseUnits(amountStr, decimals) {
  const s = String(amountStr).trim();
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new Error(`"${amountStr}" isn't a valid non-negative decimal amount.`);
  const [, whole, frac = ""] = m;
  if (frac.length > decimals) {
    throw new Error(`"${amountStr}" has more decimal places than this token supports (${decimals}).`);
  }
  const padded = frac.padEnd(decimals, "0");
  const combined = (whole + padded).replace(/^0+(?=\d)/, "");
  return BigInt(combined).toString();
}

// Inverse of toBaseUnits, for display: "1500000" + 6 decimals -> "1.5".
export function fromBaseUnits(rawStr, decimals) {
  const s = String(rawStr).trim();
  if (!/^\d+$/.test(s)) throw new Error(`"${rawStr}" isn't a valid raw unit integer.`);
  const padded = s.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals).replace(/^0+(?=\d)/, "");
  const frac = padded.slice(padded.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

// GNOT is the native bank-module coin, not a GRC20 realm — it has no
// pkg_path/BalanceOf, so fetchBalance() above doesn't apply to it.
export const NATIVE_DENOM = "ugnot";
export const NATIVE_DECIMALS = 6;

// Parses a Cosmos-SDK-style coins string, e.g. "9969353159ugnot" or
// "100ugnot,50uatom" (comma-separated, no spaces) into [{amount, denom}].
// An empty string means "no coins at all" -> [].
function parseCoinsString(s) {
  if (!s) return [];
  return s.split(",").map((part) => {
    const m = /^(\d+)([a-zA-Z][a-zA-Z0-9/]*)$/.exec(part.trim());
    if (!m) throw new Error(`Unrecognized coin format: "${part}"`);
    return { amount: m[1], denom: m[2] };
  });
}

// Native GNOT balance for any address. Returns the raw ugnot amount as a
// string (BigInt-safe), or "0" if the account holds none.
//
// Path and response shape verified live against betanet (not assumed
// from docs): "bank/balances/<addr>" is the correct ABCI query path
// ("bank/balance" — singular — is a real but different/unknown endpoint
// that errors). The response Data, once base64-decoded, is itself a
// JSON string literal wrapping the Cosmos-SDK coins string — literally
// the two characters `""` for a zero balance, or e.g.
// `"9969353159ugnot"` — so it needs a second JSON.parse to unwrap.
export async function fetchNativeBalance(net, address) {
  const raw = await abciQuery(net, `bank/balances/${address}`, "");
  if (!raw) return "0";
  const coinsStr = JSON.parse(raw);
  const coins = parseCoinsString(coinsStr);
  const gnot = coins.find((c) => c.denom === NATIVE_DENOM);
  return gnot ? gnot.amount : "0";
}
