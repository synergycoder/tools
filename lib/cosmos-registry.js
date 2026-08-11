// Live Cosmos SDK chain registry + balance lookups, via the public
// cosmos.directory proxy (CORS-enabled — confirmed live with a real
// cross-origin request, not assumed from docs). Used to scan one address
// across every live Cosmos chain without needing a backend.

let registryCache = null; // in-memory only — the registry is ~200 chains, cheap to refetch per page load

// Every chain's `assets` array already carries symbol/decimals/coingecko
// price for every token cosmos.directory knows about on that chain (its
// native coin plus common IBC assets) — so a balance's denom can usually
// be resolved to something readable without a second network call.
export async function fetchChainRegistry() {
  if (registryCache) return registryCache;
  const res = await fetch("https://chains.cosmos.directory");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const chains = (json.chains || [])
    .filter((c) => c.status === "live" && c.bech32_prefix && c.denom && c.decimals != null)
    .map((c) => {
      const assetsByDenom = new Map();
      for (const a of c.assets || []) {
        if (!a.denom) continue;
        assetsByDenom.set(a.denom, {
          symbol: a.symbol || (a.display && a.display.denom ? a.display.denom.toUpperCase() : a.denom),
          decimals: a.decimals ?? (a.display ? a.display.exponent : null),
          coingeckoId: a.coingecko_id || null,
          usdPrice: a.prices && a.prices.coingecko ? a.prices.coingecko.usd ?? null : null,
        });
      }
      const explorer = (c.explorers || []).find((e) => e.account_page);
      const txExplorer = (c.explorers || []).find((e) => e.tx_page);
      // Specifically Mintscan, not just whichever explorer happens to list
      // an account_page first — confirmed live against cosmos.directory
      // that its account_page template is
      // "https://www.mintscan.io/<slug>/accounts/${accountAddress}" (note
      // "accounts", plural) for both cosmoshub and osmosis.
      const mintscanExplorer = (c.explorers || []).find((e) => e.kind === "mintscan");
      return {
        key: c.chain_name,
        label: c.pretty_name || c.chain_name,
        prefix: c.bech32_prefix,
        denom: c.denom,
        decimals: c.decimals,
        symbol: c.display ? c.display.toUpperCase() : (c.symbol || c.denom.replace(/^u/, "").toUpperCase()),
        restChain: c.chain_name,
        assetsByDenom,
        explorerAccountUrl: explorer ? explorer.account_page : null,
        explorerTxUrl: txExplorer ? txExplorer.tx_page : null,
        mintscanAccountUrlTemplate: mintscanExplorer ? mintscanExplorer.account_page : null,
      };
    });
  registryCache = chains;
  return chains;
}

// cosmos.directory is a shared public proxy that 429s under load (seen
// firsthand building the wallet dashboard) — retry with backoff+jitter
// rather than surfacing every transient rate-limit as a hard failure.
export async function fetchJsonWithRetry(url, { retries = 3, timeoutMs = 12000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (res.status === 429 || res.status === 503) {
        lastErr = new Error(`HTTP ${res.status}`);
      } else if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      } else {
        return await res.json();
      }
    } catch (err) {
      clearTimeout(timer);
      lastErr = err.name === "AbortError" ? new Error("timed out") : err;
    }
    if (attempt < retries) {
      await new Promise((r) => setTimeout(r, 400 * 2 ** attempt + Math.random() * 300));
    }
  }
  throw lastErr;
}

export async function fetchChainBalances(chain, address) {
  const json = await fetchJsonWithRetry(
    `https://rest.cosmos.directory/${chain.restChain}/cosmos/bank/v1beta1/balances/${address}`
  );
  return json.balances || [];
}

// Fallback resolution for a denom that isn't in this chain's `assets` list
// (cosmos.directory's registry is curated/incomplete, not exhaustive — a
// balance was still found, but the denom is unknown). The chain's OWN bank
// module often has real metadata for it — verified live: the old IBC
// "denom_traces" query is deprecated (every REST gateway tested returns
// "Not Implemented"), but `/cosmos/bank/v1beta1/denoms_metadata/<denom>`
// on the chain holding the balance works and returns a real symbol plus a
// description like "IBC token from transfer/channel-569/untrn". A 404
// means the chain genuinely has no metadata for it — treated as
// "unresolved", not an error, since that's a normal/expected outcome for
// a lot of long-tail or spam tokens.
export async function fetchDenomMetadata(chain, denom) {
  const url = `https://rest.cosmos.directory/${chain.restChain}/cosmos/bank/v1beta1/denoms_metadata/${encodeURIComponent(denom)}`;
  for (let attempt = 0; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (res.status === 404) return null;
      if (res.status === 429 || res.status === 503) {
        await new Promise((r) => setTimeout(r, 400 * 2 ** attempt + Math.random() * 300));
        continue;
      }
      if (!res.ok) return null; // some chains return a different not-found shape (e.g. gRPC code 5) — still just "unresolved"
      const json = await res.json();
      return json && json.metadata ? json.metadata : null;
    } catch {
      clearTimeout(timer);
      if (attempt === 2) return null;
    }
  }
  return null;
}

// Fetches one wallet's own outgoing bank-module transfers (no recipient
// filter) — deliberately never asks the server "did X send to Y" (a query
// that names two of a caller's own wallets together in one request), so
// relationship-finding tools built on this can match recipients against a
// wallet set entirely client-side instead of leaking which wallets are
// being cross-referenced. Verified live against a real, active address
// (real hashes/heights/amounts returned).
//
// Real, load-bearing caveat found while building this: cosmos.directory
// rotates across different backend node providers per request, and they
// don't all have equally deep tx-indexes — three identical requests in a
// row for the same address returned totals of 2, 193, and 220. Also,
// `pagination.limit`/`pagination.offset` are silently ignored by this
// legacy query-string search on every backend tested (a limit=3 request
// returned the full ~100-row default page, and offset=3 returned the
// identical first page) — so this can only fetch whatever single page
// the current backend hands back, not reliably page through everything.
// `truncated` is set whenever the reported `total` exceeds what came
// back, so callers can surface that honestly rather than assuming
// completeness.
export async function fetchAllTransfersFrom(chain, fromAddr) {
  const query = `transfer.sender='${fromAddr}'`;
  const url = `https://rest.cosmos.directory/${chain.restChain}/cosmos/tx/v1beta1/txs` +
    `?query=${encodeURIComponent(query)}&order_by=ORDER_BY_DESC`;
  const json = await fetchJsonWithRetry(url);
  const txResponses = json.tx_responses || [];
  const txs = json.txs || [];
  const total = Number(json.total || txResponses.length);
  const transfers = [];
  txResponses.forEach((txr, i) => {
    const msgs = txs[i]?.body?.messages || [];
    for (const m of msgs) {
      if (m["@type"] !== "/cosmos.bank.v1beta1.MsgSend" || m.from_address !== fromAddr) continue;
      const coin = m.amount?.find((a) => a.denom === chain.denom) || m.amount?.[0] || null;
      transfers.push({
        toAddress: m.to_address,
        hash: txr.txhash,
        height: Number(txr.height),
        timestamp: txr.timestamp,
        amountRaw: coin ? coin.amount : null,
        denom: coin ? coin.denom : null,
      });
    }
  });
  return { transfers, total, truncated: total > transfers.length };
}

// Every delegation this address currently has, one entry per validator —
// kept as a list rather than collapsed to a single total, since "does this
// wallet delegate to the same validator as another wallet" is itself a
// useful signal a caller may want, not just the summed amount. Unlike
// fetchAllTransfersFrom's tx-search endpoint (which silently ignores
// pagination on every backend tested), the staking module's own pagination
// is the standard Cosmos SDK kind and works normally — paginated for real
// here rather than assumed to fit on one page.
export async function fetchDelegations(chain, address) {
  const delegations = [];
  let nextKey = null;
  for (let page = 0; page < 20; page++) { // sanity bound — no real wallet delegates to hundreds of validators
    const qs = new URLSearchParams({ "pagination.limit": "100" });
    if (nextKey) qs.set("pagination.key", nextKey);
    const url = `https://rest.cosmos.directory/${chain.restChain}/cosmos/staking/v1beta1/delegations/${address}?${qs}`;
    const json = await fetchJsonWithRetry(url);
    for (const d of json.delegation_responses || []) {
      if (d.balance?.denom !== chain.denom) continue;
      delegations.push({ validatorAddress: d.delegation?.validator_address || null, amountRaw: d.balance.amount });
    }
    nextKey = json.pagination?.next_key;
    if (!nextKey) break;
  }
  return delegations;
}

// Base64-encodes a CosmWasm smart-query JSON payload the way the browser
// needs to (Node's Buffer isn't available here) — same unicode-safe
// technique tools/lib/gno-rpc.js's abciQuery already uses for its own
// base64 encoding, applied to the same job on a different chain.
export async function cwSmartQuery(chain, contract, queryObj) {
  const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(queryObj))));
  const url = `https://rest.cosmos.directory/${chain.restChain}/cosmwasm/wasm/v1/contract/${contract}/smart/${b64}`;
  const json = await fetchJsonWithRetry(url);
  if (json.code) throw new Error(json.message || "contract query error");
  return json.data;
}

// The metadata's `denom_units` array lists every representation of the
// token with its power-of-10 exponent; the one matching `display` is the
// human-facing unit (e.g. "untrn" @ exponent 0, "ntrn" @ exponent 6).
// Not every chain populates this fully, so a caller must treat null as
// "decimals unknown", not 0.
export function decimalsFromMetadata(metadata) {
  if (!metadata || !metadata.display || !Array.isArray(metadata.denom_units)) return null;
  const unit = metadata.denom_units.find((u) => u.denom === metadata.display);
  return unit ? unit.exponent : null;
}
