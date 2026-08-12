// gno-suggestions-widget.js — a self-contained, drop-in "Suggestions" button +
// overlay for any static gno.land dashboard/site. Real on-chain feature
// requests + voting: a suggestion is a tiny memo-bearing send
// ("gnobs:suggest:<text>"), a vote is another tiny send
// ("gnobs:vote:<txHash>"), both to one collector address. No backend —
// existing suggestions are read straight off the indexer.
//
// Ported from gno-observer's own Suggestions tab (index.html's
// ensureAdenaConnected/signMemoTx/sendSuggestion/sendVote/loadSuggestions),
// which is why this defaults to gno-observer's own collector address —
// pointing multiple sibling gno.land tools at the same address and memo
// convention gives them one shared, family-wide feedback inbox instead of
// each spinning up its own. Override `address` if you want a separate one.
//
// USAGE (copy this file into your project, then in your page):
//   <script src="suggestions-widget.js"></script>
//   <script>
//     GnoSuggestions.init({
//       address: "g1...",                // collector address — defaults to gno-observer's
//       appName: "My Project",           // passed to Adena's AddEstablish (per-site whitelist name)
//       chainId: "sapphire-1",           // network the collector address lives on
//       rpcUrl: "https://rpc.sapphire.testnets.gno.land",
//       indexerUrl: "https://indexer.sapphire.testnets.gno.land/graphql/query",
//       mountSelector: "#suggestSlot",   // where to insert the trigger button
//     });
//   </script>
//
// Design notes for reuse across the sibling gno.land projects (see
// ~/gno-land-dev-notes.md): self-contained — own CSS (scoped under
// .gnosuggest- class names), own Adena connection state, no external
// dependencies beyond the indexer's GraphQL endpoint. Drop the file in,
// call GnoSuggestions.init() once, done.

(function () {
  "use strict";

  const GNOT_ADDRESS_RE = /^g1[a-z0-9]{38}$/;
  const SUGGEST_MEMO_PREFIX = "gnobs:suggest:";
  const VOTE_MEMO_PREFIX = "gnobs:vote:";
  const SUGGESTION_SEND_AMOUNT = "1ugnot"; // dust — the memo is the actual payload, not the transfer
  const DEFAULT_ADDRESS = "g1hxsz6mnhjx2n75xr2vpe6tytdk8jj4p49gcsug"; // gno-observer's own collector

  function injectStyles() {
    if (document.getElementById("gnosuggest-styles")) return;
    const style = document.createElement("style");
    style.id = "gnosuggest-styles";
    style.textContent = `
      .gnosuggest-trigger {
        display: inline-flex; align-items: center; gap: 0.4rem;
        font-family: inherit; font-size: 0.92rem; font-weight: 600;
        padding: 0.5rem 0.9rem; border-radius: 8px; cursor: pointer;
        border: 1px dashed rgba(94,230,200,0.5); background: none;
        color: inherit;
      }
      .gnosuggest-trigger:hover { background: rgba(94,230,200,0.1); }
      .gnosuggest-overlay {
        position: fixed; inset: 0; background: rgba(0,0,0,0.55);
        display: flex; align-items: center; justify-content: center;
        z-index: 9999; padding: 1rem;
      }
      .gnosuggest-modal {
        background: var(--bg-elevated, #1c1c1e); color: var(--text, #f2f2f2);
        border: 1px solid var(--border, #333); border-radius: 12px;
        padding: 1.5rem; max-width: 480px; width: 100%; max-height: 85vh;
        overflow-y: auto; box-shadow: 0 20px 60px rgba(0,0,0,0.4);
        font-family: inherit;
      }
      .gnosuggest-modal h3 { margin: 0 0 0.3rem; font-size: 1.15rem; }
      .gnosuggest-modal .gnosuggest-sub { font-size: 0.85rem; opacity: 0.7; margin: 0 0 1rem; }
      .gnosuggest-close {
        float: right; background: none; border: none; font-size: 1.2rem;
        cursor: pointer; color: inherit; opacity: 0.6; line-height: 1;
      }
      .gnosuggest-close:hover { opacity: 1; }
      .gnosuggest-modal textarea {
        width: 100%; box-sizing: border-box; padding: 0.6rem;
        border-radius: 8px; border: 1px solid var(--border, #333);
        background: transparent; color: inherit; font-family: inherit;
        font-size: 0.88rem; resize: vertical; min-height: 4rem;
      }
      .gnosuggest-form-row {
        display: flex; align-items: center; justify-content: space-between;
        margin-top: 0.5rem; gap: 0.6rem;
      }
      .gnosuggest-form-row button {
        padding: 0.5rem 0.9rem; border-radius: 8px; border: 1px solid #5ee6c8;
        background: none; color: #5ee6c8; font-family: inherit; font-weight: 700;
        font-size: 0.9rem; cursor: pointer; white-space: nowrap;
      }
      .gnosuggest-form-row button:hover { background: rgba(94,230,200,0.12); }
      .gnosuggest-form-row button:disabled { opacity: 0.5; cursor: default; }
      .gnosuggest-status { margin-top: 0.6rem; font-size: 0.85rem; min-height: 1.2em; opacity: 0.85; }
      .gnosuggest-list-head { margin-top: 1.3rem; font-size: 0.95rem; font-weight: 700; }
      .gnosuggest-list { margin-top: 0.6rem; display: flex; flex-direction: column; gap: 0.5rem; }
      .gnosuggest-card {
        display: flex; align-items: flex-start; gap: 0.7rem;
        padding: 0.7rem 0.8rem; border-radius: 8px; border: 1px solid var(--border, #333);
      }
      .gnosuggest-text { flex: 1; min-width: 0; overflow-wrap: break-word; font-size: 0.9rem; }
      .gnosuggest-meta { color: var(--text-muted, #888); font-size: 0.78rem; margin-top: 0.3rem; }
      .gnosuggest-meta a { color: inherit; }
      .gnosuggest-vote {
        flex: none; display: flex; flex-direction: column; align-items: center; gap: 0.1rem;
        padding: 0.4rem 0.6rem; border-radius: 8px; border: 1px solid var(--border, #333);
        background: none; color: inherit; cursor: pointer; font-family: inherit;
      }
      .gnosuggest-vote:hover { border-color: #5ee6c8; color: #5ee6c8; }
      .gnosuggest-vote:disabled { opacity: 0.5; cursor: default; }
      .gnosuggest-vote .count { font-size: 1.05rem; font-weight: 700; }
      .gnosuggest-spinner {
        display: inline-block; width: 0.9em; height: 0.9em; margin-right: 0.4em;
        border: 2px solid currentColor; border-right-color: transparent;
        border-radius: 50%; vertical-align: -0.15em;
        animation: gnosuggest-spin 0.7s linear infinite;
      }
      @keyframes gnosuggest-spin { to { transform: rotate(360deg); } }
    `;
    document.head.appendChild(style);
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function truncateAddress(addr) {
    return addr && addr.length > 14 ? `${addr.slice(0, 6)}...${addr.slice(-6)}` : (addr || "");
  }

  function formatDate(iso) {
    if (!iso) return "unknown time";
    try {
      return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    } catch {
      return iso;
    }
  }

  // Same timeout-guarded fetch pattern as gno-tools' own lib/gno-rpc.js —
  // this indexer has been observed hanging (never responding, no error) in
  // sibling-project development, not paranoia.
  async function graphqlQuery(indexerUrl, query, timeoutMs = 20000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(indexerUrl, {
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
    const json = await res.json();
    if (json.errors) throw new Error(json.errors[0].message);
    return json.data;
  }

  async function fetchBlockTimes(indexerUrl, heights) {
    const result = new Map();
    await Promise.all(heights.map(async (h) => {
      try {
        const data = await graphqlQuery(indexerUrl, `query { getBlocks(where: { height: { eq: ${h} } }) { height time } }`);
        const b = (data.getBlocks || [])[0];
        if (b) result.set(b.height, b.time);
      } catch {
        // leave this height unresolved rather than failing the whole load
      }
    }));
    return result;
  }

  function gnoscanTxUrl(hash) {
    return `https://gnoscan.io/transactions/details?txhash=${encodeURIComponent(hash)}`;
  }

  async function ensureAdenaConnected(appName) {
    if (typeof window.adena === "undefined") {
      throw new Error("Adena not detected — install it from adena.app, then reload the page.");
    }
    const establishRes = await window.adena.AddEstablish(appName);
    const alreadyConnected = /already connected/i.test(establishRes.message || "");
    if (establishRes.status !== "success" && !alreadyConnected) {
      throw new Error(establishRes.message || "Connection request was not approved.");
    }
    const accountRes = await window.adena.GetAccount();
    if (accountRes.status !== "success" || !accountRes.data || !accountRes.data.address) {
      throw new Error(accountRes.message || "Could not read the connected account.");
    }
    return accountRes.data.address;
  }

  async function signMemoTx(fromAddress, memo, config) {
    const res = await window.adena.DoContract({
      messages: [{
        type: "/bank.MsgSend",
        value: { from_address: fromAddress, to_address: config.address, amount: SUGGESTION_SEND_AMOUNT },
      }],
      memo,
      // Pins the tx to the network the collector address actually lives on,
      // regardless of whichever chain the user's own Adena happens to have
      // selected — without this, a suggestion/vote can sign successfully on
      // the wrong chain and loadSuggestions() (always reading from
      // config.chainId) would never see it. Same fix as gno-observer's own
      // signMemoTx() and this project's donate-widget.js.
      networkInfo: { chainId: config.chainId, rpcUrl: config.rpcUrl },
    });
    if (res.status !== "success") throw new Error(res.message || "Transaction was not approved.");
    return res;
  }

  function buildModal(config) {
    const overlay = document.createElement("div");
    overlay.className = "gnosuggest-overlay";

    const modal = document.createElement("div");
    modal.className = "gnosuggest-modal";
    modal.innerHTML = `
      <button class="gnosuggest-close" aria-label="Close">✕</button>
      <h3>💡 Suggestions</h3>
      <p class="gnosuggest-sub">Suggestions and votes are real signed transactions — a tiny memo-bearing send to a shared collector address, ${escapeHtml(config.chainId)} only. No account, no backend — just your wallet.</p>
      <textarea id="gnosuggest-input" placeholder="Suggest a feature or change…" maxlength="200" rows="3"></textarea>
      <div class="gnosuggest-form-row">
        <span id="gnosuggest-char-count" style="font-size:0.8rem;opacity:0.7">0 / 200</span>
        <button id="gnosuggest-send-btn">Send suggestion</button>
      </div>
      <p class="gnosuggest-status" id="gnosuggest-send-status"></p>
      <div class="gnosuggest-list-head">Existing suggestions</div>
      <p class="gnosuggest-status" id="gnosuggest-list-status">Loading…</p>
      <div class="gnosuggest-list" id="gnosuggest-list"></div>
    `;
    overlay.appendChild(modal);

    const input = modal.querySelector("#gnosuggest-input");
    const charCount = modal.querySelector("#gnosuggest-char-count");
    const sendBtn = modal.querySelector("#gnosuggest-send-btn");
    const sendStatus = modal.querySelector("#gnosuggest-send-status");
    const listStatus = modal.querySelector("#gnosuggest-list-status");
    const listEl = modal.querySelector("#gnosuggest-list");

    let sendInFlight = false;
    let voteInFlight = false;
    let listInFlight = false;

    input.addEventListener("input", () => {
      charCount.textContent = `${input.value.length} / 200`;
    });

    async function loadSuggestions() {
      if (listInFlight) return;
      listInFlight = true;
      listStatus.textContent = "Loading…";
      try {
        const query = `query {
          getTransactions(where: {
            success: { eq: true },
            messages: { value: { BankMsgSend: { to_address: { eq: "${config.address}" } } } }
          }) {
            hash
            block_height
            memo
            messages { value { ... on BankMsgSend { from_address to_address } } }
          }
        }`;
        const data = await graphqlQuery(config.indexerUrl, query);
        const txs = data.getTransactions || [];

        // `like` filtering isn't reliable on this indexer, so every send to
        // the collector address is fetched and split into suggestions vs.
        // votes by memo prefix client-side instead of in the query.
        const suggestions = new Map();
        const pendingVotes = [];
        for (const tx of txs) {
          const memo = tx.memo || "";
          const msg = (tx.messages || [])[0];
          const from = msg && msg.value && msg.value.from_address;
          if (!from) continue;
          if (memo.startsWith(SUGGEST_MEMO_PREFIX)) {
            const text = memo.slice(SUGGEST_MEMO_PREFIX.length).trim();
            if (text) suggestions.set(tx.hash, { hash: tx.hash, text, from, blockHeight: tx.block_height, voters: new Set() });
          } else if (memo.startsWith(VOTE_MEMO_PREFIX)) {
            pendingVotes.push({ target: memo.slice(VOTE_MEMO_PREFIX.length).trim(), from });
          }
        }
        // A Set per suggestion means repeat votes from the same address
        // (double clicks, voting again later) only ever count once.
        for (const v of pendingVotes) {
          const s = suggestions.get(v.target);
          if (s) s.voters.add(v.from);
        }

        const rows = [...suggestions.values()].sort((a, b) =>
          b.voters.size - a.voters.size || b.blockHeight - a.blockHeight
        );

        const heights = [...new Set(rows.map(r => r.blockHeight))];
        const blockTimes = heights.length ? await fetchBlockTimes(config.indexerUrl, heights) : new Map();
        for (const r of rows) r.blockTime = blockTimes.get(r.blockHeight) || null;

        renderList(rows);
        listStatus.textContent = rows.length
          ? `${rows.length} suggestion${rows.length === 1 ? "" : "s"}.`
          : "No suggestions yet — be the first.";
      } catch (err) {
        listStatus.textContent = "Failed to load: " + err.message;
      } finally {
        listInFlight = false;
      }
    }

    function renderList(rows) {
      listEl.innerHTML = rows.map(r => `
        <div class="gnosuggest-card">
          <div class="gnosuggest-text">
            ${escapeHtml(r.text)}
            <div class="gnosuggest-meta">by ${escapeHtml(truncateAddress(r.from))} · ${escapeHtml(formatDate(r.blockTime))} ·
              <a href="${gnoscanTxUrl(r.hash)}" target="_blank" rel="noopener">view tx ↗</a></div>
          </div>
          <button class="gnosuggest-vote" data-hash="${escapeHtml(r.hash)}"
            title="Vote for this suggestion — signs a small on-chain transaction via Adena">
            <span class="count">${r.voters.size}</span>
            <span>+1</span>
          </button>
        </div>
      `).join("");
    }

    async function sendSuggestion() {
      if (sendInFlight) return;
      const text = input.value.trim();
      if (!text) {
        sendStatus.textContent = "Write a suggestion first.";
        return;
      }
      sendInFlight = true;
      sendBtn.disabled = true;
      sendBtn.innerHTML = '<span class="gnosuggest-spinner"></span>Waiting for wallet…';
      sendStatus.textContent = "Connecting to Adena and requesting your signature…";
      try {
        const address = await ensureAdenaConnected(config.appName);
        await signMemoTx(address, SUGGEST_MEMO_PREFIX + text, config);
        sendStatus.textContent = "Submitted! It can take a few seconds to be indexed — reopen this to refresh.";
        input.value = "";
        charCount.textContent = "0 / 200";
        setTimeout(loadSuggestions, 4000);
      } catch (err) {
        sendStatus.textContent = "Failed: " + err.message;
      } finally {
        sendInFlight = false;
        sendBtn.disabled = false;
        sendBtn.textContent = "Send suggestion";
      }
    }

    async function sendVote(hash, btn) {
      if (voteInFlight) return;
      voteInFlight = true;
      const originalHTML = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<span class="gnosuggest-spinner"></span>';
      listStatus.textContent = "";
      try {
        const address = await ensureAdenaConnected(config.appName);
        await signMemoTx(address, VOTE_MEMO_PREFIX + hash, config);
        listStatus.textContent = "Vote submitted! Refreshing…";
        setTimeout(loadSuggestions, 4000);
      } catch (err) {
        listStatus.textContent = "Vote failed: " + err.message;
        btn.disabled = false;
        btn.innerHTML = originalHTML;
      } finally {
        voteInFlight = false;
      }
    }

    sendBtn.addEventListener("click", sendSuggestion);
    listEl.addEventListener("click", (e) => {
      const btn = e.target.closest(".gnosuggest-vote");
      if (btn) sendVote(btn.dataset.hash, btn);
    });

    function close() { overlay.remove(); }
    modal.querySelector(".gnosuggest-close").addEventListener("click", close);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    document.addEventListener("keydown", function escHandler(e) {
      if (e.key === "Escape") { close(); document.removeEventListener("keydown", escHandler); }
    });

    loadSuggestions();

    return overlay;
  }

  const GnoSuggestions = {
    init(userConfig) {
      const config = Object.assign({
        address: DEFAULT_ADDRESS,
        appName: "GnoSuggestions",
        chainId: "sapphire-1",
        rpcUrl: "https://rpc.sapphire.testnets.gno.land",
        indexerUrl: "https://indexer.sapphire.testnets.gno.land/graphql/query",
        mountSelector: null,
        buttonText: "💡 Suggestions",
      }, userConfig || {});

      if (!config.address || !GNOT_ADDRESS_RE.test(config.address)) {
        console.error(
          "GnoSuggestions.init(): `address` must be a real gno bech32 address (g1...) — " +
          "refusing to render a suggestions button against an invalid/placeholder address."
        );
        return null;
      }

      injectStyles();

      const trigger = document.createElement("button");
      trigger.type = "button";
      trigger.className = "gnosuggest-trigger";
      trigger.textContent = config.buttonText;
      trigger.addEventListener("click", () => {
        document.body.appendChild(buildModal(config));
      });

      const mount = config.mountSelector ? document.querySelector(config.mountSelector) : null;
      if (mount) mount.appendChild(trigger);
      else document.body.appendChild(trigger);

      return trigger;
    },
  };

  window.GnoSuggestions = GnoSuggestions;
})();
