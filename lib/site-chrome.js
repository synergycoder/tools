// Shared, persistent site chrome — header (logo, nav, wallet) + footer —
// injected identically on every gno.tools page. One global Adena
// connection lives here (via adena-connect.js's own localStorage flag +
// Adena's own per-domain approval, so it survives reloads and tab
// switches for real, not just in-memory) instead of every page wiring up
// its own Connect button. Read-only: this module never signs anything.

import {
  NATIVE_DECIMALS,
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

const NAV_LINKS = [
  { href: "index.html", label: "Home" },
  { href: "wallet-scanner.html", label: "Wallet Scanner" },
  { href: "name-registry.html", label: "Name Registry" },
];

const LOGO_SVG = `<svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <rect x="1" y="1" width="30" height="30" rx="9" fill="url(#gt-logo-grad)"/>
  <path d="M11 20.5 15.5 11l1.6 3.6L21 11l-4.5 9.5-1.6-3.6-3.9 3.6Z" fill="#081015"/>
  <circle cx="16" cy="16" r="2.1" fill="#081015"/>
  <defs>
    <linearGradient id="gt-logo-grad" x1="1" y1="1" x2="31" y2="31" gradientUnits="userSpaceOnUse">
      <stop stop-color="#5ee6c8"/>
      <stop offset="1" stop-color="#57c6a2"/>
    </linearGradient>
  </defs>
</svg>`;

let state = { status: "idle", address: null, chainId: null, balanceRaw: null };
const listeners = new Set();

function emit() {
  const detail = { ...state };
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

function truncateAddr(addr) {
  return addr.length > 14 ? `${addr.slice(0, 7)}…${addr.slice(-5)}` : addr;
}

function injectStyle() {
  if (document.getElementById("gt-chrome-style")) return;
  const style = document.createElement("style");
  style.id = "gt-chrome-style";
  style.textContent = `
    .gt-header{position:sticky;top:0;z-index:200;background:#0a0f16f2;backdrop-filter:blur(10px);
      border-bottom:1px solid #1c2c4280;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    .gt-header-row{max-width:1080px;margin:0 auto;padding:12px 20px;display:flex;align-items:center;
      justify-content:space-between;gap:14px;flex-wrap:wrap}
    .gt-brand{display:flex;align-items:center;gap:9px;text-decoration:none;color:#e7edf7}
    .gt-brand:hover{text-decoration:none;opacity:.9}
    .gt-brand svg{width:26px;height:26px;flex:none}
    .gt-brand .gt-word{font-weight:700;font-size:16px;letter-spacing:-.01em;
      font-family:ui-monospace,"SF Mono",Consolas,monospace}
    .gt-nav{display:flex;gap:16px;padding:0 20px 11px;max-width:1080px;margin:0 auto;font-size:12.5px}
    .gt-nav a{color:#7e91ac;text-decoration:none;font-family:ui-monospace,"SF Mono",Consolas,monospace}
    .gt-nav a:hover{color:#c7d4e6}
    .gt-nav a.gt-on{color:#5ee6c8;font-weight:600}
    .gt-wallet{position:relative}
    .gt-connect-btn{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-weight:700;
      font-size:13px;padding:9px 16px;border-radius:99px;border:1px solid #5ee6c855;
      background:linear-gradient(180deg,#5ee6c81a,transparent);color:#5ee6c8;cursor:pointer;
      animation:gt-pulse 2s ease-in-out infinite}
    .gt-connect-btn:hover{background:#5ee6c82a}
    .gt-connect-btn:disabled{opacity:.6;cursor:default;animation:none}
    @keyframes gt-pulse{
      0%,100%{box-shadow:0 0 0 0 #5ee6c855}
      50%{box-shadow:0 0 0 7px #5ee6c800}
    }
    .gt-pill{display:flex;align-items:center;gap:9px;font-family:ui-monospace,"SF Mono",Consolas,monospace;
      font-size:12.5px;padding:7px 8px 7px 14px;border-radius:99px;border:1px solid #1c2c4280;
      background:#0e1826;color:#e7edf7;cursor:pointer}
    .gt-pill:hover{border-color:#5ee6c855}
    .gt-pill .gt-dot{width:7px;height:7px;border-radius:50%;background:#5ee6c8;flex:none}
    .gt-pill .gt-bal{color:#5ee6c8;font-weight:600}
    .gt-pill .gt-chain{font-size:10.5px;color:#8fa2bd;border:1px solid #25395580;border-radius:6px;
      padding:2px 6px;text-transform:uppercase;letter-spacing:.04em}
    .gt-pill .gt-caret{color:#5b6f8c;font-size:9px}
    .gt-dropdown{position:absolute;top:calc(100% + 8px);right:0;min-width:250px;background:#0e1826;
      border:1px solid #1c2c42;border-radius:12px;padding:14px;box-shadow:0 12px 40px #00000066;
      display:none;font-family:ui-monospace,"SF Mono",Consolas,monospace;z-index:210}
    .gt-dropdown.gt-open{display:block}
    .gt-dropdown .gt-addr-full{font-size:11.5px;color:#8fa2bd;word-break:break-all;
      background:#101b2c;border:1px solid #25395580;border-radius:8px;padding:8px 10px;margin-bottom:10px}
    .gt-dropdown .gt-row{display:flex;justify-content:space-between;font-size:12px;color:#8fa2bd;
      padding:3px 0}
    .gt-dropdown .gt-row b{color:#e7edf7}
    .gt-disconnect{width:100%;margin-top:10px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      font-weight:600;font-size:12.5px;padding:8px 10px;border-radius:8px;border:1px solid #f0687a55;
      background:#f0687a1a;color:#f0687a;cursor:pointer}
    .gt-disconnect:hover{background:#f0687a2a}
    .gt-adena-note{font-size:11px;color:#8fa2bd;margin-top:2px}
    .gt-adena-note a{color:#5ee6c8}
    .gt-footer{max-width:1080px;margin:40px auto 0;padding:22px 20px 40px;
      border-top:1px solid #1c2c4280;color:#5b6f8c;font-size:12px;text-align:center;
      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    .gt-footer a{color:#7e91ac}
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
      <div class="gt-wallet" id="gtWallet"></div>
    </div>
    <nav class="gt-nav">${navHtml}</nav>
  `;
  return header;
}

function buildFooter() {
  const footer = document.createElement("footer");
  footer.className = "gt-footer";
  footer.innerHTML = `This is an independent, community-built set of tools for gno.land — not
    affiliated with, endorsed by, or part of the gno.land team or project. Nothing here ever
    touches a private key or signs a transaction without going through your own wallet's popup.`;
  return footer;
}

function renderWallet(container) {
  const { status, address, chainId, balanceRaw } = state;

  if (status !== "connected") {
    const connecting = status === "connecting";
    container.innerHTML = `
      <button class="gt-connect-btn" id="gtConnectBtn" ${connecting ? "disabled" : ""}>
        ${connecting ? "Connecting…" : "Connect Adena"}
      </button>
      ${!isAvailable() ? `<div class="gt-adena-note">No Adena detected — <a href="${INSTALL_URL}" target="_blank" rel="noopener">install it</a>.</div>` : ""}
    `;
    const btn = container.querySelector("#gtConnectBtn");
    if (btn) btn.addEventListener("click", handleConnect);
    return;
  }

  const info = chainInfoFor(chainId);
  const balText = balanceRaw == null ? "…" : `${fromBaseUnits(balanceRaw, NATIVE_DECIMALS)} GNOT`;

  container.innerHTML = `
    <button class="gt-pill" id="gtPillBtn" title="${address}">
      <span class="gt-dot"></span>
      <span>${truncateAddr(address)}</span>
      <span class="gt-bal">${balText}</span>
      <span class="gt-chain">${info.short}</span>
      <span class="gt-caret">▾</span>
    </button>
    <div class="gt-dropdown" id="gtDropdown">
      <div class="gt-addr-full">${address}</div>
      <div class="gt-row"><span>Balance</span><b>${balText}</b></div>
      <div class="gt-row"><span>Network</span><b>${info.label}</b></div>
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
}

let walletContainer = null;

function setState(patch) {
  state = { ...state, ...patch };
  if (walletContainer) renderWallet(walletContainer);
  emit();
}

async function refreshBalance() {
  if (state.status !== "connected" || !state.address || !state.chainId) return;
  const info = chainInfoFor(state.chainId);
  if (!info.rpcUrl) return;
  try {
    const raw = await fetchNativeBalance({ rpcUrl: info.rpcUrl }, state.address);
    setState({ balanceRaw: raw });
  } catch {
    // Balance is best-effort display only — leave the last known value.
  }
}

async function handleConnect() {
  setState({ status: "connecting" });
  try {
    const { address, chainId } = await connect(APP_NAME);
    markConnected();
    setState({ status: "connected", address, chainId, balanceRaw: null });
    refreshBalance();
  } catch (err) {
    clearConnected();
    setState({ status: "idle", address: null, chainId: null, balanceRaw: null });
    console.warn("gno.tools: Adena connect failed —", err.message);
  }
}

function handleDisconnect() {
  clearConnected();
  setState({ status: "idle", address: null, chainId: null, balanceRaw: null });
}

async function tryAutoReconnect() {
  if (!hasStoredConnection()) return;
  if (!(await waitForAdena())) return;
  setState({ status: "connecting" });
  try {
    const { address, chainId } = await connect(APP_NAME);
    setState({ status: "connected", address, chainId, balanceRaw: null });
    refreshBalance();
  } catch {
    clearConnected();
    setState({ status: "idle", address: null, chainId: null, balanceRaw: null });
  }
}

export function initSiteChrome() {
  injectStyle();

  const header = buildHeader();
  document.body.insertBefore(header, document.body.firstChild);
  document.body.appendChild(buildFooter());

  walletContainer = header.querySelector("#gtWallet");
  renderWallet(walletContainer);

  document.addEventListener("click", (e) => {
    const dropdown = walletContainer?.querySelector("#gtDropdown");
    if (dropdown && !walletContainer.contains(e.target)) dropdown.classList.remove("gt-open");
  });

  let accountChangeRegistered = false;
  function registerAdenaListenersOnce() {
    if (accountChangeRegistered || !isAvailable()) return;
    accountChangeRegistered = true;
    onAccountChange((address) => {
      if (!address) return handleDisconnect();
      setState({ address, balanceRaw: null });
      refreshBalance();
    });
    onNetworkChange((chainId) => {
      setState({ chainId, balanceRaw: null });
      refreshBalance();
    });
  }

  waitForAdena().then(() => {
    registerAdenaListenersOnce();
    renderWallet(walletContainer); // clears the "install Adena" note once it's detected
  });

  tryAutoReconnect().then(registerAdenaListenersOnce);
}
