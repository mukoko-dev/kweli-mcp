/**
 * Kweli places map — the MCP App (ported from mukoko-dev/kweli
 * `lib/mcp/places-app.ts`; keep the two in step until that route retires) (io.modelcontextprotocol/ui) that hosts
 * render for `search_places` results: a map of rating pins over a row of
 * place cards. Selecting a place calls `get_place` back through the host
 * and opens a small detail card under the map.
 *
 * Served as the `ui://kweli/places-map.html` resource (see
 * `apps/mcp/src/mcp.ts`). The document is self-contained: the host renders
 * it in a sandboxed iframe whose CSP only admits the origins declared in
 * PLACES_APP_CSP, so every script, style and image origin it uses must be
 * listed there.
 *
 * Colours mirror the mineral tokens in mukoko-dev/kweli's `app/globals.css` (the iframe
 * cannot read the app's stylesheet): Malachite is Kweli's brand overlay,
 * and the verification tiers keep their own minerals. Host theme
 * variables win where the host supplies them.
 *
 * No place text is ever written as HTML — every value goes through
 * `textContent` — because place names and descriptions are community data.
 */

export const PLACES_APP_URI = "ui://kweli/places-map.html";
export const PLACES_APP_MIME = "text/html;profile=mcp-app";

const LEAFLET = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4";

/** Every external origin the view touches. Hosts build the iframe CSP from this. */
export const PLACES_APP_CSP = {
  resourceDomains: [
    "https://cdnjs.cloudflare.com",
    "https://*.tile.openstreetmap.org",
    // Place photos — the same image hosts the web app's CSP admits.
    "https://*.public.blob.vercel-storage.com",
    "https://*.googleusercontent.com",
    "https://tdcpuzqyoodrdsxldgsh.supabase.co",
    "https://cdn.brandfetch.io",
  ],
  connectDomains: [] as string[],
};

export const PLACES_APP_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Kweli places</title>
<link rel="stylesheet" href="${LEAFLET}/leaflet.min.css" />
<style>
  :root {
    --bg: var(--color-background-primary, #ffffff);
    --surface: var(--color-background-secondary, #f4f3f0);
    --fg: var(--color-text-primary, #141413);
    --muted: var(--color-text-secondary, #5f5e5a);
    --line: var(--color-border-primary, #e5e4e1);
    --brand: #004d40;
    --brand-fg: #ffffff;
    --pin: #ffffff;
    --pin-fg: #141413;
    --t1: #8b4513; --t2: #0047ab; --t3: #8b5a00; --t4: #4b0082;
    --radius-card: 14px;
    --radius-inner: 7px;
    color-scheme: light;
  }
  :root[data-theme="dark"] {
    --bg: var(--color-background-primary, #1f1e1d);
    --surface: var(--color-background-secondary, #2a2927);
    --fg: var(--color-text-primary, #f5f4ef);
    --muted: var(--color-text-secondary, #b4b2a9);
    --line: var(--color-border-primary, #3a3936);
    --brand: #64ffda;
    --brand-fg: #00251a;
    --pin: #2a2927;
    --pin-fg: #f5f4ef;
    --t1: #e07a4d; --t2: #64b5f6; --t3: #ffd740; --t4: #b388ff;
    color-scheme: dark;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--bg); color: var(--fg);
    font: 14px/1.4 var(--font-sans, "Noto Sans", system-ui, sans-serif); }
  .card { border: 1px solid var(--line); border-radius: var(--radius-card); overflow: hidden; background: var(--bg); }
  .head { display: flex; align-items: center; gap: 8px; padding: 12px 14px; border-bottom: 1px solid var(--line); font-weight: 600; }
  .head svg { flex: none; color: var(--brand); }
  .stage { position: relative; }
  #map { height: 340px; background: var(--surface); }
  :root[data-theme="dark"] #map .leaflet-tile-pane { filter: invert(1) hue-rotate(180deg) brightness(0.9) contrast(0.9); }
  .nomap #map { display: none; }
  .pin { display: inline-flex; align-items: center; gap: 3px; padding: 3px 9px; border-radius: 999px;
    background: var(--pin); color: var(--pin-fg); border: 1px solid var(--line);
    font-weight: 600; font-size: 13px; white-space: nowrap; box-shadow: 0 1px 4px rgba(0,0,0,.25); cursor: pointer; }
  .pin.on { background: var(--brand); color: var(--brand-fg); border-color: var(--brand); }
  .leaflet-div-icon { background: none; border: none; }
  .row { display: flex; gap: 10px; overflow-x: auto; scroll-snap-type: x mandatory; padding: 10px 12px 12px; }
  .stage .row { position: absolute; left: 0; right: 0; bottom: 0; z-index: 500; }
  .nomap .stage .row { position: static; }
  .place { flex: 0 0 auto; width: min(300px, 82vw); display: flex; gap: 10px; align-items: center; padding: 8px;
    border-radius: var(--radius-card); border: 1px solid var(--line); background: var(--bg); color: var(--fg);
    scroll-snap-align: start; cursor: pointer; text-align: left; font: inherit; box-shadow: 0 2px 8px rgba(0,0,0,.18); }
  .place.on { border-color: var(--brand); box-shadow: 0 0 0 2px var(--brand); }
  .place:focus-visible, .btn:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
  .thumb { flex: none; width: 64px; height: 64px; border-radius: var(--radius-inner); background: var(--surface);
    object-fit: cover; display: grid; place-items: center; font: 600 22px/1 var(--font-serif, "Noto Serif", Georgia, serif); color: var(--muted); }
  .name { font: 600 16px/1.25 var(--font-serif, "Noto Serif", Georgia, serif); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .meta { color: var(--muted); font-size: 13px; margin-top: 2px; }
  .detail { border-top: 1px solid var(--line); padding: 14px; display: none; }
  .detail.open { display: block; }
  .detail h3 { margin: 0 0 4px; font: 600 18px/1.25 var(--font-serif, "Noto Serif", Georgia, serif); }
  .tier { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; text-transform: capitalize; margin: 6px 0; }
  .tier i { width: 10px; height: 10px; border-radius: 50%; background: var(--muted); display: inline-block; }
  .tier[data-t="1"] i { background: var(--t1); } .tier[data-t="2"] i { background: var(--t2); }
  .tier[data-t="3"] i { background: var(--t3); } .tier[data-t="4"] i { background: var(--t4); }
  .lines { margin: 8px 0 12px; display: grid; gap: 4px; color: var(--muted); }
  .desc { margin: 0 0 12px; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; }
  .btn { min-height: 40px; padding: 0 16px; border-radius: 999px; border: 1px solid var(--line); background: var(--bg);
    color: var(--fg); font: 600 14px/1 inherit; cursor: pointer; }
  .btn.primary { background: var(--brand); color: var(--brand-fg); border-color: var(--brand); }
  .empty { padding: 18px 14px; color: var(--muted); }
</style>
</head>
<body>
<div class="card" id="app">
  <div class="head">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/></svg>
    <span id="title">Searching Kweli places…</span>
  </div>
  <div class="stage"><div id="map"></div><div class="row" id="row" role="list"></div></div>
  <div class="detail" id="detail" aria-live="polite"></div>
</div>
<script src="${LEAFLET}/leaflet.min.js"></script>
<script>
(function () {
  "use strict";
  var nextId = 1, pending = {};
  var root = document.documentElement;
  var places = [], markers = {}, map = null, selected = null;

  function post(msg) { window.parent.postMessage(msg, "*"); }
  function request(method, params) {
    var id = nextId++;
    post({ jsonrpc: "2.0", id: id, method: method, params: params });
    return new Promise(function (resolve, reject) { pending[id] = { resolve: resolve, reject: reject }; });
  }
  function notify(method, params) { post({ jsonrpc: "2.0", method: method, params: params || {} }); }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function stars(r) { return r && r.value ? String(Math.round(r.value * 10) / 10) + " \\u2605" : ""; }
  function metaLine(p) {
    var bits = [];
    if (p.rating && p.rating.value) bits.push(stars(p.rating) + (p.rating.count ? " " + p.rating.count : ""));
    if (p.type) bits.push(String(p.type).replace(/([a-z])([A-Z])/g, "$1 $2"));
    if (p.city) bits.push(p.city);
    return bits.join(" \\u00b7 ");
  }
  function applyTheme(ctx) {
    if (!ctx) return;
    if (ctx.theme) root.setAttribute("data-theme", ctx.theme);
    var vars = ctx.styles && ctx.styles.variables;
    if (vars) Object.keys(vars).forEach(function (k) { if (vars[k]) root.style.setProperty(k, vars[k]); });
  }
  function openLink(url) { if (url) request("ui/open-link", { url: url }).catch(function () {}); }

  function thumb(p) {
    if (p.image) {
      var img = el("img", "thumb");
      img.alt = ""; img.loading = "lazy"; img.src = p.image;
      img.onerror = function () { img.replaceWith(letter(p)); };
      return img;
    }
    return letter(p);
  }
  function letter(p) { return el("div", "thumb", (p.name || "?").charAt(0).toUpperCase()); }

  function select(id, pan) {
    selected = id;
    Array.prototype.forEach.call(document.querySelectorAll(".place"), function (c) {
      c.classList.toggle("on", c.getAttribute("data-id") === id);
    });
    Object.keys(markers).forEach(function (k) {
      var node = markers[k].getElement && markers[k].getElement();
      if (node) node.firstChild && node.firstChild.classList.toggle("on", k === id);
      if (k === id) markers[k].setZIndexOffset(1000); else markers[k].setZIndexOffset(0);
    });
    var p = places.filter(function (x) { return x.id === id; })[0];
    if (!p) return;
    if (pan && map && p.lat != null) map.panTo([p.lat, p.lng], { animate: true });
    var card = document.querySelector('.place[data-id="' + id.replace(/"/g, "") + '"]');
    if (card && card.scrollIntoView) card.scrollIntoView({ behavior: "smooth", inline: "start", block: "nearest" });
    showDetail(p);
  }

  function showDetail(p) {
    var d = document.getElementById("detail");
    d.textContent = "";
    d.classList.add("open");
    d.appendChild(el("h3", null, p.name));
    d.appendChild(el("div", "meta", metaLine(p)));
    var tier = el("div", "tier"); tier.setAttribute("data-t", String(p.tier || 0));
    tier.appendChild(el("i")); tier.appendChild(el("span", null, p.tierLabel || "unverified"));
    d.appendChild(tier);
    var lines = el("div", "lines", "Loading details\\u2026");
    d.appendChild(lines);
    var actions = el("div", "actions");
    var open = el("button", "btn primary", "Open in Kweli");
    open.type = "button"; open.onclick = function () { openLink(p.url); };
    actions.appendChild(open);
    d.appendChild(actions);

    request("tools/call", { name: "get_place", arguments: { id: p.id } }).then(function (res) {
      if (selected !== p.id) return;
      var s = res && res.structuredContent;
      lines.textContent = "";
      if (!s) { lines.textContent = ""; return; }
      var addr = s.address ? [s.address.street, s.address.city, s.address.region].filter(Boolean).join(", ") : "";
      if (addr) lines.appendChild(el("div", null, addr));
      if (s.description) d.insertBefore(el("p", "desc", s.description), actions);
      if (s.phone) {
        var call = el("button", "btn", "Call " + s.phone); call.type = "button";
        call.onclick = function () { openLink("tel:" + String(s.phone).replace(/[^+0-9]/g, "")); };
        actions.appendChild(call);
      }
      if (s.website) {
        var web = el("button", "btn", "Website"); web.type = "button";
        web.onclick = function () { openLink(s.website); };
        actions.appendChild(web);
      }
      if (s.url) p.url = s.url;
    }).catch(function () { if (selected === p.id) lines.textContent = ""; });
  }

  function render(data) {
    places = (data && data.places) || [];
    var title = "Places";
    if (data && data.query && data.city) title = "\\u201c" + data.query + "\\u201d in " + data.city;
    else if (data && data.city) title = "Places in " + data.city;
    else if (data && data.query) title = "Places matching \\u201c" + data.query + "\\u201d";
    document.getElementById("title").textContent = title;

    var row = document.getElementById("row");
    row.textContent = "";
    if (!places.length) {
      document.getElementById("app").classList.add("nomap");
      row.appendChild(el("div", "empty", "No places matched that search yet."));
      return;
    }
    places.forEach(function (p) {
      var c = el("button", "place"); c.type = "button"; c.setAttribute("role", "listitem");
      c.setAttribute("data-id", p.id);
      c.appendChild(thumb(p));
      var body = el("div"); body.appendChild(el("div", "name", p.name)); body.appendChild(el("div", "meta", metaLine(p)));
      c.appendChild(body);
      c.onclick = function () { select(p.id, true); };
      row.appendChild(c);
    });

    var geo = places.filter(function (p) { return p.lat != null && p.lng != null; });
    if (!window.L || !geo.length) { document.getElementById("app").classList.add("nomap"); return; }
    map = window.L.map("map", { zoomControl: false, attributionControl: true });
    window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: "\\u00a9 OpenStreetMap"
    }).addTo(map);
    geo.forEach(function (p) {
      var label = document.createElement("span");
      label.className = "pin";
      label.textContent = p.rating && p.rating.value ? stars(p.rating) : p.name.charAt(0).toUpperCase();
      var icon = window.L.divIcon({ html: label.outerHTML, className: "", iconSize: null });
      var m = window.L.marker([p.lat, p.lng], { icon: icon, title: p.name, keyboard: true }).addTo(map);
      m.on("click", function () { select(p.id, false); });
      markers[p.id] = m;
    });
    var bounds = window.L.latLngBounds(geo.map(function (p) { return [p.lat, p.lng]; }));
    // Leave room for the card row along the bottom edge.
    map.fitBounds(bounds, { paddingTopLeft: [30, 30], paddingBottomRight: [30, 110], maxZoom: 15 });
  }

  window.addEventListener("message", function (ev) {
    var m = ev.data;
    if (!m || m.jsonrpc !== "2.0") return;
    if (m.id != null && pending[m.id] && !m.method) {
      var p = pending[m.id]; delete pending[m.id];
      if (m.error) p.reject(m.error); else p.resolve(m.result);
      return;
    }
    if (m.method === "ui/notifications/tool-input") {
      var a = (m.params && m.params.arguments) || {};
      if (a.city || a.query) document.getElementById("title").textContent =
        "Searching " + (a.query ? "\\u201c" + a.query + "\\u201d " : "places ") + (a.city ? "in " + a.city : "") + "\\u2026";
    } else if (m.method === "ui/notifications/tool-result") {
      render(m.params && m.params.structuredContent);
    } else if (m.method === "ui/notifications/host-context-changed") {
      applyTheme(m.params);
    }
  });

  if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) root.setAttribute("data-theme", "dark");

  request("ui/initialize", {
    protocolVersion: "2026-01-26",
    appInfo: { name: "Kweli places", version: "1.0.0" },
    appCapabilities: {}
  }).then(function (res) {
    applyTheme(res && res.hostContext);
    notify("ui/notifications/initialized");
  }).catch(function () { notify("ui/notifications/initialized"); });

  if (window.ResizeObserver) {
    new ResizeObserver(function () {
      var r = document.getElementById("app").getBoundingClientRect();
      notify("ui/notifications/size-changed", { width: Math.ceil(r.width), height: Math.ceil(r.height) + 2 });
    }).observe(document.getElementById("app"));
  }
})();
</script>
</body>
</html>
`;
