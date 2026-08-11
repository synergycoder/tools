// Intentionally (almost) empty.
//
// Adena's content script computes its own webpack publicPath by scanning the
// host page's <script> tags for one with an absolute http(s) src. A page with
// only inline scripts has nothing to find and Adena silently fails to inject
// window.adena. The mere PRESENCE of this external <script src> tag in the page
// is enough to satisfy that fallback. Do not remove it.
// (Discovered/documented in ~/gno-land-dev-notes.md.)
window.__adenaCompatLoaded = true;
