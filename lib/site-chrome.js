// Shared, persistent site chrome — header (logo, theme toggle, wallet+
// network bubble) + footer — injected identically on every gno.tools
// page. One global Adena connection lives here (via adena-connect.js's
// own localStorage flag + Adena's own per-domain approval, so it
// survives reloads and tab switches for real, not just in-memory)
// instead of every page wiring up its own Connect button. Read-only:
// this module never signs anything itself — SwitchNetwork is the one
// exception, since it's not a transaction, just telling the
// already-installed extension which chain to point at.
//
// Color tokens (--bg, --panel, --accent, etc.) are defined once here as
// global :root custom properties and consumed both by this module's own
// header/footer CSS and by each page's own stylesheet — see the palette
// block inside injectStyle(). A page should reference these var(...)
// names rather than redefining its own palette, so the theme toggle
// here (light/dark/system) covers the whole site from one place.

import {
  NATIVE_DECIMALS,
  NETWORKS,
  abciQuery,
  chainInfoFor,
  fetchNativeBalance,
  fromBaseUnits,
} from "./gno-rpc.js";
import {
  INSTALL_URL,
  clearConnected,
  connect,
  hasStoredConnection,
  isAvailable,
  onAccountChange,
  onNetworkChange,
  waitForAdena,
  markConnected,
} from "./adena-connect.js";

const APP_NAME = "gno.tools";
const USERS_PKGPATH = "gno.land/r/sys/users";

const NAV_LINKS = [
  { href: "wallet-scanner.html", label: "Wallet Scanner", icon: "icons/wallet-scanner.svg" },
  { href: "name-registry.html", label: "Gnoland Name Registry", icon: "icons/name-registry.svg" },
  { href: "vanity-address.html", label: "Vanity Address (Custom Address Generator)", icon: "icons/vanity-address.svg" },
  { href: "address-converter.html", label: "Cosmos Address Converter", icon: "icons/address-converter.svg" },
  { href: "batch-send.html", label: "Batch Send Tokens", icon: "icons/batch-send.svg" },
];

// Soft, client-side-only gate — NOT real access control (this is a static
// site with no server to enforce anything; viewing source or hitting the
// page directly bypasses it trivially). It's for "coming soon" pacing while
// these three tools are still being tested, not for protecting anything
// sensitive — none of them touch anything but the local user's own
// browser-generated data. Add whitelisted gno.land addresses to unlock.
export const GATED_PAGES = new Set(["vanity-address.html", "address-converter.html", "batch-send.html"]);
const WALLET_WHITELIST = [];

// A one-time unlock link — visiting any page with ?on=1 in the URL flips a
// permanent localStorage flag (no wallet needed) that bypasses the gate
// above and the Vanity Address warning overlay. ?on=0 reverses it, clearing
// the flag so the page goes back to normal gated behavior. Checked once at
// module load so it applies before the very first render, not just after a
// re-render.
const UNLOCK_STORAGE_KEY = "gnoTools:unlocked:v1";
const onParam = new URLSearchParams(window.location.search).get("on");
if (onParam === "1") {
  localStorage.setItem(UNLOCK_STORAGE_KEY, "1");
} else if (onParam === "0") {
  localStorage.removeItem(UNLOCK_STORAGE_KEY);
}

export function isUnlocked() {
  return localStorage.getItem(UNLOCK_STORAGE_KEY) === "1";
}

export function isCurrentWalletWhitelisted() {
  if (isUnlocked()) return true;
  return state.status === "connected" && !!state.address && WALLET_WHITELIST.includes(state.address);
}

const LOGO_SVG = `<svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <rect x="1" y="1" width="30" height="30" rx="9" fill="url(#gt-logo-grad)"/>
  <g fill="#081015">
    <rect x="12.5" y="7" width="7" height="6" rx="2.2" fill="none" stroke="#081015" stroke-width="2.6"/>
    <rect x="5" y="13" width="22" height="12.5" rx="2.5"/>
    <rect x="4.3" y="15.5" width="23.4" height="3" fill="url(#gt-logo-grad)"/>
    <rect x="14.3" y="16.3" width="3.4" height="3.4" rx="0.8" fill="url(#gt-logo-grad)"/>
  </g>
  <defs>
    <linearGradient id="gt-logo-grad" x1="1" y1="1" x2="31" y2="31" gradientUnits="userSpaceOnUse">
      <stop stop-color="#7aa3ff"/>
      <stop offset="1" stop-color="#4a72e0"/>
    </linearGradient>
  </defs>
</svg>`;

let state = { status: "idle", address: null, chainId: null, balanceRaw: null, registeredName: null };
const listeners = new Set();

// A full snapshot of the last-known connected wallet (not just the boolean
// "was connected" flag adena-connect.js already tracks) — lets a fresh page
// load render the real connected pill immediately instead of a "Connecting…"
// skeleton, while tryAutoReconnect() quietly confirms/corrects it in the
// background. Set true only while that optimistic render hasn't been
// confirmed yet, so tryAutoReconnect() knows not to stomp it with its own
// "connecting" state.
const WALLET_SNAPSHOT_KEY = "gnoTools:walletSnapshot:v1";
let usingOptimisticSnapshot = false;

function saveWalletSnapshot(s) {
  try {
    localStorage.setItem(WALLET_SNAPSHOT_KEY, JSON.stringify({
      address: s.address, chainId: s.chainId, balanceRaw: s.balanceRaw, registeredName: s.registeredName,
    }));
  } catch {}
}
function loadWalletSnapshot() {
  try {
    const raw = localStorage.getItem(WALLET_SNAPSHOT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function clearWalletSnapshot() {
  try { localStorage.removeItem(WALLET_SNAPSHOT_KEY); } catch {}
}
// A reconnect landing on the same address+chain the snapshot already had
// keeps the cached balance/name in place (refreshWalletInfo updates them
// quietly once it resolves) instead of flashing back to "…" — only a
// genuinely different account clears them.
function connectedPatch(address, chainId) {
  const snap = loadWalletSnapshot();
  const sameAccount = snap && snap.address === address && snap.chainId === chainId;
  return {
    status: "connected",
    address,
    chainId,
    balanceRaw: sameAccount ? snap.balanceRaw : null,
    registeredName: sameAccount ? snap.registeredName : null,
  };
}

function emit() {
  const detail = { ...state };
  // Mirrored onto window so a page's own classic (non-module) <script>
  // can read the current wallet synchronously — e.g. "is a wallet already
  // connected right now" — without needing to import this module or wait
  // for the gnotools:wallet event to fire at least once first.
  window.gnoToolsWallet = detail;
  for (const cb of listeners) cb(detail);
  window.dispatchEvent(new CustomEvent("gnotools:wallet", { detail }));
}

export function onWalletChange(cb) {
  listeners.add(cb);
  cb({ ...state });
  return () => listeners.delete(cb);
}

export function getWallet() {
  return { ...state };
}

// The ONE network list for the whole site — every page gets the same
// switcher with the same two chains, in the header, always visible. This
// used to be a per-page opt-in (a page had to pass its own networkOptions
// to even get a switcher at all), which is why it only ever showed up on
// Wallet Scanner and Name Registry — and even there it was buried inside
// the wallet-connect dropdown, easy to miss entirely. Derived from
// gno-rpc.js's own NETWORKS so there's a single source of truth for the
// key names ("testnet"/"betanet") every page's own network-keyed data
// (e.g. name-registry.html's richer per-network object) should match.
const NETWORK_OPTIONS = Object.entries(NETWORKS).map(([key, net]) => ({
  key, chainId: net.chainId, label: net.label,
}));
const ACTIVE_NETWORK_STORAGE_KEY = "gnoTools:activeNetworkChainId:v1";
let activeNetworkKey = NETWORK_OPTIONS[0]?.key ?? null;
try {
  const storedChainId = localStorage.getItem(ACTIVE_NETWORK_STORAGE_KEY);
  const match = NETWORK_OPTIONS.find((o) => o.chainId === storedChainId);
  if (match) activeNetworkKey = match.key;
} catch {}

export function getActiveNetworkKey() {
  return activeNetworkKey;
}

let networkContainer = null;

// Keeps the header's network pill honest about which chain is actually
// active — activeNetworkKey used to only ever get set once, to the first
// option, at page load, with nothing ever correcting it against the
// WALLET's real connected chain. Confirmed live: a wallet connected on
// mainnet still showed "sapphire-1 (testnet)" highlighted as selected,
// directly under a pill correctly reading "MAINNET" — a real, not just
// confusing, bug: any page driving its own reads off activeNetworkKey
// (e.g. Wallet Scanner deciding which chain to scan) would have silently
// queried the WRONG chain relative to where the wallet actually was.
// Called every time the wallet's real chainId becomes known — connect,
// reconnect, account/network-change events, and the optimistic snapshot
// render on load.
function syncActiveNetworkToWallet() {
  if (state.status !== "connected" || !state.chainId) return;
  const opt = NETWORK_OPTIONS.find((o) => o.chainId === state.chainId);
  if (opt && opt.key !== activeNetworkKey) {
    activeNetworkKey = opt.key;
    try { localStorage.setItem(ACTIVE_NETWORK_STORAGE_KEY, opt.chainId); } catch {}
    emitNetwork();
    if (networkContainer) renderNetworkPicker(networkContainer);
  }
}

function emitNetwork() {
  const opt = NETWORK_OPTIONS.find((o) => o.key === activeNetworkKey);
  window.dispatchEvent(new CustomEvent("gnotools:activenetwork", { detail: opt || null }));
}

function truncateAddr(addr) {
  return addr.length > 14 ? `${addr.slice(0, 7)}…${addr.slice(-5)}` : addr;
}

// A registered name is on-chain, controller-set data, not something this
// site generates — never trusted raw into innerHTML (the pill's own
// idHTML already did this unescaped; closing that gap here too since a
// name is now also used to build a link's href).
function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s ?? "";
  return d.innerHTML;
}

// navigator.clipboard.writeText can reject even in a real browser (no
// permission granted, insecure context) — falls back to the older
// execCommand("copy") path via a throwaway textarea rather than silently
// doing nothing.
async function copyAddress(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // fall through to the legacy path below
    }
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand("copy");
  document.body.removeChild(ta);
  if (!ok) throw new Error("copy failed");
}

function flashCopyBtn(btn, glyph, cls) {
  btn.textContent = glyph;
  btn.classList.add(cls);
  setTimeout(() => {
    btn.textContent = "⧉";
    btn.classList.remove(cls);
  }, 1500);
}

// gno.land addresses derive the same way on every network (chain-id plays
// no part), so a wallet's registered nym is looked up against whichever
// chain it's actually connected to right now via r/sys/users.ResolveAddress
// — best-effort only: not every network has that realm deployed, and a
// lookup failure there just means no name shows, never an error surfaced
// to the user.
function parseRegisteredName(raw) {
  if (!raw) return null;
  const firstLine = raw.trim().split("\n")[0];
  if (/^\(nil\b/.test(firstLine)) return null;
  const m = /"([^"]*)"\s+string\)/.exec(firstLine);
  return m ? m[1] || null : null;
}

async function resolveRegisteredName(chainId, address) {
  const info = chainInfoFor(chainId);
  if (!info.rpcUrl) return null;
  try {
    const raw = await abciQuery({ rpcUrl: info.rpcUrl }, "vm/qeval", `${USERS_PKGPATH}.ResolveAddress("${address}")`);
    return parseRegisteredName(raw);
  } catch {
    return null;
  }
}

// ---------------- theme (light / dark / system) ----------------

const THEME_KEY = "gnoTools:theme";
const THEME_ORDER = ["system", "light", "dark"];
const THEME_LABELS = { system: "System", light: "Light", dark: "Dark" };
const THEME_ICONS = {
  system: `<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>`,
  light: `<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>`,
  dark: `<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z"/></svg>`,
};

function getStoredTheme() {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

// Also called by a tiny inline <script> at the top of each page's <head>
// (before any stylesheet paints) to avoid a flash of the wrong theme on
// reload — this function just needs to stay safe to call twice.
function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === "light" || theme === "dark") root.setAttribute("data-theme", theme);
  else root.removeAttribute("data-theme");
}

// A single click no longer flips the theme directly — going from dark to
// bright (or back) with no warning is jarring, so clicking opens a small
// picker (same dropdown pattern as the wallet bubble) and the theme only
// changes once a specific option is chosen.
let themeBtn = null;
let themeDropdown = null;

function renderThemeButton() {
  if (!themeBtn) return;
  const current = getStoredTheme();
  themeBtn.innerHTML = THEME_ICONS[current];
  themeBtn.title = `Theme: ${THEME_LABELS[current]} (click to choose)`;
}

function renderThemeDropdown() {
  if (!themeDropdown) return;
  const current = getStoredTheme();
  themeDropdown.innerHTML = THEME_ORDER.map(
    (t) => `<button class="gt-theme-opt${t === current ? " gt-on" : ""}" data-theme-choice="${t}">${THEME_ICONS[t]}<span>${THEME_LABELS[t]}</span></button>`
  ).join("");
  themeDropdown.querySelectorAll(".gt-theme-opt").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const choice = btn.dataset.themeChoice;
      try {
        localStorage.setItem(THEME_KEY, choice);
      } catch {}
      applyTheme(choice);
      renderThemeButton();
      renderThemeDropdown();
      themeDropdown.classList.remove("gt-open");
    });
  });
}

function injectStyle() {
  if (document.getElementById("gt-chrome-style")) return;
  const style = document.createElement("style");
  style.id = "gt-chrome-style";
  style.textContent = `
    /* Shared palette — every gno.tools page reads these tokens instead of
       hardcoding colors, so the theme toggle covers the whole site from
       one place. Dark is the site's default identity; light is an
       explicit opt-in or a respected OS preference. */
    :root{
      --bg:#070c14; --bg2:#0c1420; --panel:#0e1826; --panel2:#101b2c;
      --hair:#1c2c4280; --hair2:#25395580;
      --ink:#e7edf7; --muted:#8fa2bd; --faint:#5b6f8c;
      --accent:#5b8dff; --accent-soft:#5b8dff16; --accent-line:#5b8dff45;
      --amber:#f0b357; --amber-soft:#f0b3571a; --amber-line:#f0b35755;
      --warn:#f0b357; --warn-soft:#f0b3571a; --warn-line:#f0b35755;
      --bad:#f0687a; --bad-soft:#f0687a1a;
      --chrome-bg:#0a0f16f2;
      --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
      --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    }
    @media (prefers-color-scheme: light){
      :root:not([data-theme]){
        --bg:#f6f8fa; --bg2:#eef2f5; --panel:#ffffff; --panel2:#f2f5f8;
        --hair:#15233a1f; --hair2:#15233a33;
        --ink:#0e1622; --muted:#4c5c74; --faint:#7c8ba3;
        --accent:#3161d6; --accent-soft:#3161d612; --accent-line:#3161d650;
        --amber:#a86400; --amber-soft:#a864001a; --amber-line:#a8640055;
        --warn:#a86400; --warn-soft:#a864001a; --warn-line:#a8640055;
        --bad:#c1293f; --bad-soft:#c1293f1a;
        --chrome-bg:#ffffffee;
      }
    }
    :root[data-theme="light"]{
      --bg:#f6f8fa; --bg2:#eef2f5; --panel:#ffffff; --panel2:#f2f5f8;
      --hair:#15233a1f; --hair2:#15233a33;
      --ink:#0e1622; --muted:#4c5c74; --faint:#7c8ba3;
      --accent:#3161d6; --accent-soft:#3161d612; --accent-line:#3161d650;
      --amber:#a86400; --amber-soft:#a864001a; --amber-line:#a8640055;
      --warn:#a86400; --warn-soft:#a864001a; --warn-line:#a8640055;
      --bad:#c1293f; --bad-soft:#c1293f1a;
      --chrome-bg:#ffffffee;
    }

    .gt-alpha-banner{background:var(--warn-soft);border-bottom:1px solid var(--warn-line)}
    .gt-alpha-banner-inner{max-width:1080px;margin:0 auto;padding:8px 20px;font-family:var(--sans);
      font-size:12.5px;color:var(--ink);text-align:center}
    .gt-alpha-banner-inner b{color:var(--warn)}
    .gt-header{position:sticky;top:0;z-index:200;background:var(--chrome-bg);backdrop-filter:blur(10px);
      border-bottom:1px solid var(--hair);font-family:var(--sans)}
    .gt-header-row{max-width:1080px;margin:0 auto;padding:12px 20px;display:flex;align-items:center;
      justify-content:space-between;gap:14px;flex-wrap:wrap}
    .gt-brand-group{display:flex;align-items:center;gap:8px}
    .gt-brand{display:flex;align-items:center;gap:9px;text-decoration:none;color:var(--ink)}
    .gt-brand:hover{text-decoration:none;opacity:.9}
    .gt-brand svg{width:26px;height:26px;flex:none}
    .gt-brand .gt-word{font-weight:700;font-size:16px;letter-spacing:-.01em;font-family:var(--mono);text-transform:uppercase}
    .gt-menu-wrap{position:relative}
    .gt-menu-btn{box-sizing:border-box;width:32px;height:32px;padding:0;display:inline-flex;align-items:center;
      justify-content:center;border-radius:8px;border:1px solid var(--hair);background:var(--panel);
      color:var(--muted);cursor:pointer;flex:none}
    .gt-menu-btn:hover{color:var(--ink);border-color:var(--accent-line)}
    .gt-menu-dropdown{position:absolute;top:calc(100% + 8px);left:0;min-width:260px;background:var(--panel);
      border:1px solid var(--hair2);border-radius:12px;padding:6px;box-shadow:0 12px 40px #00000066;
      display:none;flex-direction:column;gap:2px;z-index:210;font-family:var(--mono)}
    .gt-menu-dropdown.gt-open{display:flex}
    .gt-menu-dropdown a{display:flex;align-items:flex-start;gap:10px;padding:8px 10px;border-radius:8px;color:var(--muted);
      text-decoration:none;font-size:13px;line-height:1.3}
    .gt-menu-text-wrap{flex:1;display:flex;flex-direction:column;align-items:flex-start;gap:3px}
    .gt-menu-icon{width:20px;height:20px;border-radius:5px;flex:none;margin-top:1px}
    .gt-menu-dropdown a:hover{background:var(--panel2);color:var(--ink)}
    .gt-menu-dropdown a.gt-on{color:var(--accent);font-weight:600;background:var(--accent-soft)}
    .gt-menu-dropdown a.gt-gated{opacity:.5}
    .gt-menu-dropdown a.gt-gated:hover{opacity:.75}
    .gt-soon{display:inline-block;padding:1px 5px;border-radius:5px;
      background:var(--amber-soft);color:var(--amber);font-size:9px;text-transform:uppercase;
      letter-spacing:.05em}
    .gt-gate-notice{background:var(--panel);border:1px solid var(--amber-line);border-left:4px solid var(--amber);
      border-radius:14px;padding:20px 22px;margin:20px 0;font-family:var(--sans)}
    .gt-gate-notice strong{display:block;color:var(--amber);font-size:15px;margin-bottom:6px}
    .gt-gate-notice p{margin:0;color:var(--muted);font-size:13.5px;line-height:1.5}
    .gt-header-right{display:flex;align-items:center;gap:10px}
    .gt-theme-wrap{position:relative}
    .gt-theme-btn{box-sizing:border-box;width:32px;height:32px;padding:0;display:inline-flex;align-items:center;
      justify-content:center;border-radius:8px;border:1px solid var(--hair);background:var(--panel);
      color:var(--muted);cursor:pointer;flex:none}
    .gt-theme-btn:hover{color:var(--ink);border-color:var(--accent-line)}
    .gt-theme-dropdown{position:absolute;top:calc(100% + 8px);right:0;min-width:150px;background:var(--panel);
      border:1px solid var(--hair2);border-radius:12px;padding:6px;box-shadow:0 12px 40px #00000066;
      display:none;z-index:210}
    .gt-theme-dropdown.gt-open{display:block}
    .gt-theme-opt{width:100%;box-sizing:border-box;display:flex;align-items:center;gap:9px;
      font-family:var(--sans);font-size:13px;padding:8px 10px;border-radius:8px;border:none;
      background:transparent;color:var(--muted);cursor:pointer;text-align:left}
    .gt-theme-opt:hover{background:var(--panel2);color:var(--ink)}
    .gt-theme-opt.gt-on{color:var(--accent);font-weight:600}
    .gt-theme-opt svg{flex:none}
    .gt-net-wrap{position:relative}
    .gt-net-btn{box-sizing:border-box;height:32px;padding:0 11px 0 9px;display:inline-flex;align-items:center;
      gap:7px;border-radius:99px;border:1px solid var(--accent-line);background:var(--accent-soft);
      color:var(--accent);font-family:var(--mono);font-size:12px;font-weight:600;cursor:pointer;flex:none}
    .gt-net-btn:hover{background:rgba(91,141,255,.22)}
    .gt-net-btn .gt-caret{color:currentColor;opacity:.7;font-size:9px}
    .gt-net-dot{width:7px;height:7px;border-radius:50%;background:var(--accent);flex:none}
    .gt-net-btn-main{border-color:var(--amber-line);background:var(--amber-soft);color:var(--amber)}
    .gt-net-btn-main:hover{background:rgba(240,179,87,.22)}
    .gt-net-dot-main{background:var(--amber)}
    .gt-net-dropdown{position:absolute;top:calc(100% + 8px);right:0;min-width:190px;background:var(--panel);
      border:1px solid var(--hair2);border-radius:12px;padding:6px;box-shadow:0 12px 40px #00000066;
      display:none;flex-direction:column;gap:5px;z-index:210;font-family:var(--mono)}
    .gt-net-dropdown.gt-open{display:flex}
    .gt-wallet{position:relative;display:flex;align-items:center;gap:6px;min-height:36px}
    .gt-pill{box-sizing:border-box;min-height:36px;display:flex;align-items:center;gap:9px;
      font-family:var(--mono);font-size:12.5px;padding:6px 10px 6px 14px;border-radius:99px;
      border:1px solid var(--hair);background:var(--panel);color:var(--ink);cursor:pointer}
    .gt-pill:hover{border-color:var(--accent-line)}
    .gt-pill.gt-skeleton{color:var(--muted);cursor:default}
    .gt-pill.gt-disconnected{border-color:var(--accent-line);
      background:linear-gradient(180deg,var(--accent-soft),transparent);color:var(--accent);font-weight:700;
      font-family:var(--sans);padding:0 14px 0 16px;animation:gt-pulse 2s ease-in-out infinite}
    .gt-pill.gt-disconnected:hover{background:var(--accent-soft)}
    @keyframes gt-pulse{
      0%,100%{box-shadow:0 0 0 0 var(--accent-line)}
      50%{box-shadow:0 0 0 7px transparent}
    }
    .gt-pill .gt-dot{width:7px;height:7px;border-radius:50%;background:var(--accent);flex:none}
    .gt-pill .gt-dot-connecting{animation:gt-blink 1s ease-in-out infinite}
    @keyframes gt-blink{0%,100%{opacity:1}50%{opacity:.3}}
    .gt-idband{display:flex;flex-direction:column;line-height:1.2}
    .gt-idband .gt-name{font-weight:700;color:var(--ink);font-size:12.5px}
    .gt-idband .gt-addr-sm{font-size:9.5px;color:var(--faint);letter-spacing:.01em}
    .gt-pill .gt-bal{color:var(--accent);font-weight:600}
    .gt-pill .gt-chain{font-size:10.5px;color:var(--muted);border:1px solid var(--hair2);border-radius:6px;
      padding:2px 6px;text-transform:uppercase;letter-spacing:.04em}
    .gt-pill .gt-caret{color:var(--faint);font-size:9px}
    .gt-dropdown{position:absolute;top:calc(100% + 8px);right:0;min-width:260px;background:var(--panel);
      border:1px solid var(--hair2);border-radius:12px;padding:14px;box-shadow:0 12px 40px #00000066;
      display:none;font-family:var(--mono);z-index:210}
    .gt-dropdown.gt-open{display:block}
    .gt-dropdown .gt-dd-name{display:block;font-family:var(--sans);font-weight:700;font-size:15px;
      color:var(--ink);text-decoration:none;margin-bottom:6px}
    .gt-dropdown .gt-dd-name:hover{color:var(--accent);text-decoration:underline}
    .gt-dropdown .gt-addr-full{display:flex;align-items:center;justify-content:space-between;gap:8px;
      font-size:11.5px;color:var(--muted);
      background:var(--panel2);border:1px solid var(--hair2);border-radius:8px;padding:8px 10px;margin-bottom:10px}
    .gt-dropdown .gt-addr-text{word-break:break-all}
    .gt-copy-btn{flex:none;width:22px;height:22px;padding:0;display:inline-flex;align-items:center;
      justify-content:center;border-radius:6px;border:1px solid var(--hair2);background:var(--panel);
      color:var(--muted);cursor:pointer;font-size:11px}
    .gt-copy-btn:hover{color:var(--ink);border-color:var(--accent-line)}
    .gt-copy-btn.gt-copied{color:var(--accent);border-color:var(--accent-line)}
    .gt-copy-btn.gt-copy-failed{color:var(--bad);border-color:rgba(224,106,106,.34)}
    .gt-dropdown .gt-row{display:flex;justify-content:space-between;font-size:12px;color:var(--muted);
      padding:3px 0}
    .gt-dropdown .gt-row b{color:var(--ink)}
    .gt-dropdown .gt-row .gt-bal-big{font-size:16px}
    .gt-dd-label{font-size:10px;color:var(--faint);text-transform:uppercase;letter-spacing:.08em;
      margin:12px 0 6px}
    .gt-dd-label:first-child{margin-top:0}
    .gt-net-opts{display:flex;flex-direction:column;gap:5px}
    .gt-net-opt{box-sizing:border-box;width:100%;text-align:left;font-family:var(--mono);
      font-size:12px;padding:8px 10px;border-radius:8px;border:1px solid var(--hair);background:var(--panel2);
      color:var(--muted);cursor:pointer}
    .gt-net-opt:hover{color:var(--ink);border-color:var(--accent-line)}
    .gt-net-opt.gt-on{background:var(--accent-soft);color:var(--accent);border-color:var(--accent-line)}
    .gt-disconnect{width:100%;margin-top:12px;font-family:var(--sans);
      font-weight:600;font-size:12.5px;padding:8px 10px;border-radius:8px;border:1px solid var(--bad-soft);
      background:var(--bad-soft);color:var(--bad);cursor:pointer}
    .gt-disconnect:hover{opacity:.85}
    .gt-adena-note{font-size:11px;color:var(--muted);margin-top:10px}
    .gt-adena-note a{color:var(--accent)}
    .gt-footer{position:fixed;left:0;right:0;bottom:0;z-index:150;margin:0;
      background:var(--chrome-bg);backdrop-filter:blur(10px);border-top:1px solid var(--hair);
      padding:12px 20px;font-family:var(--sans)}
    .gt-footer-inner{max-width:1080px;margin:0 auto;color:var(--faint);font-size:11.5px;
      display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
    .gt-footer-text{text-align:left;flex:1;min-width:220px}
    .gt-footer a{color:var(--muted)}
    .gt-footer-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;flex:none}
    @media (max-width:520px){
      .gt-pill .gt-chain{display:none}
    }
  `;
  document.head.appendChild(style);
}

// A gated link stays fully clickable (the target page itself shows the
// "coming soon" notice via gateIfLocked) — this just dims it and adds a
// "soon" badge so it doesn't look like a normal, available tool.
function navLinksHTML() {
  const path = location.pathname.split("/").pop() || "index.html";
  const unlocked = isCurrentWalletWhitelisted();
  return NAV_LINKS.map((l) => {
    const gated = GATED_PAGES.has(l.href) && !unlocked;
    const classes = [l.href === path ? "gt-on" : "", gated ? "gt-gated" : ""].filter(Boolean).join(" ");
    const badge = gated ? '<span class="gt-soon">soon</span>' : "";
    const icon = l.icon ? `<img class="gt-menu-icon" src="${l.icon}" alt="" width="20" height="20">` : "";
    return `<a href="${l.href}"${classes ? ` class="${classes}"` : ""}>${icon}<span class="gt-menu-text-wrap"><span>${l.label}</span>${badge}</span></a>`;
  }).join("");
}

let navEl = null;
function renderNav() {
  if (navEl) navEl.innerHTML = navLinksHTML();
}

// Not dismissable on purpose — this is a standing disclaimer about the
// whole site's maturity, not a one-time notice a returning visitor should
// get to permanently hide. Scrolls away with the page (not sticky) since
// the header's own sticky pill already covers "stays visible."
function buildAlphaBanner() {
  const banner = document.createElement("div");
  banner.className = "gt-alpha-banner";
  banner.innerHTML = `<div class="gt-alpha-banner-inner">⚠ <b>Experimental — alpha/beta.</b> These tools are new and still under active testing. Offered as-is, with no guarantees — verify anything important yourself before relying on it.</div>`;
  return banner;
}

const MENU_ICON_SVG = `<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M3 5.5h14M3 10h14M3 14.5h14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
</svg>`;

function buildHeader() {
  const header = document.createElement("header");
  header.className = "gt-header";

  header.innerHTML = `
    <div class="gt-header-row">
      <div class="gt-brand-group">
        <a class="gt-brand" href="index.html">${LOGO_SVG}<span class="gt-word">gno.tools</span></a>
        <div class="gt-menu-wrap">
          <button class="gt-menu-btn" id="gtMenuBtn" aria-label="Menu">${MENU_ICON_SVG}</button>
          <nav class="gt-menu-dropdown" id="gtMenuDropdown">${navLinksHTML()}</nav>
        </div>
      </div>
      <div class="gt-header-right">
        <div class="gt-theme-wrap">
          <button class="gt-theme-btn" id="gtThemeBtn"></button>
          <div class="gt-theme-dropdown" id="gtThemeDropdown"></div>
        </div>
        <div class="gt-net-wrap" id="gtNet"></div>
        <div class="gt-wallet" id="gtWallet"></div>
      </div>
    </div>
  `;
  navEl = header.querySelector("#gtMenuDropdown");
  return header;
}

function buildFooter() {
  const footer = document.createElement("footer");
  footer.className = "gt-footer";
  footer.innerHTML = `<div class="gt-footer-inner">
    <div class="gt-footer-text">This is an independent, community-built set of
    tools for gno.land — not affiliated with, endorsed by, or part of the gno.land team or
    project.</div>
    <div class="gt-footer-actions">
      <span id="gtFooterSuggest"></span>
      <span id="gtFooterDonate"></span>
    </div>
  </div>`;
  return footer;
}

// null = not checked yet (stay silent — most real visits resolve this in a
// few hundred ms and showing/hiding the note in that window is exactly the
// "expands and contracts" jump that was reported), true/false = resolved.
let adenaAvailable = null;

// Standalone, always-visible network pill — sits next to the theme toggle
// on every page (not gated behind connecting a wallet, not hidden inside
// the wallet dropdown). Color-codes the dot so the difference between
// "testnet, nothing real at stake" and "mainnet, this is real" is visible
// at a glance, not just readable in small text.
function renderNetworkPicker(container) {
  const active = NETWORK_OPTIONS.find((o) => o.key === activeNetworkKey);
  const isMainnet = active?.chainId === "gnoland1";
  container.innerHTML = `
    <button class="gt-net-btn${isMainnet ? " gt-net-btn-main" : ""}" id="gtNetBtn" title="Network — click to switch">
      <span class="gt-net-dot${isMainnet ? " gt-net-dot-main" : ""}"></span>
      <span>${active ? active.label.replace(/\s*\(.*\)$/, "") : "Network"}</span>
      <span class="gt-caret">▾</span>
    </button>
    <div class="gt-net-dropdown" id="gtNetDropdown">
      ${NETWORK_OPTIONS.map((o) => `<button class="gt-net-opt${o.key === activeNetworkKey ? " gt-on" : ""}" data-key="${o.key}">${o.label}</button>`).join("")}
    </div>
  `;
  const btn = container.querySelector("#gtNetBtn");
  const dropdown = container.querySelector("#gtNetDropdown");
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    dropdown.classList.toggle("gt-open");
  });
  container.querySelectorAll(".gt-net-opt").forEach((optBtn) => {
    optBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      dropdown.classList.remove("gt-open");
      selectNetwork(optBtn.dataset.key);
    });
  });
}

// Best-effort: asks Adena to switch the CONNECTED WALLET's real chain, then
// re-reads the account directly (see the comment inside for why — Adena's
// own "changedNetwork" event isn't reliable for a switch the page itself
// just requested). Exported so any page's own "which network" control
// (Wallet Scanner/Name Registry's header dropdown, Batch Send's own
// #previewNetwork select) can drive a real wallet switch through the same
// path instead of each re-implementing it. No-ops quietly if no wallet is
// connected or Adena rejects/doesn't have the chain configured — callers
// that need to know whether it actually landed should compare
// getWallet().chainId afterward.
export async function switchWalletNetwork(chainId) {
  if (state.status !== "connected" || !isAvailable()) return;
  if (chainId === state.chainId) return;
  try {
    await window.adena.SwitchNetwork(chainId);
    const accountRes = await window.adena.GetAccount();
    if (accountRes.status === "success" && accountRes.data) {
      const { address, chainId: newChainId } = accountRes.data;
      if (newChainId !== state.chainId || address !== state.address) {
        setState({ address, chainId: newChainId, balanceRaw: null, registeredName: null });
        refreshWalletInfo();
      }
    }
  } catch {
    // user declined or Adena doesn't have this chain configured — the
    // page's own per-form mismatch notice covers the rest
  }
}

async function selectNetwork(key) {
  if (key === activeNetworkKey) return;
  activeNetworkKey = key;
  const opt = NETWORK_OPTIONS.find((o) => o.key === key);
  if (opt) {
    try { localStorage.setItem(ACTIVE_NETWORK_STORAGE_KEY, opt.chainId); } catch {}
  }
  emitNetwork();
  if (networkContainer) renderNetworkPicker(networkContainer); // reflect the new gt-on highlight
  if (opt) await switchWalletNetwork(opt.chainId);
}

function renderWallet(container) {
  const { status, address, chainId, balanceRaw, registeredName } = state;

  // Renders as a pill (not the disconnected button) so a returning
  // visitor with a stored connection never sees the disconnected shape
  // flash by first — same footprint as the final connected pill, just
  // filling in.
  if (status === "connecting") {
    container.innerHTML = `<div class="gt-pill gt-skeleton"><span class="gt-dot gt-dot-connecting"></span><span>Connecting…</span></div>`;
    return;
  }

  if (status !== "connected") {
    // A single click on the main button connects directly — no intermediate
    // menu. The caret (only rendered when there's actually something to put
    // in it) opens a small dropdown for the "no Adena detected" note — the
    // network picker lives in its own standalone header control now, not
    // buried in here.
    const hasExtras = adenaAvailable === false;
    container.innerHTML = `
      <button class="gt-pill gt-disconnected" id="gtConnectBtn">Connect Adena</button>
      ${hasExtras ? `<button class="gt-theme-btn" id="gtWalletCaret" title="Connection options" aria-label="Connection options">▾</button>` : ""}
      ${hasExtras ? `
        <div class="gt-dropdown" id="gtDropdown">
          <div class="gt-adena-note">No Adena detected — <a href="${INSTALL_URL}" target="_blank" rel="noopener">install it</a>, then reload.</div>
        </div>
      ` : ""}
    `;
    container.querySelector("#gtConnectBtn").addEventListener("click", handleConnect);
    const caret = container.querySelector("#gtWalletCaret");
    if (caret) {
      const dropdown = container.querySelector("#gtDropdown");
      caret.addEventListener("click", (e) => {
        e.stopPropagation();
        dropdown.classList.toggle("gt-open");
      });
    }
    return;
  }

  const info = chainInfoFor(chainId);
  const balText = balanceRaw == null ? "…" : `${fromBaseUnits(balanceRaw, NATIVE_DECIMALS)} GNOT`;
  const idHTML = registeredName
    ? `<span class="gt-idband"><span class="gt-name">@${escapeHtml(registeredName)}</span><span class="gt-addr-sm">${truncateAddr(address)}</span></span>`
    : `<span>${truncateAddr(address)}</span>`;
  const nameLinkHTML = registeredName
    ? `<a class="gt-dd-name" href="name-registry.html?profile=${encodeURIComponent(registeredName)}" target="_blank" rel="noopener">@${escapeHtml(registeredName)} ↗</a>`
    : "";

  container.innerHTML = `
    <button class="gt-pill" id="gtPillBtn" title="${address}">
      <span class="gt-dot"></span>
      ${idHTML}
      <span class="gt-bal">${balText}</span>
      <span class="gt-chain">${info.short}</span>
      <span class="gt-caret">▾</span>
    </button>
    <div class="gt-dropdown" id="gtDropdown">
      ${nameLinkHTML}
      <div class="gt-addr-full">
        <span class="gt-addr-text">${address}</span>
        <button class="gt-copy-btn" id="gtCopyAddr" type="button" title="Copy address" aria-label="Copy address">⧉</button>
      </div>
      <div class="gt-row"><span>Balance</span><b class="gt-bal-big">${balText}</b></div>
      <div class="gt-row"><span>Network</span><b>${info.label}</b></div>
      <button class="gt-disconnect" id="gtDisconnectBtn">Disconnect</button>
    </div>
  `;
  const pillBtn = container.querySelector("#gtPillBtn");
  const dropdown = container.querySelector("#gtDropdown");
  const copyBtn = container.querySelector("#gtCopyAddr");
  copyBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    copyAddress(address)
      .then(() => flashCopyBtn(copyBtn, "✓", "gt-copied"))
      .catch(() => flashCopyBtn(copyBtn, "✕", "gt-copy-failed"));
  });
  pillBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    dropdown.classList.toggle("gt-open");
  });
  container.querySelector("#gtDisconnectBtn").addEventListener("click", handleDisconnect);
}

let walletContainer = null;

function setState(patch) {
  state = { ...state, ...patch };
  if (state.status === "connected") saveWalletSnapshot(state);
  syncActiveNetworkToWallet();
  if (walletContainer) renderWallet(walletContainer);
  renderNav();
  emit();
}

async function refreshWalletInfo() {
  if (state.status !== "connected" || !state.address || !state.chainId) return;
  const { address, chainId } = state;
  const info = chainInfoFor(chainId);
  const tasks = [resolveRegisteredName(chainId, address)];
  if (info.rpcUrl) {
    tasks.push(
      fetchNativeBalance({ rpcUrl: info.rpcUrl }, address).catch(() => null)
    );
  } else {
    tasks.push(Promise.resolve(null));
  }
  const [registeredName, balanceRaw] = await Promise.all(tasks);
  // A network/account change may have landed while these were in flight —
  // only apply results if we're still looking at the same wallet+chain.
  if (state.status === "connected" && state.address === address && state.chainId === chainId) {
    setState({ registeredName, ...(balanceRaw != null ? { balanceRaw } : {}) });
  }
}

// Neither Adena event's own payload is trusted alone — "changedAccount"
// only carries the new address, "changedNetwork" only the new chainId — so
// either one applying just its own field left the OTHER field stale
// (confirmed live: a disconnect/reconnect cycle firing changedAccount left
// the header's chain badge stuck on whatever chainId was already in state,
// even though the wallet had reconnected on a different chain). Re-reading
// the full account via GetAccount() on either event keeps both fields
// honest together.
async function resyncFromAdena() {
  try {
    const res = await window.adena.GetAccount();
    if (res.status !== "success" || !res.data?.address) return handleDisconnect();
    const { address, chainId } = res.data;
    setState({ address, chainId, balanceRaw: null, registeredName: null });
    refreshWalletInfo();
  } catch {
    // best-effort — leave state as-is if Adena can't answer right now
  }
}

// Module-level (not nested in initSiteChrome()) so handleConnect() can
// register these too — a first-ever connect made via the button, rather
// than an auto-reconnect on a returning visit, used to skip registration
// entirely, leaving the page deaf to any later account/network change made
// from inside Adena's own UI until the next full page load.
let accountChangeRegistered = false;
function registerAdenaListenersOnce() {
  if (accountChangeRegistered || !isAvailable()) return;
  accountChangeRegistered = true;
  onAccountChange((address) => {
    if (!address) return handleDisconnect();
    resyncFromAdena();
  });
  onNetworkChange(() => {
    resyncFromAdena();
  });
}

async function handleConnect() {
  setState({ status: "connecting" });
  try {
    const { address, chainId } = await connect(APP_NAME);
    markConnected();
    setState(connectedPatch(address, chainId));
    refreshWalletInfo();
    registerAdenaListenersOnce();
  } catch (err) {
    clearConnected();
    clearWalletSnapshot();
    setState({ status: "idle", address: null, chainId: null, balanceRaw: null, registeredName: null });
    console.warn("gno.tools: Adena connect failed —", err.message);
  }
}

function handleDisconnect() {
  clearConnected();
  clearWalletSnapshot();
  setState({ status: "idle", address: null, chainId: null, balanceRaw: null, registeredName: null });
}

async function tryAutoReconnect() {
  if (!hasStoredConnection()) return;
  if (!(await waitForAdena())) {
    usingOptimisticSnapshot = false;
    clearConnected();
    clearWalletSnapshot();
    setState({ status: "idle", address: null, chainId: null, balanceRaw: null, registeredName: null });
    return;
  }
  // Only drop to the "connecting" skeleton if we don't already have an
  // optimistic snapshot-backed pill showing — otherwise this would flip a
  // perfectly good cached render right back into a loading flash, defeating
  // the whole point of rendering it optimistically in the first place.
  if (!usingOptimisticSnapshot) setState({ status: "connecting" });
  try {
    const { address, chainId } = await connect(APP_NAME);
    usingOptimisticSnapshot = false;
    setState(connectedPatch(address, chainId));
    refreshWalletInfo();
  } catch {
    usingOptimisticSnapshot = false;
    clearConnected();
    clearWalletSnapshot();
    setState({ status: "idle", address: null, chainId: null, balanceRaw: null, registeredName: null });
  }
}

function reserveFooterSpace(footer) {
  const apply = () => { document.body.style.paddingBottom = `${footer.offsetHeight}px`; };
  apply();
  if (window.ResizeObserver) new ResizeObserver(apply).observe(footer);
  else window.addEventListener("resize", apply);
}

// Called by each gated page (vanity-address.html, address-converter.html,
// batch-send.html) early in its own script, passing the container element
// that wraps its real interactive UI. Swaps that container out for a
// "coming soon" notice whenever the connected wallet isn't whitelisted —
// re-evaluated live on every wallet change (connect/disconnect/account
// switch), so connecting the right wallet unlocks the page without a
// reload. A no-op on pages not in GATED_PAGES, so it's safe to call
// unconditionally.
export function gateIfLocked(container) {
  const path = location.pathname.split("/").pop() || "index.html";
  if (!GATED_PAGES.has(path)) return;

  let notice = document.getElementById("gtGateNotice");
  if (!notice) {
    notice = document.createElement("div");
    notice.id = "gtGateNotice";
    notice.className = "gt-gate-notice";
    notice.innerHTML = `<strong>Coming soon</strong><p>This tool is gated to specific wallets while it's being tested. Connect the whitelisted wallet to unlock it.</p>`;
    container.parentNode.insertBefore(notice, container);
  }

  const apply = () => {
    const unlocked = isCurrentWalletWhitelisted();
    container.style.display = unlocked ? "" : "none";
    notice.style.display = unlocked ? "none" : "block";
  };
  apply();
  onWalletChange(apply);
}

// The network picker is a fixed, site-wide control now (see NETWORK_OPTIONS
// above) — no per-page setup needed. Listen for window "gnotools:activenetwork"
// (detail: the selected option, or null) to react to changes.
export function initSiteChrome(opts = {}) {
  injectStyle();
  applyTheme(getStoredTheme()); // redundant with the inline <head> script on pages that have it, harmless either way

  const banner = buildAlphaBanner();
  document.body.insertBefore(banner, document.body.firstChild);
  const header = buildHeader();
  document.body.insertBefore(header, banner.nextSibling);
  const footer = buildFooter();
  document.body.appendChild(footer);
  reserveFooterSpace(footer);

  // Both widgets are self-contained drop-in files (donate-widget.js,
  // suggestions-widget.js) each page's own <head> loads via a plain
  // <script src>, same pattern as adena-compat.js — optional-chained since
  // a page that hasn't added those tags yet just quietly gets no button
  // rather than an error. Suggestions defaults to gno-observer's own
  // collector address on purpose (see that widget's own header comment) —
  // one shared, family-wide feedback inbox across the sibling gno.land
  // tools instead of a separate one per project. Footer is the only mount
  // now — the header used to also carry a slim text-link invite strip,
  // dropped to free up vertical space.
  window.GnoSuggestions?.init({
    appName: APP_NAME,
    mountSelector: "#gtFooterSuggest",
  });
  window.GnoDonate?.init({
    recipient: "g19wlnxmfe39k523khyutvs6wxxurdgc3d2nt00l",
    projectName: "gno.tools",
    appName: APP_NAME,
    mountSelector: "#gtFooterDonate",
  });

  const menuBtn = header.querySelector("#gtMenuBtn");
  const menuDropdown = header.querySelector("#gtMenuDropdown");
  menuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    menuDropdown.classList.toggle("gt-open");
  });

  themeBtn = header.querySelector("#gtThemeBtn");
  themeDropdown = header.querySelector("#gtThemeDropdown");
  renderThemeButton();
  renderThemeDropdown();
  themeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    themeDropdown.classList.toggle("gt-open");
  });

  networkContainer = header.querySelector("#gtNet");
  renderNetworkPicker(networkContainer);

  // A returning visitor (the common case) already has a stored connection.
  // If a full snapshot of that wallet is cached, render the real connected
  // pill immediately — cached balance, name, everything — instead of a
  // "Connecting…" skeleton; tryAutoReconnect() below confirms it silently in
  // the background and only falls back to a visible state change if that
  // verification actually disagrees. No snapshot yet (e.g. first-ever visit
  // after connecting elsewhere) falls back to the skeleton as before.
  if (hasStoredConnection()) {
    const snap = loadWalletSnapshot();
    if (snap && snap.address && snap.chainId) {
      usingOptimisticSnapshot = true;
      state = { ...state, status: "connected", address: snap.address, chainId: snap.chainId, balanceRaw: snap.balanceRaw, registeredName: snap.registeredName };
      syncActiveNetworkToWallet(); // this path sets state directly, bypassing setState()'s own call
    } else {
      state = { ...state, status: "connecting" };
    }
  }

  walletContainer = header.querySelector("#gtWallet");
  renderWallet(walletContainer);

  document.addEventListener("click", (e) => {
    const dropdown = walletContainer?.querySelector("#gtDropdown");
    if (dropdown && !walletContainer.contains(e.target)) dropdown.classList.remove("gt-open");
    if (themeDropdown && !themeBtn.contains(e.target) && !themeDropdown.contains(e.target)) {
      themeDropdown.classList.remove("gt-open");
    }
    const netDropdown = networkContainer?.querySelector("#gtNetDropdown");
    if (netDropdown && !networkContainer.contains(e.target)) netDropdown.classList.remove("gt-open");
    if (!menuBtn.contains(e.target) && !menuDropdown.contains(e.target)) {
      menuDropdown.classList.remove("gt-open");
    }
  });

  waitForAdena().then((ok) => {
    adenaAvailable = ok;
    registerAdenaListenersOnce();
    renderWallet(walletContainer);
  });

  tryAutoReconnect().then(registerAdenaListenersOnce);
}
