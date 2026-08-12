// Tiny localStorage cache helper shared by every gno.tools page that wants
// to show "what was already loaded" instantly on return instead of an empty
// state, with an explicit way to force a fresh fetch. Originally built
// inline in wallet-scanner.html; extracted here so the same pattern doesn't
// get re-invented (and re-drifted) on every other page that needs it.

export function saveCache(key, data) {
  try { localStorage.setItem(key, JSON.stringify({ ...data, cachedAt: Date.now() })); } catch {}
}

export function loadCache(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function formatAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
