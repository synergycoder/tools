// Brute-force vanity search loop. Runs as a module Web Worker so the UI
// thread never blocks. Never touches the network — pure local computation.
// Keeps searching after a match (rather than stopping) so the main thread
// can collect more than one matching address per run; it decides when
// enough have been found and sends "stop".

import { generateWallet, matchesTarget } from "./gno-address.js";

// Report/yield on a wall-clock cadence, not an attempt count — mnemonic
// mode (PBKDF2-bound) and "key" mode (no KDF) differ by orders of
// magnitude in attempts/sec, so a fixed attempt-count threshold would
// leave slow-mode searches with no live feedback for tens of seconds.
const REPORT_INTERVAL_MS = 300;
const CLOCK_CHECK_STRIDE = 32; // amortize performance.now() over N attempts

function yieldToEventLoop() {
  // lets queued "stop" messages be processed between batches, since the
  // search loop is otherwise a tight synchronous run.
  return new Promise((resolve) => setTimeout(resolve, 0));
}

let stopped = false;

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === "stop") {
    stopped = true;
  } else if (msg.type === "start") {
    stopped = false;
    run(msg.mode, msg.target, msg.position);
  }
};

// `attempts` on every message (both "progress" and "match") is a DELTA —
// the count since this worker's last message — never a running total, so
// the main thread can just sum whatever it receives across all workers.
async function run(mode, target, position) {
  let sinceReport = 0;
  let count = 0;
  let lastReportAt = performance.now();
  while (!stopped) {
    const wallet = generateWallet(mode);
    sinceReport++;
    count++;
    if (matchesTarget(wallet.address, target, position)) {
      self.postMessage({ type: "match", wallet, attempts: sinceReport });
      sinceReport = 0;
      lastReportAt = performance.now();
      continue; // keep searching — the main thread stops us once it has enough
    }
    if (count % CLOCK_CHECK_STRIDE === 0 && performance.now() - lastReportAt >= REPORT_INTERVAL_MS) {
      self.postMessage({ type: "progress", attempts: sinceReport });
      sinceReport = 0;
      lastReportAt = performance.now();
      await yieldToEventLoop();
    }
  }
  if (sinceReport > 0) self.postMessage({ type: "progress", attempts: sinceReport });
  self.postMessage({ type: "stopped" });
}
