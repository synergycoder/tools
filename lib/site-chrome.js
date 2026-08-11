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
  { href: "index.html", label: "Home" },
  { href: "wallet-scanner.html", label: "Wallet Scanner" },
  { href: "name-registry.html", label: "Name Registry" },
  { href: "vanity-address.html", label: "Vanity Address" },
  { href: "address-converter.html", label: "Address Converter" },
  { href: "batch-send.html", label: "Batch Send" },
];

const LOGO_SVG = `<svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <rect x="1" y="1" width="30" height="30" rx="9" fill="url(#gt-logo-grad)"/>
  <g transform="rotate(-30 16 16)" fill="#081015" fill-rule="evenodd">
    <path d="M11.5 4 H20.5 V11 H11.5 Z M14.3 4 H17.7 V7.2 H14.3 Z"/>
    <rect x="14.3" y="11" width="3.4" height="10" rx="1.2" fill-rule="nonzero"/>
    <path d="M12.8 21 H19.2 V27 H12.8 Z M14.3 23.8 H17.7 V27 H14.3 Z"/>
  </g>
  <defs>
    <linearGradient id="gt-logo-grad" x1="1" y1="1" x2="31" y2="31" gradientUnits="userSpaceOnUse">
      <stop stop-color="#5ee6c8"/>
      <stop offset="1" stop-color="#57c6a2"/>
    </linearGradient>
  </defs>
</svg>`;

let state = { status: "idle", address: null, chainId: null, balanceRaw: null, registeredName: null };
const listeners = new Set();

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

// A page's own "which network do I read/write from" options — e.g.
// name-registry.html only knows sapphire-1/gnoland1, wallet-scanner.html
// only knows topaz-1/gnoland1. Rendered inside the same wallet bubble
// (not a separate control next to it) so there's exactly one place to
// manage connection + network, whether or not a wallet is connected yet.
let networkOptions = [];
let activeNetworkKey = null;

export function getActiveNetworkKey() {
  return activeNetworkKey;
}

function emitNetwork() {
  const opt = networkOptions.find((o) => o.key === activeNetworkKey);
  window.dispatchEvent(new CustomEvent("gnotools:activenetwork", { detail: opt || null }));
}

function truncateAddr(addr) {
  return addr.length > 14 ? `${addr.slice(0, 7)}…${addr.slice(-5)}` : addr;
}

// gno.land addresses derive the same way on every network (chain-id plays
// no part), so a wallet's registered nym is looked up against whichever
// chain it's actually connected to right now via r/sys/users.ResolveAddress
// — best-effort only: not every network has that realm deployed (e.g.
// topaz-1 doesn't), and a lookup failure there just means no name shows,
// never an error surfaced to the user.
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
  system: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>`,
  light: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>`,
  dark: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z"/></svg>`,
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
      --accent:#5ee6c8; --accent-soft:#5ee6c81a; --accent-line:#5ee6c855;
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
        --accent:#0f9c7e; --accent-soft:#0f9c7e14; --accent-line:#0f9c7e55;
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
      --accent:#0f9c7e; --accent-soft:#0f9c7e14; --accent-line:#0f9c7e55;
      --amber:#a86400; --amber-soft:#a864001a; --amber-line:#a8640055;
      --warn:#a86400; --warn-soft:#a864001a; --warn-line:#a8640055;
      --bad:#c1293f; --bad-soft:#c1293f1a;
      --chrome-bg:#ffffffee;
    }

    .gt-header{position:sticky;top:0;z-index:200;background:var(--chrome-bg);backdrop-filter:blur(10px);
      border-bottom:1px solid var(--hair);font-family:var(--sans)}
    .gt-header-row{max-width:1080px;margin:0 auto;padding:12px 20px;display:flex;align-items:center;
      justify-content:space-between;gap:14px;flex-wrap:wrap}
    .gt-brand{display:flex;align-items:center;gap:9px;text-decoration:none;color:var(--ink)}
    .gt-brand:hover{text-decoration:none;opacity:.9}
    .gt-brand svg{width:26px;height:26px;flex:none}
    .gt-brand .gt-word{font-weight:700;font-size:16px;letter-spacing:-.01em;font-family:var(--mono)}
    .gt-nav{display:flex;gap:16px;padding:0 20px 11px;max-width:1080px;margin:0 auto;font-size:12.5px}
    .gt-nav a{color:var(--faint);text-decoration:none;font-family:var(--mono)}
    .gt-nav a:hover{color:var(--muted)}
    .gt-nav a.gt-on{color:var(--accent);font-weight:600}
    .gt-header-right{display:flex;align-items:center;gap:10px}
    .gt-theme-wrap{position:relative}
    .gt-theme-btn{box-sizing:border-box;width:32px;height:32px;display:inline-flex;align-items:center;
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
    .gt-wallet{position:relative;display:flex;align-items:center;min-height:36px}
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
    .gt-dropdown .gt-addr-full{font-size:11.5px;color:var(--muted);word-break:break-all;
      background:var(--panel2);border:1px solid var(--hair2);border-radius:8px;padding:8px 10px;margin-bottom:10px}
    .gt-dropdown .gt-row{display:flex;justify-content:space-between;font-size:12px;color:var(--muted);
      padding:3px 0}
    .gt-dropdown .gt-row b{color:var(--ink)}
    .gt-dd-label{font-size:10px;color:var(--faint);text-transform:uppercase;letter-spacing:.08em;
      margin:12px 0 6px}
    .gt-dd-label:first-child{margin-top:0}
    .gt-net-opts{display:flex;flex-direction:column;gap:5px}
    .gt-net-opt{box-sizing:border-box;width:100%;text-align:left;font-family:var(--mono);
      font-size:12px;padding:8px 10px;border-radius:8px;border:1px solid var(--hair);background:var(--panel2);
      color:var(--muted);cursor:pointer}
    .gt-net-opt:hover{color:var(--ink);border-color:var(--accent-line)}
    .gt-net-opt.gt-on{background:var(--accent-soft);color:var(--accent);border-color:var(--accent-line)}
    .gt-connect-action{width:100%;box-sizing:border-box;font-family:var(--sans);
      font-weight:700;font-size:13px;padding:9px 12px;border-radius:9px;border:1px solid var(--accent-line);
      background:var(--accent-soft);color:var(--accent);cursor:pointer}
    .gt-connect-action:hover{background:var(--accent-line)}
    .gt-disconnect{width:100%;margin-top:12px;font-family:var(--sans);
      font-weight:600;font-size:12.5px;padding:8px 10px;border-radius:8px;border:1px solid var(--bad-soft);
      background:var(--bad-soft);color:var(--bad);cursor:pointer}
    .gt-disconnect:hover{opacity:.85}
    .gt-adena-note{font-size:11px;color:var(--muted);margin-top:10px}
    .gt-adena-note a{color:var(--accent)}
    .gt-footer{position:fixed;left:0;right:0;bottom:0;z-index:150;margin:0;
      background:var(--chrome-bg);backdrop-filter:blur(10px);border-top:1px solid var(--hair);
      padding:12px 20px;font-family:var(--sans)}
    .gt-footer-inner{max-width:1080px;margin:0 auto;color:var(--faint);font-size:11.5px;text-align:center}
    .gt-footer a{color:var(--muted)}
    @media (max-width:520px){
      .gt-nav{gap:12px}
      .gt-pill .gt-chain{display:none}
    }
  `;
  document.head.appendChild(style);
}

function buildHeader() {
  const header = document.createElement("header");
  header.className = "gt-header";

  const path = location.pathname.split("/").pop() || "index.html";
  const navHtml = NAV_LINKS.map(
    (l) => `<a href="${l.href}"${l.href === path ? ' class="gt-on"' : ""}>${l.label}</a>`
  ).join("");

  header.innerHTML = `
    <div class="gt-header-row">
      <a class="gt-brand" href="index.html">${LOGO_SVG}<span class="gt-word">gno.tools</span></a>
      <div class="gt-header-right">
        <div class="gt-theme-wrap">
          <button class="gt-theme-btn" id="gtThemeBtn"></button>
          <div class="gt-theme-dropdown" id="gtThemeDropdown"></div>
        </div>
        <div class="gt-wallet" id="gtWallet"></div>
      </div>
    </div>
    <nav class="gt-nav">${navHtml}</nav>
  `;
  return header;
}

function buildFooter() {
  const footer = document.createElement("footer");
  footer.className = "gt-footer";
  footer.innerHTML = `<div class="gt-footer-inner">This is an independent, community-built set of
    tools for gno.land — not affiliated with, endorsed by, or part of the gno.land team or
    project. Nothing here ever touches a private key or signs a transaction without going
    through your own wallet's popup.</div>`;
  return footer;
}

// null = not checked yet (stay silent — most real visits resolve this in a
// few hundred ms and showing/hiding the note in that window is exactly the
// "expands and contracts" jump that was reported), true/false = resolved.
let adenaAvailable = null;

function networkOptionsHTML() {
  if (!networkOptions.length) return "";
  return `
    <div class="gt-dd-label">Network</div>
    <div class="gt-net-opts">
      ${networkOptions.map((o) => `<button class="gt-net-opt${o.key === activeNetworkKey ? " gt-on" : ""}" data-key="${o.key}">${o.label}</button>`).join("")}
    </div>
  `;
}

function wireNetworkOptions(container) {
  container.querySelectorAll(".gt-net-opt").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      selectNetwork(btn.dataset.key);
    });
  });
}

async function selectNetwork(key) {
  if (key === activeNetworkKey) return;
  activeNetworkKey = key;
  emitNetwork();
  if (walletContainer) renderWallet(walletContainer); // reflect the new gt-on highlight
  if (state.status !== "connected" || !isAvailable()) return;
  const opt = networkOptions.find((o) => o.key === key);
  if (!opt || opt.chainId === state.chainId) return;
  // Best-effort — Adena's own changedNetwork event (already wired below)
  // updates state.chainId and re-renders once this actually lands.
  try {
    await window.adena.SwitchNetwork(opt.chainId);
  } catch {
    // user declined or Adena doesn't have this chain configured — the
    // page's own per-form mismatch notice covers the rest
  }
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
    container.innerHTML = `
      <button class="gt-pill gt-disconnected" id="gtBubbleBtn">Connect Adena<span class="gt-caret">▾</span></button>
      <div class="gt-dropdown" id="gtDropdown">
        <button class="gt-connect-action" id="gtConnectBtn">Connect Adena</button>
        ${adenaAvailable === false ? `<div class="gt-adena-note">No Adena detected — <a href="${INSTALL_URL}" target="_blank" rel="noopener">install it</a>, then reload.</div>` : ""}
        ${networkOptionsHTML()}
      </div>
    `;
    const bubbleBtn = container.querySelector("#gtBubbleBtn");
    const dropdown = container.querySelector("#gtDropdown");
    bubbleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      dropdown.classList.toggle("gt-open");
    });
    container.querySelector("#gtConnectBtn").addEventListener("click", handleConnect);
    wireNetworkOptions(container);
    return;
  }

  const info = chainInfoFor(chainId);
  const balText = balanceRaw == null ? "…" : `${fromBaseUnits(balanceRaw, NATIVE_DECIMALS)} GNOT`;
  const idHTML = registeredName
    ? `<span class="gt-idband"><span class="gt-name">@${registeredName}</span><span class="gt-addr-sm">${truncateAddr(address)}</span></span>`
    : `<span>${truncateAddr(address)}</span>`;

  container.innerHTML = `
    <button class="gt-pill" id="gtPillBtn" title="${address}">
      <span class="gt-dot"></span>
      ${idHTML}
      <span class="gt-bal">${balText}</span>
      <span class="gt-chain">${info.short}</span>
      <span class="gt-caret">▾</span>
    </button>
    <div class="gt-dropdown" id="gtDropdown">
      <div class="gt-addr-full">${registeredName ? `@${registeredName} · ` : ""}${address}</div>
      <div class="gt-row"><span>Balance</span><b>${balText}</b></div>
      <div class="gt-row"><span>Wallet's chain</span><b>${info.label}</b></div>
      ${networkOptionsHTML()}
      <button class="gt-disconnect" id="gtDisconnectBtn">Disconnect</button>
    </div>
  `;
  const pillBtn = container.querySelector("#gtPillBtn");
  const dropdown = container.querySelector("#gtDropdown");
  pillBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    dropdown.classList.toggle("gt-open");
  });
  container.querySelector("#gtDisconnectBtn").addEventListener("click", handleDisconnect);
  wireNetworkOptions(container);
}

let walletContainer = null;

function setState(patch) {
  state = { ...state, ...patch };
  if (walletContainer) renderWallet(walletContainer);
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

async function handleConnect() {
  setState({ status: "connecting" });
  try {
    const { address, chainId } = await connect(APP_NAME);
    markConnected();
    setState({ status: "connected", address, chainId, balanceRaw: null, registeredName: null });
    refreshWalletInfo();
  } catch (err) {
    clearConnected();
    setState({ status: "idle", address: null, chainId: null, balanceRaw: null, registeredName: null });
    console.warn("gno.tools: Adena connect failed —", err.message);
  }
}

function handleDisconnect() {
  clearConnected();
  setState({ status: "idle", address: null, chainId: null, balanceRaw: null, registeredName: null });
}

async function tryAutoReconnect() {
  if (!hasStoredConnection()) return;
  if (!(await waitForAdena())) {
    clearConnected();
    setState({ status: "idle", address: null, chainId: null, balanceRaw: null, registeredName: null });
    return;
  }
  setState({ status: "connecting" });
  try {
    const { address, chainId } = await connect(APP_NAME);
    setState({ status: "connected", address, chainId, balanceRaw: null, registeredName: null });
    refreshWalletInfo();
  } catch {
    clearConnected();
    setState({ status: "idle", address: null, chainId: null, balanceRaw: null, registeredName: null });
  }
}

function reserveFooterSpace(footer) {
  const apply = () => { document.body.style.paddingBottom = `${footer.offsetHeight}px`; };
  apply();
  if (window.ResizeObserver) new ResizeObserver(apply).observe(footer);
  else window.addEventListener("resize", apply);
}

// opts.networkOptions: [{ key, chainId, label }, ...] — a page's own list
// of networks it knows how to read/write, rendered inside the wallet
// bubble's dropdown. The first entry is the default active network.
// Listen for window "gnotools:activenetwork" (detail: the selected
// option, or null) to react to changes.
export function initSiteChrome(opts = {}) {
  networkOptions = opts.networkOptions || [];
  activeNetworkKey = networkOptions[0]?.key ?? null;

  injectStyle();
  applyTheme(getStoredTheme()); // redundant with the inline <head> script on pages that have it, harmless either way

  const header = buildHeader();
  document.body.insertBefore(header, document.body.firstChild);
  const footer = buildFooter();
  document.body.appendChild(footer);
  reserveFooterSpace(footer);

  themeBtn = header.querySelector("#gtThemeBtn");
  themeDropdown = header.querySelector("#gtThemeDropdown");
  renderThemeButton();
  renderThemeDropdown();
  themeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    themeDropdown.classList.toggle("gt-open");
  });

  // A returning visitor (the common case) already has a stored connection —
  // start the wallet slot in its "connecting" shape from the very first
  // paint instead of flashing the disconnected button first, since that
  // button->pill shape swap mid-load was the visible "jump" on every nav.
  if (hasStoredConnection()) state = { ...state, status: "connecting" };

  walletContainer = header.querySelector("#gtWallet");
  renderWallet(walletContainer);

  document.addEventListener("click", (e) => {
    const dropdown = walletContainer?.querySelector("#gtDropdown");
    if (dropdown && !walletContainer.contains(e.target)) dropdown.classList.remove("gt-open");
    if (themeDropdown && !themeBtn.contains(e.target) && !themeDropdown.contains(e.target)) {
      themeDropdown.classList.remove("gt-open");
    }
  });

  let accountChangeRegistered = false;
  function registerAdenaListenersOnce() {
    if (accountChangeRegistered || !isAvailable()) return;
    accountChangeRegistered = true;
    onAccountChange((address) => {
      if (!address) return handleDisconnect();
      setState({ address, balanceRaw: null, registeredName: null });
      refreshWalletInfo();
    });
    onNetworkChange((chainId) => {
      setState({ chainId, balanceRaw: null, registeredName: null });
      refreshWalletInfo();
    });
  }

  waitForAdena().then((ok) => {
    adenaAvailable = ok;
    registerAdenaListenersOnce();
    renderWallet(walletContainer);
  });

  tryAutoReconnect().then(registerAdenaListenersOnce);
}
