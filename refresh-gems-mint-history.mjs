#!/usr/bin/env node
// Regenerates gems-mint-history.json -- a static, pre-built snapshot of
// every real Mint transaction on the Gems realm (timestamp, block,
// wallet, quantity, gas fee, storage cost), so the public mint page's
// List view has an instant baseline for EVERY visitor, not just
// returning ones with their own browser cache already warm. Same idea
// as gno-observer's own build-cache.mjs pattern (a periodically-
// regenerated static file backing a live page), just for this
// collection specifically -- this repo has no existing build/cron
// script of its own to plug into, so this is a fresh standalone one.
//
// Run manually (`node refresh-gems-mint-history.mjs`) whenever you want
// the baseline refreshed -- commit the resulting JSON. The page itself
// always tops this up with a live query for anything newer, so a stale
// baseline only means a slightly slower first paint, never wrong data.

const REALM_PATH = "gno.land/r/nym-gemsnft000/g17";
const INDEXER_URL = "https://indexer.sapphire.testnets.gno.land/graphql/query";
const OUT_FILE = new URL("./gems-mint-history.json", import.meta.url);

async function graphqlQuery(query) {
  const res = await fetch(INDEXER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`indexer HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0]?.message || "indexer query error");
  return json.data;
}

// mapLimit ported from lib/gno-rpc.js (same shape) -- kept local rather
// than imported since that file uses relative browser-style resolution,
// not a Node/package import path.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function fetchMintTransactions() {
  const query = `query {
    getTransactions(where: {
      success: { eq: true },
      messages: { value: { MsgCall: { pkg_path: { eq: "${REALM_PATH}" } } } }
    }, order: { heightAndIndex: DESC }) {
      hash
      block_height
      gas_fee { amount }
      response { events {
        __typename
        ... on GnoEvent { type attrs { key value } }
        ... on StorageDepositEvent { bytes_delta fee_delta { amount } }
      } }
    }
  }`;
  const data = await graphqlQuery(query);
  const txs = [];
  for (const tx of data.getTransactions || []) {
    const mints = [];
    let storageBytes = 0, storageFeeUgnot = 0;
    for (const ev of tx.response?.events || []) {
      if (ev.__typename === "GnoEvent" && ev.type === "Mint") {
        const attrs = Object.fromEntries((ev.attrs || []).map((a) => [a.key, a.value]));
        if (attrs.tokenId && attrs.to) mints.push({ tokenId: attrs.tokenId, to: attrs.to });
      } else if (ev.__typename === "StorageDepositEvent") {
        storageBytes += ev.bytes_delta || 0;
        storageFeeUgnot += ev.fee_delta?.amount || 0;
      }
    }
    if (!mints.length) continue;
    txs.push({
      hash: tx.hash,
      blockHeight: tx.block_height,
      gasFeeUgnot: tx.gas_fee ? tx.gas_fee.amount : null,
      storageBytes,
      storageFeeUgnot,
      to: mints[0].to,
      quantity: mints.length,
      tokenIds: mints.map((m) => m.tokenId),
    });
  }
  return txs;
}

async function fetchBlockTimes(heights) {
  const times = new Map();
  await mapLimit(heights, 8, async (h) => {
    try {
      const data = await graphqlQuery(`query { getBlocks(where: { height: { eq: ${h} } }) { height time } }`);
      const b = (data.getBlocks || [])[0];
      if (b) times.set(b.height, b.time);
    } catch {
      // leave this height's date blank rather than failing the whole run
    }
  });
  return times;
}

async function main() {
  console.log(`Fetching mint transactions for ${REALM_PATH}…`);
  const txs = await fetchMintTransactions();
  console.log(`Found ${txs.length} mint transactions. Fetching block times…`);
  const heights = [...new Set(txs.map((t) => t.blockHeight))];
  const times = await fetchBlockTimes(heights);
  for (const t of txs) t.blockTime = times.get(t.blockHeight) || null;

  const out = {
    realmPath: REALM_PATH,
    generatedAt: new Date().toISOString(),
    lastHeight: txs.length ? Math.max(...txs.map((t) => t.blockHeight)) : 0,
    txs,
  };
  const fs = await import("node:fs/promises");
  await fs.writeFile(OUT_FILE, JSON.stringify(out, null, 2) + "\n");
  console.log(`Wrote ${txs.length} transactions to ${OUT_FILE.pathname}`);
}

main().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});
