// Thin wrapper over the Adena wallet's injected window.adena API.
// Reference: docs.adena.app/integrations (fetched directly while building
// this — AddEstablish/GetAccount/On method names, param shapes, and
// response fields below are taken from those docs, not assumed).
//
// Never touches private keys or signs anything by itself — connect, read
// the account address/chainId, and (for pages that need it) hand off a
// prepared transaction for Adena's own popup to sign and broadcast.

export const INSTALL_URL = "https://adena.app/";

// Root-caused in ~/gno-land-dev-notes.md ("gno-observer: SOLVED — a
// window.adena that never gets set", 2026-08-04): a bug in Adena's own
// content script — not this page's code — can leave window.adena unset
// with no popup and no error at all, making "Connect" look like a dead
// button. Every page that imports this module ships an empty
// adena-compat.js loaded via an external <script src> tag, which is the
// verified fix (confirmed against Adena's actual installed extension
// source). This note is a fallback in case that ever isn't enough.
export const SILENT_FAILURE_NOTE =
  "If clicking Connect still does nothing at all (no popup, no error), " +
  "this is a known bug in Adena's own extension, not this page — a fix " +
  "is already applied here, but if it still happens, reloading the page " +
  "or reinstalling Adena is the next thing to try.";

export function isAvailable() {
  return typeof window.adena !== "undefined";
}

// Content scripts (Adena's included) commonly inject at "document_idle",
// which can run AFTER a page's own <script type="module"> has already
// executed — there's no guaranteed ordering between the two — so a single
// synchronous isAvailable() check at page load can catch window.adena
// mid-injection, see "not there yet", and give up moments before it
// actually appears. Confirmed against the real installed extension (a
// mock resolves instantly and hides this entirely): polling is required,
// not optional. Resolves true the moment window.adena is seen, or false
// after timeoutMs with nothing — never rejects.
export function waitForAdena(timeoutMs = 3000, intervalMs = 150) {
  return new Promise((resolve) => {
    if (isAvailable()) { resolve(true); return; }
    const start = Date.now();
    const timer = setInterval(() => {
      if (isAvailable()) {
        clearInterval(timer);
        resolve(true);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        resolve(false);
      }
    }, intervalMs);
  });
}

// Establishes the connection (AddEstablish) then reads the active account
// (GetAccount). Returns { address, chainId, coins }. Throws with Adena's
// own message when either step fails (e.g. rejected in the popup, or
// error 1000 NOT_CONNECTED / 2000 WALLET_LOCKED / 3002 NO_ACCOUNT).
export async function connect(appName) {
  if (!isAvailable()) {
    throw new Error(`Adena not detected — install it from ${INSTALL_URL}, then reload this page.`);
  }

  const establishRes = await window.adena.AddEstablish(appName);
  // Adena reports status:"failure" with this message when the site was
  // already authorized in a prior visit — not a real rejection, just a
  // redundant no-op (e.g. clicking Connect again while already
  // connected). Only a genuine rejection/error should stop the flow here.
  const alreadyConnected = /already connected/i.test(establishRes.message || "");
  if (establishRes.status !== "success" && !alreadyConnected) {
    throw new Error(establishRes.message || "Connection request was not approved.");
  }

  const accountRes = await window.adena.GetAccount();
  if (accountRes.status !== "success" || !accountRes.data || !accountRes.data.address) {
    throw new Error(accountRes.message || "Could not read the connected account.");
  }

  const { address, chainId, coins } = accountRes.data;
  return { address, chainId, coins };
}

// Adena tracks per-domain approval itself (its own docs: "the domain will
// be added to a locally-stored whitelist") — once a user approves this
// site, a later connect() from the same origin resolves silently, no
// popup (that's exactly the "already connected" no-op connect() already
// handles above). So a connection can genuinely survive a page reload;
// what actually dropped it before was that nothing ever called connect()
// again after the initial load, losing the in-memory "connected" UI
// state even though the underlying authorization was still valid. This
// flag records only "a connect() succeeded before" — never the address
// itself, which should always be re-read fresh via GetAccount() inside
// connect() rather than trusted from a prior page load.
const CONNECTED_FLAG_KEY = "gnoTools:adenaConnected";

export function markConnected() {
  try { localStorage.setItem(CONNECTED_FLAG_KEY, "1"); } catch {}
}

export function clearConnected() {
  try { localStorage.removeItem(CONNECTED_FLAG_KEY); } catch {}
}

// Synchronous on purpose, so a caller can decide whether to show a
// "restoring connection…" state at all *before* doing anything — a
// first-time visitor (no flag yet) should see zero visual change on
// load, not even a flash of a connecting spinner.
export function hasStoredConnection() {
  try { return localStorage.getItem(CONNECTED_FLAG_KEY) === "1"; } catch { return false; }
}

// address: string
export function onAccountChange(cb) {
  window.adena.On("changedAccount", cb);
}

// chainId: string
export function onNetworkChange(cb) {
  window.adena.On("changedNetwork", cb);
}

// Hands a prepared transaction to Adena, which signs AND broadcasts it —
// we never see key material or the raw signature. `messages` is
// [{ type, value }] using Adena's own message type strings (e.g.
// "/bank.MsgSend", "/vm.m_call"). NOTE: the docs page's own prose
// "parameter shape" block says DoContract takes { tx: { messages, memo },
// isNotification } — that contradicts every one of its own five worked
// code examples, which all call it flat as
// DoContract({ messages, memo }) with no tx wrapper and no
// isNotification. Going with what every real example actually does, not
// the inconsistent prose description. Returns { hash, height } on
// success, throws with Adena's own message otherwise (e.g. rejected in
// the popup, or a failed broadcast).
export async function doContract(messages, memo) {
  const payload = { messages };
  if (memo) payload.memo = memo;
  const res = await window.adena.DoContract(payload);
  if (res.status !== "success" || !res.data) {
    throw new Error(res.message || "Transaction was not completed.");
  }
  const { hash, height } = res.data;
  return { hash, height };
}
