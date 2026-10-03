import { sparkline, ring, lineChart, bars, calibration, pairBars, showTip, hideTip } from "./charts.js";

/* ---------------------------------------------------------------- basics */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const api = (p, o) => fetch(p, o).then((r) => { if (!r.ok) throw new Error(p + " " + r.status); return r.json(); });
const post = (p) => api(p, { method: "POST" });
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const hm = (min) => { const h = Math.floor(min / 60), m = Math.round(min % 60); return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`; };
const pct = (v, d = 0) => (Math.min(v, 0.99) * 100).toFixed(d) + "%";
const pctx = (v, d = 1) => (v * 100).toFixed(d) + "%";
const LV = { 1: ["Normal", "var(--lv1)"], 2: ["Busy", "var(--lv2)"], 3: ["Surge", "var(--lv3)"], 4: ["Critical", "var(--lv4)"] };
const STATUS = { occupied: "Occupied", clean: "Clean, ready", cleaning: "Being cleaned", dirty: "Waiting for cleaning", reserved: "Reserved for an incoming patient" };
const SVC = { critical: "Critical care", stepdown: "Step-down", cardiac: "Cardiac", medicine: "Medicine", surgical: "Surgery", ortho: "Orthopedics", peds: "Pediatrics", maternity: "Maternity" };
const SRC = { ED: "Emergency", ELECTIVE: "Post-op", MAT: "Labour & delivery", DIRECT: "Direct admit", ICU: "ICU step-down" };
const FLOORS = [["6", ["SURG", "ORTH"]], ["5", ["CARD"]], ["4", ["MEDA", "MEDB"]], ["3", ["ICU", "SDU"]], ["2", ["MAT", "PEDS"]]];
const state = { layout: null, live: null, metrics: null };
let UNITS = {};

/* ---------------------------------------------------------------- preferences (accessibility) */
const PREF_KEY = "wardline.prefs";
const prefs = Object.assign({ theme: "dark", cvd: "default", motion: "system", fs: 1, density: "comfortable", tables: false, announce: true },
  (() => { try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {}; } catch { return {}; } })());
function applyPrefs() {
  const h = document.documentElement;
  h.dataset.theme = prefs.theme; h.dataset.cvd = prefs.cvd;
  h.style.setProperty("--fs", prefs.fs);
  h.classList.toggle("reduce-motion", prefs.motion === "reduced");
  h.classList.toggle("force-motion", prefs.motion === "full");
  h.classList.toggle("compact", prefs.density === "compact");
  try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { /* private mode */ }
}
applyPrefs();
const announce = (msg) => { if (!prefs.announce) return; const sr = $("#sr"); sr.textContent = ""; setTimeout(() => (sr.textContent = msg), 40); };
function toast(title, sub = "", icon = "✓") {
  const t = document.createElement("div");
  t.className = "toast";
  t.innerHTML = `<span class="ti">${icon}</span><div><b>${esc(title)}</b>${sub ? `<small>${esc(sub)}</small>` : ""}</div>`;
  $("#toasts").append(t);
  setTimeout(() => { t.style.transition = "opacity .4s, transform .4s"; t.style.opacity = 0; t.style.transform = "translateY(8px)"; setTimeout(() => t.remove(), 400); }, 3800);
}
const reduced = () => document.documentElement.classList.contains("reduce-motion") || (prefs.motion !== "full" && matchMedia("(prefers-reduced-motion: reduce)").matches);
function countUp(root) {
  for (const el of $$("[data-count]", root)) {
    const end = +el.dataset.count, dec = +(el.dataset.dec || 0), pre = el.dataset.pre || "", suf = el.dataset.suf || "";
    const f = (v) => pre + v.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec }) + suf;
    if (reduced()) { el.textContent = f(end); continue; }
    const t0 = performance.now(), dur = 1100 + Math.random() * 300;
    const step = (t) => { const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 4); el.textContent = f(end * e); if (k < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }
}

/* ---------------------------------------------------------------- router */
const VIEWS = {
  command: { title: "Command center", sub: "Live house-wide view", render: renderCommand },
  placement: { title: "Bed placement", sub: "Every waiting patient, matched to the best bed in one pass", render: renderPlacement },
  discharges: { title: "Discharges", sub: "Who is likely to leave, and what is holding them", render: renderDischarges },
  forecast: { title: "Forecast", sub: "Arrivals and census, 24 to 72 hours ahead", render: renderForecast },
  replay: { title: "Replay & proof", sub: "The last week, hour by hour, and what the placement engine changed", render: renderReplay },
};
let firstRoute = true, stopReplay = null;
async function route() {
  const key = (location.hash.match(/^#\/(\w+)/) || [, "command"])[1];
  const v = VIEWS[key] ? key : "command";
  $$(".nav a").forEach((a) => (a.dataset.view === v ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
  $("#crumb-sec").textContent = VIEWS[v].title;
  $("#crumb-sub").textContent = VIEWS[v].sub;
  document.title = `${VIEWS[v].title} · Wardline`;
  stopReplay?.(); stopReplay = null;
  const view = $("#view");
  view.innerHTML = "";
  hideTip();
  await VIEWS[v].render(view);
  countUp(view);
  if (!firstRoute) { $("#main").focus({ preventScroll: true }); scrollTo({ top: 0 }); announce(`${VIEWS[v].title} page`); }
  firstRoute = false;
}

/* ---------------------------------------------------------------- shared pieces */
function bedLabel(b) {
  let s = `Bed ${b.bed}, ${UNITS[b.unit].name}, ${STATUS[b.status] || b.status}`;
  if (b.pid) s += `, ${b.sex} ${b.age}, ${SVC[b.service] || b.service}`;
  if (b.p24 != null && b.status === "occupied") s += `, ${Math.round(b.p24 * 100)} percent likely to free within 24 hours`;
  return s;
}
function floorMap(el, beds, { filter = "all", pick = null, onBed = openBed, animate = true } = {}) {
  const byUnit = {};
  beds.forEach((b) => (byUnit[b.unit] ||= []).push(b));
  const keep = (b) => filter === "all" || (filter === "soon" && b.status === "occupied" && b.p24 >= 0.6) ||
    (filter === "cleaning" && (b.status === "cleaning" || b.status === "dirty")) || (filter === "iso" && b.iso) ||
    (filter === "ready" && b.status === "clean") || (filter === "outlier" && b.outlier);
  let k = 0;
  el.innerHTML = `<div class="floors">${FLOORS.map(([fl, units]) => `<div class="floor"><div class="fl" aria-hidden="true">${fl}</div><div class="wings">${units.map((u) => {
    const list = byUnit[u] || [], occ = list.filter((b) => b.status === "occupied" || b.status === "reserved").length, cap = list.length;
    const rooms = {};
    list.forEach((b) => (rooms[b.room] ||= []).push(b));
    return `<section class="wing ${pick && list.some((b) => b.bed === pick) ? "hl" : ""}" aria-label="${esc(UNITS[u].name)}, ${occ} of ${cap} beds in use">
      <h4><span class="pip" style="background:${occ / cap >= 0.97 ? "var(--lv4)" : occ / cap >= 0.9 ? "var(--lv3)" : "var(--good)"}"></span>${esc(UNITS[u].name)}
        <small class="${occ >= cap ? "full" : ""}">${occ}/${cap}</small></h4>
      <div class="rooms">${Object.values(rooms).map((rb) => `<div class="room">${rb.map((b) => {
        const cls = [`s-${b.status}`, b.iso ? "iso" : "", b.status === "occupied" && b.p24 >= 0.6 ? "soon" : "", b.bed === pick ? "pick" : "", keep(b) ? "" : "dim"].join(" ");
        return `<button class="bed ${cls}" type="button" data-bed="${b.bed}" style="${animate ? `animation-delay:${(k++ % 220) * 4}ms` : "animation:none;opacity:1"}" aria-label="${esc(bedLabel(b))}"></button>`;
      }).join("")}</div>`).join("")}</div></section>`;
  }).join("")}</div></div>`).join("")}</div>`;
  const find = (id) => beds.find((b) => b.bed === id);
  el.onclick = (e) => { const t = e.target.closest(".bed"); if (t) onBed(find(t.dataset.bed)); };
  el.onmouseover = (e) => {
    const t = e.target.closest(".bed"); if (!t) return;
    const b = find(t.dataset.bed);
    let html = `<b>${esc(b.bed)} · ${esc(UNITS[b.unit].name)}</b><div class="tr"><span>Status</span>${esc(STATUS[b.status])}</div>`;
    if (b.pid) html += `<div class="tr"><span>Patient</span>${b.sex} ${b.age} · ${esc(SVC[b.service] || b.service)}</div>`;
    if (b.status === "occupied" && b.p24 != null) html += `<div class="tr"><span>Free in 24 h</span>${Math.round(b.p24 * 100)}%</div>`;
    if (b.status === "cleaning" && b.ready_in != null) html += `<div class="tr"><span>Ready in</span>${b.ready_in} min</div>`;
    if (b.iso) html += `<div class="tr"><span>Isolation</span>yes</div>`;
    showTip(html, e.clientX, e.clientY);
  };
  el.onmouseleave = hideTip;
}
const LEGEND = `<div class="legend2"><span><i style="background:var(--b-occ)"></i>Occupied</span><span><i style="background:var(--b-clean)"></i>Clean</span>
  <span><i style="background:var(--b-cleaning)"></i>Cleaning</span><span><i style="background:var(--b-dirty)"></i>Dirty</span><span><i style="background:var(--b-res)"></i>Reserved</span>
  <span><i style="border:2px solid var(--b-clean)"></i>Likely to free today</span><span><i style="border:1.5px dashed var(--text)"></i>Isolation</span></div>`;

function openBed(b) {
  const L = state.live;
  const fitting = L.recommendations.filter((r) => r.bed === b.bed);
  const body = $("#drawer-body");
  body.innerHTML = `<div class="d-head"><div><div class="eyebrow">${esc(UNITS[b.unit].name)} · ${b.single ? "single room" : "shared room"}${b.tele ? " · telemetry" : ""}</div>
      <h2 id="drawer-title">Bed ${esc(b.bed)}</h2><span class="chip">${esc(STATUS[b.status])}</span></div>
      <button class="close" data-close aria-label="Close bed details">✕</button></div>
    ${b.pid ? `<div class="panel" style="padding:16px 18px"><div class="ph"><div><h3>Patient #${b.pid} · ${b.sex} ${b.age}</h3>
        <p>${esc(SVC[b.service] || b.service)} · came in via ${esc(SRC[b.source] || b.source)}${b.outlier ? " · placed off-service (outlier)" : ""}</p></div>
        ${b.status === "occupied" && b.p24 != null ? ring(b.p24, { size: 64, stroke: 6, color: "var(--good)" }) : ""}</div>
      <dl style="display:grid;grid-template-columns:auto 1fr;gap:8px 18px;margin:0;font-size:.86rem">
        ${b.hours_in != null ? `<dt style="color:var(--muted)">In hospital</dt><dd class="num" style="margin:0">${hm(b.hours_in * 60)}</dd>` : ""}
        ${b.edd_h != null ? `<dt style="color:var(--muted)">Expected discharge</dt><dd class="num" style="margin:0">${b.edd_h >= 0 ? "in " + hm(b.edd_h * 60) : hm(-b.edd_h * 60) + " ago"}</dd>` : ""}
        ${b.p24 != null ? `<dt style="color:var(--muted)">Free within 24 h</dt><dd class="num" style="margin:0">${pct(b.p24)} <small style="color:var(--muted)">· 48 h ${pct(b.p48)}</small></dd>` : ""}
        <dt style="color:var(--muted)">Barriers</dt><dd style="margin:0">${(b.barriers || []).map((x) => `<span class="barrier">${esc(x)}</span>`).join(" ") || "none documented"}</dd></dl></div>`
      : `<p style="color:var(--muted)">${b.status === "cleaning" ? `Environmental services are cleaning it, about ${b.ready_in} minutes left.` : b.status === "dirty" ? `Vacated ${b.dirty_min} minutes ago, waiting for a cleaning crew.` : "Ready for a patient."}</p>`}
    ${fitting.length ? `<h3 style="font:700 1rem var(--display);margin:20px 0 8px">Recommended for</h3>${fitting.map((r) => `<div class="rec" style="grid-template-columns:1fr auto"><div class="who"><b>Patient #${r.pid} · ${r.sex} ${r.age}</b><small>${esc(SRC[r.origin])} · waiting ${hm(r.waiting_min)}</small></div><a class="btn" href="#/placement" data-close>Open placement</a></div>`).join("")}` : ""}
    <p class="demo-note" style="margin-top:18px">Synthetic patient. Wardline shows a number, age and sex, never a name.</p>`;
  openDialog("drawer");
}

/* ---------------------------------------------------------------- COMMAND CENTER */
async function renderCommand(view) {
  const L = state.live, k = L.kpis, lv = LV[k.surge_level];
  const occ = k.occupied / k.beds;
  const next24 = L.arrivals_forecast.mean.slice(0, 24).reduce((a, b) => a + b, 0);
  const boarders = L.bays.filter((b) => b.status === "boarding");
  const longest = Math.max(0, ...boarders.map((b) => b.boarding_min));
  view.innerHTML = `
  <section class="surge reveal" style="--lvc:${lv[1]}" role="status" aria-live="polite">
    <div class="lv" aria-hidden="true">${k.surge_level}</div>
    <div class="tx"><b>Level ${k.surge_level} · ${lv[0]}</b><span>House at ${pctx(occ)}, every ED bay in use, ${k.ed_waiting} waiting. Escalation playbook active.</span></div>
    <div class="crit"><span class="${occ >= 0.92 ? "hot" : ""}">Occupancy ${pctx(occ)}</span><span class="${k.ed_in_bays >= k.ed_bays ? "hot" : ""}">ED ${k.ed_in_bays}/${k.ed_bays} + ${k.ed_waiting}</span>
      <span class="${k.boarders >= 8 ? "hot" : ""}">${k.boarders} boarding</span><span>${k.lwbs_today} left unseen today</span></div>
  </section>
  <section class="kstrip">
    ${kpi(1, "House occupancy", `<span data-count="${(occ * 100).toFixed(1)}" data-dec="1" data-suf="%">0</span>`, `${k.occupied} of ${k.beds} beds`, `<div class="kbar"><i style="width:${occ * 100}%;background:${occ >= 0.95 ? "var(--lv4)" : "var(--lv3)"}"></i></div>`)}
    ${kpi(2, "Emergency department", `<span data-count="${k.ed_in_bays}">0</span><small style="font-size:.9rem;color:var(--muted)">/${k.ed_bays}</small>`, `${k.ed_waiting} in the waiting room · longest ${hm(k.longest_wait_min)}`)}
    ${kpi(3, "Admitted, waiting for a bed", `<span data-count="${k.boarders}">0</span>`, `longest ${hm(longest)} in the ED`, "", "bad")}
    ${kpi(4, "Beds ready or nearly", `<span data-count="${k.clean + k.cleaning}">0</span>`, `${k.clean} clean · ${k.cleaning} being cleaned · ${k.dirty} dirty`, "", "good")}
    ${kpi(5, "Expected to free in 24 h", `<span data-count="${k.expected_releases_24h}" data-dec="0">0</span>`, "from the bed-release model", "", "good")}
    ${kpi(6, "ED arrivals", `<span data-count="${k.arrivals_today}">0</span>`, `today so far · ${Math.round(next24)} forecast next 24 h`)}
  </section>
  <section class="row r-31">
    <div class="panel reveal" style="--i:2">
      <div class="ph"><div><div class="eyebrow">House view</div><h2>Every bed, live</h2><p>Click any bed. Arrow keys and Enter work too.</p></div>
        <div class="seg" role="group" aria-label="Highlight">${[["all", "All"], ["soon", "Likely to free"], ["ready", "Ready"], ["cleaning", "Cleaning"], ["iso", "Isolation"], ["outlier", "Off-service"]].map(([v, l], i) => `<button type="button" data-f="${v}" aria-pressed="${i === 0}">${l}</button>`).join("")}</div></div>
      <div id="fmap"></div><div style="margin-top:12px">${LEGEND}</div>
    </div>
    <div style="display:grid;gap:18px;align-content:start">
      <div class="panel reveal" style="--i:3"><div class="ph"><div><div class="eyebrow">Emergency department</div><h2>${k.ed_in_bays} of ${k.ed_bays} bays</h2><p>Rose bays are admitted patients still waiting for a bed.</p></div></div>
        <div class="bays" id="bays"></div>
        <h3 style="font:600 .82rem var(--ui);margin:14px 0 8px;color:var(--muted)">Waiting room · ${k.ed_waiting}</h3><div class="wroom" id="wroom"></div></div>
      <div class="panel reveal" style="--i:4"><div class="ph"><div><div class="eyebrow">Boarding</div><h2>Longest waits for a bed</h2></div><a class="btn" href="#/placement">Place them →</a></div>
        <div id="boardlist" style="display:grid;gap:8px"></div></div>
      <div class="panel reveal" style="--i:5"><div class="ph"><div><div class="eyebrow">Live feed · ADT</div><h2>Admits, discharges, transfers</h2></div><span class="chip"><span class="dot live"></span> live</span></div>
        <div class="term" id="feed" role="log" aria-label="Admit, discharge and transfer events" style="height:220px"></div></div>
    </div>
  </section>
  <section class="row r-2">
    <div class="panel reveal" style="--i:5"><div class="ph"><div><div class="eyebrow">Arrivals</div><h2>Next 48 hours of ED arrivals</h2><p>Shaded: the 80% range. Left of the line is what already happened.</p></div>
      <div class="legend"><span><i style="background:var(--muted)"></i>Actual</span><span><i style="background:var(--mint)"></i>Forecast</span></div></div><div id="arr"></div><div data-table-for="arr"></div></div>
    <div class="panel reveal" style="--i:6"><div class="ph"><div><div class="eyebrow">Census</div><h2>Where the pressure goes next</h2><p>Fill: beds in use now. Dashed: forecast in 24 h. Line: capacity.</p></div></div><div id="cens" class="unitbars"></div></div>
  </section>`;
  // floor map
  const fm = $("#fmap");
  let filt = "all";
  floorMap(fm, L.beds);
  $$("[data-f]", view).forEach((b) => b.addEventListener("click", () => {
    filt = b.dataset.f; $$("[data-f]", view).forEach((x) => x.setAttribute("aria-pressed", x === b)); floorMap(fm, L.beds, { filter: filt, animate: false });
    announce(`${b.textContent}: ${$$(".bed:not(.dim)", fm).length} beds`);
  }));
  bedKeys(fm);
  // ED bays + waiting room
  const bays = $("#bays");
  bays.innerHTML = Array.from({ length: k.ed_bays }, (_, i) => {
    const b = L.bays[i];
    if (!b) return `<div class="bay free" aria-label="Bay ${i + 1} free">free</div>`;
    const cls = b.status === "boarding" ? `board ${b.assigned ? "assigned" : ""}` : "";
    return `<div class="bay ${cls}" title="Bay ${i + 1}" aria-label="Bay ${i + 1}: ESI ${b.esi} ${b.sex} ${b.age}, ${b.status === "boarding" ? "admitted, waiting " + hm(b.boarding_min) : "in treatment " + hm(b.minutes)}">
      <b>${i + 1}</b>${b.status === "boarding" ? hm(b.boarding_min) : "ESI " + b.esi}</div>`;
  }).join("");
  $("#wroom").innerHTML = L.ed_waiting.slice().sort((a, b) => a.esi - b.esi || b.wait_min - a.wait_min).map((w, i) =>
    `<span class="wchip" style="animation-delay:${i * 50}ms"><span class="esi e${w.esi}">${w.esi}</span>${esc(w.complaint)}<small>${hm(w.wait_min)}</small></span>`).join("") || '<span style="color:var(--muted)">Nobody waiting.</span>';
  $("#boardlist").innerHTML = boarders.sort((a, b) => b.boarding_min - a.boarding_min).slice(0, 5).map((b) =>
    `<div style="display:flex;align-items:center;gap:10px;font-size:.84rem"><span class="esi e${b.esi}">${b.esi}</span><span style="flex:1">${esc(b.complaint)} <small style="color:var(--muted)">· ${b.sex} ${b.age} · ${esc(SVC[b.service])}</small></span>
      <span class="timer ${b.boarding_min > 360 ? "hot" : b.boarding_min > 240 ? "warm" : ""}">${hm(b.boarding_min)}</span></div>`).join("");
  // arrivals chart
  const A = L.arrivals_forecast, H = A.history.length;
  const labels = [...Array(H + 48)].map((_, i) => { const d = new Date(new Date(L.now).getTime() + (i - H) * 3600e3); return d.toLocaleString("en-US", { weekday: "short", hour: "numeric" }); });
  const actual = A.history.concat(Array(48).fill(null)), fc = Array(H - 1).fill(null).concat([A.history[H - 1]], A.mean);
  const draw = () => lineChart($("#arr"), {
    labels, title: "ED arrivals per hour", height: 220, fmt: (v) => v.toFixed(0), step: false,
    series: [{ name: "Actual", color: "var(--muted)", values: actual, width: 1.6 }, { name: "Forecast", color: "var(--mint)", values: fc, width: 2.4, glow: true }],
    ribbons: [{ lo: Array(H).fill(null).concat(A.lo), hi: Array(H).fill(null).concat(A.hi), color: "var(--mint)" }],
    vlines: [{ x: H - 1, label: "now" }], summary: `About ${Math.round(next24)} arrivals expected in the next 24 hours.`,
  });
  draw();
  tableToggle($('[data-table-for="arr"]'), ["Hour", "Forecast", "Low", "High"], A.mean.map((v, i) => [labels[H + i], v.toFixed(1), A.lo[i], A.hi[i]]));
  censusBars($("#cens"), L.census_now, L.census_forecast);
  startFeed($("#feed"), L.events);
  onResize(view, draw);
}
let feedTimer = null;
function feedLine(e) {
  const u = e.unit ? UNITS[e.unit].name : "";
  const k = { admit: ["ADMIT", "s2"], discharge: ["DISCH", "s3"], transfer: ["XFER", "s4"], arrival: ["ARRIVE", "s2"], lwbs: ["LWBS", "s5"] }[e.kind];
  const txt = e.kind === "admit" ? `#${e.pid} to ${e.bed} ${u} <span class="ms">from ${SRC[e.from]}, waited ${hm(e.wait_min)}</span>`
    : e.kind === "discharge" ? `#${e.pid} home from ${e.bed} ${u} <span class="ms">after ${hm(e.los_h * 60)}</span>`
    : e.kind === "transfer" ? `#${e.pid} stepped down to ${e.bed} ${u}` : e.kind === "arrival" ? `#${e.pid} ESI ${e.esi} <span class="ms">${esc(e.complaint)}</span>`
    : `#${e.pid} ESI ${e.esi} <span class="ms">left without being seen</span>`;
  return `<div><span class="ms">${e.at}</span> <span class="st ${k[1]}">${k[0]}</span>${txt}</div>`;
}
function startFeed(el, events) {
  clearInterval(feedTimer);
  if (!el || !events?.length) return;
  const old = events.slice().reverse();
  el.innerHTML = old.slice(0, 9).map(feedLine).join("");
  let i = 9;
  if (reduced()) return;
  feedTimer = setInterval(() => {
    if (!document.body.contains(el)) { clearInterval(feedTimer); return; }
    el.insertAdjacentHTML("beforeend", feedLine(old[i % old.length]));
    if (el.children.length > 10) el.firstElementChild.remove();
    i++;
  }, 1500);
}
function kpi(i, label, value, sub, extra = "", cls = "") {
  return `<div class="kpi reveal ${cls}" style="--i:${i};cursor:default"><span class="k-l">${esc(label)}</span><span class="k-v num">${value}</span><span class="k-s">${esc(sub)}</span>${extra}</div>`;
}
function censusBars(el, now, fc) {
  el.innerHTML = state.layout.units.map((u) => {
    const cap = u.beds, n = now[u.key], f24 = fc["24"][u.key], f72 = fc["72"][u.key];
    const col = n / cap >= 0.97 ? "var(--lv4)" : n / cap >= 0.9 ? "var(--lv3)" : "var(--good)";
    return `<div class="ub"><span>${esc(u.name)}</span><span class="tr" role="img" aria-label="${esc(u.name)}: ${n} of ${cap} now, ${f24.toFixed(0)} forecast in 24 hours">
      <i style="width:${Math.min(100, (n / cap) * 92)}%;background:${col}"></i><u style="left:${Math.min(100, (f24 / cap) * 92)}%"></u><s style="left:92%"></s></span>
      <span class="num" style="text-align:right">${n}/${cap} <small style="color:var(--muted)">→${Math.round(f24)}</small></span></div>`;
  }).join("");
}
function bedKeys(root) {
  root.addEventListener("keydown", (e) => {
    const b = e.target.closest(".bed"); if (!b) return;
    const all = $$(".bed", root), i = all.indexOf(b);
    const mv = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 12, ArrowUp: -12 }[e.key];
    if (mv) { e.preventDefault(); all[Math.max(0, Math.min(all.length - 1, i + mv))].focus(); }
  });
}

/* ---------------------------------------------------------------- PLACEMENT */
async function renderPlacement(view) {
  const L = state.live, M = state.metrics, A = M.policy.all, S = M.policy.surge;
  const recsOf = () => state.live.recommendations;
  const recs = recsOf();
  view.innerHTML = `
  <section class="row r-31">
    <div class="panel reveal" style="--i:0">
      <div class="ph"><div><div class="eyebrow">Waiting for a bed · ${recs.length}</div><h2>Matched in one pass</h2>
        <p>All requests and all beds that are clean, or will be within 90 minutes, matched together by acuity, wait and fit. Nothing moves until you accept.</p></div>
        <button class="btn primary" id="acceptAll" type="button">Accept all ready</button></div>
      <div class="recs" id="recs"></div>
    </div>
    <div class="panel reveal" style="--i:1;align-self:start;position:sticky;top:86px">
      <div class="ph"><div><div class="eyebrow">Where it goes</div><h2 id="mini-h">Select a patient</h2></div></div>
      <div id="mini"></div>
    </div>
  </section>
  <section class="panel reveal" style="--i:2">
    <div class="ph"><div><div class="eyebrow">The proof</div><h2>Same 90 days, same patients, two ways of placing them</h2>
      <p>The hospital was replayed twice with identical arrivals, illnesses, lengths of stay and cleaning times. Only the placement policy changed.</p></div></div>
    <div class="tiles">
      ${proof("Admitted patients waiting over 4 h", A.baseline.boarding_over_4h_pct + "%", A.wardline.boarding_over_4h_pct + "%")}
      ${proof("Longest 10% of waits", A.baseline.boarding_p90_h + " h", A.wardline.boarding_p90_h + " h")}
      ${proof("Left the ED without being seen", A.baseline.lwbs, A.wardline.lwbs, "patients")}
      ${proof("Placed off-service (outliers)", A.baseline.outliers, A.wardline.outliers, "placements")}
    </div>
    <div class="row r-2" style="margin-top:16px">
      <div><h3 style="font:600 .9rem var(--ui);margin:0 0 8px">How long admitted patients waited, in hours</h3><div id="bh"></div>
        <div class="legend" style="margin-top:6px"><span><i style="background:var(--faint)"></i>First come, first served</span><span><i style="background:var(--mint)"></i>Wardline</span></div></div>
      <div><h3 style="font:600 .9rem var(--ui);margin:0 0 8px">During the surge (last 10 days)</h3>
        <div class="tiles" style="grid-template-columns:1fr 1fr">${proof("Waiting over 4 h", S.baseline.boarding_over_4h_pct + "%", S.wardline.boarding_over_4h_pct + "%")}${proof("Left unseen", S.baseline.lwbs_pct + "%", S.wardline.lwbs_pct + "%")}</div>
        <p class="chart-desc">Baseline: first come, first served, the first clean bed that fits, cleaning crews in the order beds were vacated. Wardline: one optimal matching every 10 minutes and whenever a bed or patient appears, beds still being cleaned counted as nearly ready, crews sent first to beds a waiting patient can use. Both use the same 6-hour rule before placing anyone off-service.</p></div>
    </div>
  </section>`;
  pairBars($("#bh"), M.boarding_hist.baseline.slice(1), M.boarding_hist.wardline.slice(1),
    { labels: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12+"], names: ["First come, first served", "Wardline"] });
  const list = $("#recs");
  const draw = () => {
    list.innerHTML = recsOf().map((r, i) => {
      const wait = r.waiting_min, hot = wait > 360 ? "hot" : wait > 240 ? "warm" : "";
      const need = [r.iso ? "ISO" : "", r.tele ? "TELE" : "", r.sex].filter(Boolean).map((x) => `<span>${x}</span>`).join("");
      const target = r.kind === "none" ? `<span style="color:var(--muted)">No compatible bed expected</span>`
        : `<span class="bedtag"><i class="pip" style="width:12px;height:12px;border-radius:4px;background:${r.kind === "assign" ? (r.ready_in ? "var(--b-cleaning)" : "var(--b-clean)") : r.kind === "accepted" ? "var(--b-res)" : "var(--b-occ)"}"></i>${esc(r.bed)}</span>
           <small style="display:block;color:var(--muted)">${esc(UNITS[r.unit].name)}${r.kind === "expected" ? ` · ${Math.round(r.p_release * 100)}% free in 24 h` : ""}</small>`;
      const act = r.kind === "assign" ? `<button class="btn primary" data-acc="${r.rid}" type="button">Accept</button>`
        : r.kind === "accepted" ? `<span class="chip" style="color:var(--b-res)">Reserved ✓</span>` : `<button class="btn" data-hold="${r.rid}" type="button">Hold bed</button>`;
      return `<article class="rec reveal ${r.kind === "accepted" ? "done" : ""}" style="--i:${i}" tabindex="0" data-i="${i}" aria-label="Patient ${r.pid}, ${esc(SRC[r.origin])}, waiting ${hm(wait)}">
        <div class="who"><b>${r.esi ? `<span class="esi e${r.esi}">${r.esi}</span> ` : `<span class="esi e0">OR</span> `}${esc(r.complaint || SVC[r.service])} <span class="need">${need}</span></b>
          <small>#${r.pid} · ${r.sex} ${r.age} · ${esc(SRC[r.origin])} · ${esc(SVC[r.service])} · <span class="timer ${hot}">waiting ${hm(wait)}</span></small></div>
        <div class="arrow" aria-hidden="true">→</div>
        <div>${target}<div class="reasons">${(r.why || []).map((w) => `<span>${esc(w)}</span>`).join("")}</div></div>
        <div>${act}</div></article>`;
    }).join("");
  };
  draw();
  const mini = $("#mini");
  const select = (i) => {
    const r = recsOf()[i];
    $$(".rec", list).forEach((x) => x.classList.toggle("sel", +x.dataset.i === i));
    $("#mini-h").textContent = r.bed ? `Bed ${r.bed} · ${UNITS[r.unit].name}` : "No bed yet";
    floorMap(mini, state.live.beds, { pick: r.bed, animate: false });
  };
  select(0);
  list.addEventListener("click", async (e) => {
    const acc = e.target.closest("[data-acc]"), hold = e.target.closest("[data-hold]"), card = e.target.closest(".rec");
    if (card) select(+card.dataset.i);
    if (acc) await acceptRec(+acc.dataset.acc, draw, select);
    if (hold) { toast("Bed held", "The unit will call when the bed is released."); announce("Bed held"); }
  });
  list.addEventListener("keydown", (e) => { const c = e.target.closest(".rec"); if (c && e.key === "Enter") select(+c.dataset.i); });
  $("#acceptAll").addEventListener("click", async () => {
    const ready = recsOf().filter((r) => r.kind === "assign");
    for (const r of ready) await acceptRec(r.rid, draw, select, true);
    toast(`${ready.length} beds reserved`, "Transport and the receiving units have been notified.");
  });
}
async function acceptRec(rid, draw, select, quiet = false) {
  state.live = await post(`/api/accept/${rid}`);
  const i = state.live.recommendations.findIndex((r) => r.rid === rid);
  const r = state.live.recommendations[i];
  draw();
  select(i);
  updateBadge();
  if (!quiet) toast(`Bed ${r.bed} reserved`, `For patient #${r.pid} · transport requested`);
  announce(`Bed ${r.bed} reserved for patient ${r.pid}`);
}
function proof(label, before, after, unit = "") {
  return `<div class="tile"><small>${esc(label)}</small><div style="display:flex;align-items:baseline;gap:10px;margin-top:6px">
    <span class="num" style="color:var(--muted);text-decoration:line-through;font-size:1.05rem">${before}</span><b class="num" style="color:var(--mint);margin:0">${after}</b></div>
    <small>${unit ? unit + ", " : ""}first come, first served → Wardline</small></div>`;
}

/* ---------------------------------------------------------------- DISCHARGES */
async function renderDischarges(view) {
  const L = state.live, R = state.metrics.release;
  const occ = L.beds.filter((b) => b.status === "occupied" && b.p24 != null).sort((a, b) => b.p24 - a.p24);
  const byUnit = {};
  occ.forEach((b) => (byUnit[b.unit] = (byUnit[b.unit] || 0) + b.p24));
  view.innerHTML = `
  <section class="row r-31">
    <div class="panel reveal" style="--i:0">
      <div class="ph"><div><div class="eyebrow">Likely to leave · next 24 h</div><h2><span data-count="${L.kpis.expected_releases_24h}" data-dec="0">0</span> beds expected to free</h2>
        <p>Sorted by probability. Clear a barrier to pull a discharge forward.</p></div>
        <label><span class="sr-only">Unit</span><select class="sel" id="dunit"><option value="">All units</option>${state.layout.units.map((u) => `<option value="${u.key}">${esc(u.name)}</option>`).join("")}</select></label></div>
      <div class="scroll-y" style="max-height:620px"><table class="tbl"><thead><tr><th scope="col">Bed</th><th scope="col">Patient</th><th scope="col">In hospital</th><th scope="col">Expected date</th><th scope="col">Free in 24 h</th><th scope="col">Barriers</th></tr></thead><tbody id="dbody"></tbody></table></div>
    </div>
    <div style="display:grid;gap:18px;align-content:start">
      <div class="panel reveal" style="--i:1"><div class="ph"><div><div class="eyebrow">Model card</div><h2>Bed-release model</h2><p>Scored on ${R["24"].test.toLocaleString()} bed snapshots from the last three weeks, which it never trained on.</p></div></div>
        <div class="tiles" style="grid-template-columns:1fr 1fr">
          <div class="tile"><small>AUC, 24 h</small><b class="num" style="color:var(--mint)" data-count="${R["24"].auc}" data-dec="3">0</b><small>rule of thumb: ${R["24"].auc_rule}</small></div>
          <div class="tile"><small>Calibration error</small><b class="num" data-count="${(R["24"].ece * 100).toFixed(1)}" data-dec="1" data-suf=" pts">0</b><small>Brier ${R["24"].brier}</small></div></div>
        <div id="cal" style="margin-top:14px"></div>
        <p class="chart-desc">When it says 70%, about 70% of those patients really leave. The rule of thumb ranks by how far past a typical stay a patient is.</p></div>
      <div class="panel reveal" style="--i:2"><div class="ph"><div><div class="eyebrow">By unit</div><h2>Expected releases</h2></div></div><div class="unitbars">${state.layout.units.map((u) => {
        const v = byUnit[u.key] || 0; return `<div class="ub"><span>${esc(u.name)}</span><span class="tr"><i style="width:${Math.min(100, (v / u.beds) * 100 * 2)}%;background:var(--good)"></i></span><span class="num" style="text-align:right">${v.toFixed(1)}</span></div>`;
      }).join("")}</div></div>
    </div>
  </section>`;
  calibration($("#cal"), R["24"].calibration);
  const draw = () => {
    const u = $("#dunit").value;
    $("#dbody").innerHTML = occ.filter((b) => !u || b.unit === u).slice(0, 80).map((b) => `<tr tabindex="0" data-bed="${b.bed}">
      <td class="pt"><b>${esc(b.bed)}</b><small>${esc(UNITS[b.unit].name)}</small></td>
      <td class="pt"><b>#${b.pid} · ${b.sex} ${b.age}</b><small>${esc(SVC[b.service] || b.service)}${b.outlier ? " · off-service" : ""}</small></td>
      <td class="num">${hm((b.hours_in || 0) * 60)}</td>
      <td class="num">${b.edd_h == null ? '<span style="color:var(--faint)">not set</span>' : b.edd_h >= 0 ? "in " + hm(b.edd_h * 60) : '<span style="color:var(--amber)">' + hm(-b.edd_h * 60) + " overdue</span>"}</td>
      <td><div style="display:flex;align-items:center;gap:8px"><span class="pbar"><i style="width:${b.p24 * 100}%"></i></span><span class="num">${pct(b.p24)}</span></div></td>
      <td>${(b.barriers || []).map((x) => `<button type="button" class="barrier" data-bar="${b.bed}|${x}">${esc(x)}</button>`).join(" ") || '<span style="color:var(--faint)">—</span>'}</td></tr>`).join("");
  };
  draw();
  $("#dunit").addEventListener("change", draw);
  $("#dbody").addEventListener("click", (e) => {
    const bb = e.target.closest("[data-bar]");
    if (bb) { e.stopPropagation(); bb.classList.add("ok"); const [bed, x] = bb.dataset.bar.split("|"); toast(`${x[0].toUpperCase() + x.slice(1)} barrier cleared`, `Bed ${bed} · the team has been notified`); announce(`${x} cleared for bed ${bed}`); return; }
    const tr = e.target.closest("tr"); if (tr) openBed(L.beds.find((b) => b.bed === tr.dataset.bed));
  });
}

/* ---------------------------------------------------------------- FORECAST */
async function renderForecast(view) {
  const L = state.live, M = state.metrics, A = M.arrivals, C = M.census;
  view.innerHTML = `
  <section class="tiles">
    <div class="tile reveal" style="--i:0"><small>Next-24-hour arrivals error</small><b class="num" style="color:var(--mint)" data-count="${A.next24_mape}" data-dec="1" data-suf="%">0</b><small>4-week average ${A.next24_mape_4wk_avg}% · last week ${A.next24_mape_last_week}%</small></div>
    <div class="tile reveal" style="--i:1"><small>Hourly error (arrivals)</small><b class="num" data-count="${A.mae}" data-dec="2">0</b><small>patients per hour · baselines ${A.mae_4wk_avg} / ${A.mae_last_week}</small></div>
    <div class="tile reveal" style="--i:2"><small>Hours inside the 80% band</small><b class="num" data-count="${A.interval80_coverage}" data-dec="1" data-suf="%">0</b><small>${A.hours_scored} test hours, slightly cautious</small></div>
    <div class="tile reveal" style="--i:3"><small>Census error at 48 h</small><b class="num" style="color:var(--mint)" data-count="${C["48"].mae_hospital}" data-dec="1" data-suf=" beds">0</b><small>"stays the same": ${C["48"].mae_hospital_persistence} beds</small></div>
  </section>
  <section class="panel reveal" style="--i:4"><div class="ph"><div><div class="eyebrow">Emergency arrivals</div><h2>The surge is still building</h2><p>${esc(A.model)}. Backtested on ${A.test_origins} forecasts it never saw.</p></div>
    <div class="legend"><span><i style="background:var(--muted)"></i>Actual</span><span><i style="background:var(--mint)"></i>Forecast + 80% band</span></div></div><div id="arr2"></div></section>
  <section class="panel reveal" style="--i:5"><div class="ph"><div><div class="eyebrow">Census by unit</div><h2>Beds in use, now and ahead</h2><p>Current patients who are likely to stay, ICU step-downs moved to their next unit, plus new admissions at today's rate.</p></div></div>
    <div class="scroll-y" style="max-height:none"><table class="tbl"><thead><tr><th scope="col">Unit</th><th class="r" scope="col">Beds</th><th class="r" scope="col">Now</th><th class="r" scope="col">+24 h</th><th class="r" scope="col">+48 h</th><th class="r" scope="col">+72 h</th><th scope="col">Next 72 h</th></tr></thead><tbody>
    ${state.layout.units.map((u) => {
      const v = [L.census_now[u.key], L.census_forecast["24"][u.key], L.census_forecast["48"][u.key], L.census_forecast["72"][u.key]];
      const warn = v.slice(1).some((x) => x >= u.beds);
      return `<tr style="cursor:default"><td><b>${esc(u.name)}</b>${warn ? ' <span class="pos above">over capacity</span>' : ""}</td><td class="r num">${u.beds}</td>${v.map((x) => `<td class="r num" style="color:${x >= u.beds ? "var(--lv4)" : x / u.beds >= 0.9 ? "var(--lv3)" : "inherit"}">${Math.round(x)}</td>`).join("")}
        <td>${sparkline(v.map((x) => x / u.beds), { w: 110, h: 28, color: warn ? "var(--lv4)" : "var(--mint)" })}</td></tr>`;
    }).join("")}</tbody></table></div>
    <p class="chart-desc">Backtest from every 14:00 in the test window: hospital-wide error ${C["24"].mae_hospital} beds at 24 h (persistence ${C["24"].mae_hospital_persistence}), ${C["48"].mae_hospital} at 48 h (${C["48"].mae_hospital_persistence}), ${C["72"].mae_hospital} at 72 h (${C["72"].mae_hospital_persistence}). Per unit: ${C["24"].mae_unit} / ${C["48"].mae_unit} / ${C["72"].mae_unit} beds against ${C["24"].mae_unit_persistence} / ${C["48"].mae_unit_persistence} / ${C["72"].mae_unit_persistence}.</p></section>`;
  const F = L.arrivals_forecast, H = F.history.length;
  const labels = [...Array(H + 48)].map((_, i) => new Date(new Date(L.now).getTime() + (i - H) * 3600e3).toLocaleString("en-US", { weekday: "short", hour: "numeric" }));
  const draw = () => lineChart($("#arr2"), {
    labels, title: "ED arrivals per hour", height: 300, fmt: (v) => v.toFixed(0),
    series: [{ name: "Actual", color: "var(--muted)", values: F.history.concat(Array(48).fill(null)), width: 1.6 },
      { name: "Forecast", color: "var(--mint)", values: Array(H - 1).fill(null).concat([F.history[H - 1]], F.mean), width: 2.6, glow: true }],
    ribbons: [{ lo: Array(H).fill(null).concat(F.lo), hi: Array(H).fill(null).concat(F.hi), color: "var(--mint)" }], vlines: [{ x: H - 1, label: "now" }],
  });
  draw();
  onResize(view, draw);
}

/* ---------------------------------------------------------------- REPLAY */
async function renderReplay(view) {
  const rep = (state.replay ||= await api("/api/replay"));
  const daily = (state.daily ||= await api("/api/daily"));
  const beds = state.layout.beds;
  const CODE = { O: "occupied", C: "clean", D: "dirty", L: "cleaning", R: "reserved" };
  view.innerHTML = `
  <section class="panel reveal" style="--i:0">
    <div class="ph"><div><div class="eyebrow">Replay</div><h2>The last 7 days, hour by hour</h2><p>Watch the surge arrive: beds fill, cleaning backs up, the house turns blue.</p></div></div>
    <div class="scrub"><button class="playbtn" id="play" type="button" aria-label="Play">▶</button><span class="clock" id="clock" aria-live="off">—</span>
      <label style="flex:1"><span class="sr-only">Hour</span><input type="range" id="scrub" min="0" max="${rep.length - 1}" value="0"></label>
      <span class="chip num" id="occchip">—</span></div>
    <div id="rmap" style="margin-top:14px"></div><div style="margin-top:10px">${LEGEND}</div>
  </section>
  <section class="row r-2">
    <div class="panel reveal" style="--i:1"><div class="ph"><div><div class="eyebrow">90 days</div><h2>Admitted patients waiting over 4 hours, per day</h2></div>
      <div class="legend"><span><i style="background:var(--faint)"></i>First come, first served</span><span><i style="background:var(--mint)"></i>Wardline</span></div></div><div id="d1"></div></div>
    <div class="panel reveal" style="--i:2"><div class="ph"><div><div class="eyebrow">90 days</div><h2>House occupancy, daily peak</h2></div></div><div id="d2"></div></div>
  </section>`;
  const sc = $("#scrub"), clock = $("#clock"), occchip = $("#occchip");
  const show = (i) => {
    const s = rep[i].s;
    const rows = beds.map((b, j) => ({ ...b, status: CODE[s[j]] }));
    floorMap($("#rmap"), rows, { animate: false, onBed: () => {} });
    const d = new Date(new Date(state.layout.start).getTime() + rep[i].t * 60e3);
    clock.textContent = d.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    const n = [...s].filter((c) => c === "O").length;
    occchip.textContent = `${n}/${beds.length} · ${Math.round((100 * n) / beds.length)}%`;
  };
  show(0);
  sc.addEventListener("input", () => show(+sc.value));
  let timer = null;
  const stop = () => { clearInterval(timer); timer = null; $("#play").textContent = "▶"; $("#play").setAttribute("aria-label", "Play"); };
  $("#play").addEventListener("click", () => {
    if (timer) return stop();
    $("#play").textContent = "❚❚"; $("#play").setAttribute("aria-label", "Pause");
    timer = setInterval(() => { const v = (+sc.value + 1) % rep.length; sc.value = v; show(v); if (v === rep.length - 1) stop(); }, reduced() ? 600 : 110);
  });
  stopReplay = stop;
  const lab = daily.wardline.map((d) => new Date(d.date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" }));
  const draw = () => {
    lineChart($("#d1"), { labels: lab, title: "Patients waiting over 4 hours per day", height: 220, fmt: (v) => v.toFixed(0),
      series: [{ name: "First come, first served", color: "var(--faint)", values: daily.baseline.map((d) => d.board_over4), width: 1.8 },
        { name: "Wardline", color: "var(--mint)", values: daily.wardline.map((d) => d.board_over4), width: 2.4, glow: true }] });
    lineChart($("#d2"), { labels: lab, title: "Daily peak occupancy", height: 220, fmt: (v) => Math.round(v * 100) + "%", yMax: 1,
      series: [{ name: "Peak occupancy", color: "var(--lv3)", values: daily.wardline.map((d) => d.occ_max), width: 2.2, area: true }], ref: { y: 0.92, label: "surge line 92%", color: "var(--lv4)" }, yMin: 0.6 });
  };
  draw();
  onResize(view, draw);
}

/* ---------------------------------------------------------------- shared helpers */
function tableToggle(host, head, rows) {
  if (!host) return;
  const id = "t" + Math.random().toString(36).slice(2, 7);
  host.innerHTML = `<button class="tbl-toggle" type="button" aria-expanded="${prefs.tables}" aria-controls="${id}">${prefs.tables ? "Hide" : "View"} data as a table</button>
    <div id="${id}" class="data-table" ${prefs.tables ? "" : "hidden"}><table class="tbl"><thead><tr>${head.map((h) => `<th scope="col">${esc(h)}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c, i) => (i ? `<td class="num">${esc(c)}</td>` : `<th scope="row" style="position:static;text-transform:none;letter-spacing:0">${esc(c)}</th>`)).join("")}</tr>`).join("")}</tbody></table></div>`;
  const b = host.querySelector("button"), t = host.querySelector(".data-table");
  b.addEventListener("click", () => { t.hidden = !t.hidden; b.setAttribute("aria-expanded", !t.hidden); b.textContent = (t.hidden ? "View" : "Hide") + " data as a table"; });
}
function onResize(view, fn) {
  let w = view.clientWidth, t;
  new ResizeObserver(() => { if (Math.abs(view.clientWidth - w) > 30) { w = view.clientWidth; clearTimeout(t); t = setTimeout(fn, 150); } }).observe(view);
}
function updateBadge() { $("#nav-place").textContent = state.live.recommendations.filter((r) => r.kind === "assign").length || state.live.recommendations.length; }

/* ---------------------------------------------------------------- dialogs, palette, shortcuts, accessibility */
let lastFocus = null;
function openDialog(id) {
  const d = document.getElementById(id);
  if (d.hidden) lastFocus = document.activeElement;
  d.hidden = false;
  setTimeout(() => d.querySelector("input, .drawer-panel, button")?.focus(), 30);
}
function closeDialog(d) { d.hidden = true; hideTip(); if (lastFocus && document.body.contains(lastFocus)) lastFocus.focus(); }
document.addEventListener("click", (e) => {
  const op = e.target.closest("[data-open]");
  if (op) { const id = op.dataset.open; if (id === "a11y") renderA11y(); if (id === "palette") openPalette(); else if (id === "shortcuts") renderShortcuts(); openDialog(id); }
  const cl = e.target.closest("[data-close]");
  if (cl) { const d = cl.closest(".drawer, .palette"); if (d) closeDialog(d); }
  if (e.target.closest("[data-theme-toggle]")) { prefs.theme = prefs.theme === "light" ? "dark" : "light"; applyPrefs(); route(); }
});
function trap(e) {
  const d = [...document.querySelectorAll(".drawer:not([hidden]), .palette:not([hidden])")].pop();
  if (!d || e.key !== "Tab") return;
  const f = [...d.querySelectorAll('button, [href], input, select, [tabindex]:not([tabindex="-1"])')].filter((x) => x.offsetParent !== null);
  if (!f.length) return;
  if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f.at(-1).focus(); }
  else if (!e.shiftKey && document.activeElement === f.at(-1)) { e.preventDefault(); f[0].focus(); }
}
document.addEventListener("keydown", (e) => {
  trap(e);
  const open = [...document.querySelectorAll(".drawer:not([hidden]), .palette:not([hidden])")].pop();
  if (e.key === "Escape" && open) { closeDialog(open); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(); openDialog("palette"); return; }
  if (open || /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
  if (/^[1-5]$/.test(e.key)) { location.hash = "#/" + Object.keys(VIEWS)[+e.key - 1]; return; }
  if (e.key === "?") { renderShortcuts(); openDialog("shortcuts"); return; }
  if (e.key === "/") { e.preventDefault(); openPalette(); openDialog("palette"); return; }
  if (e.key.toLowerCase() === "t") { prefs.theme = prefs.theme === "light" ? "dark" : "light"; applyPrefs(); route(); }
});
const PAGES = Object.entries(VIEWS).map(([k, v], i) => ({ g: "Go to", label: v.title, hint: String(i + 1), run: () => (location.hash = "#/" + k) }));
const ACTIONS = [
  { g: "Actions", label: "Accept every ready bed recommendation", run: () => { location.hash = "#/placement"; setTimeout(() => $("#acceptAll")?.click(), 600); } },
  { g: "Actions", label: "Show beds likely to free today", run: () => { location.hash = "#/command"; setTimeout(() => $('[data-f="soon"]')?.click(), 500); } },
  { g: "Actions", label: "Replay the last week", run: () => { location.hash = "#/replay"; setTimeout(() => $("#play")?.click(), 600); } },
  { g: "Actions", label: "Switch to high-contrast theme", run: () => { prefs.theme = "contrast"; applyPrefs(); route(); } },
  { g: "Actions", label: "Use colour-blind safe palette", run: () => { prefs.cvd = "safe"; applyPrefs(); route(); } },
  { g: "Actions", label: "Open accessibility settings", run: () => { renderA11y(); openDialog("a11y"); } },
];
let palItems = [], palSel = 0;
function openPalette() {
  const q = $("#palette-q");
  q.value = ""; drawPalette("");
  q.oninput = () => drawPalette(q.value);
  q.onkeydown = (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); palSel = (palSel + (e.key === "ArrowDown" ? 1 : -1) + palItems.length) % palItems.length; drawPalette(q.value, true); }
    if (e.key === "Enter" && palItems[palSel]) { e.preventDefault(); const it = palItems[palSel]; closeDialog($("#palette")); it.run(); }
  };
}
function drawPalette(q, keep) {
  const s = q.trim().toLowerCase();
  const bedHits = s ? state.live.beds.filter((b) => (b.bed + " " + UNITS[b.unit].name + " " + (b.pid ? "#" + b.pid : "")).toLowerCase().includes(s)).slice(0, 7)
    .map((b) => ({ g: "Beds", label: `Bed ${b.bed} · ${UNITS[b.unit].name}`, hint: STATUS[b.status], run: () => openBed(b) })) : [];
  palItems = [...PAGES, ...ACTIONS].filter((x) => !s || x.label.toLowerCase().includes(s)).concat(bedHits);
  if (!keep) palSel = 0;
  let g = null;
  $("#palette-list").innerHTML = palItems.map((it, i) => { const head = it.g !== g ? `<li class="grp" role="presentation">${it.g}</li>` : ""; g = it.g;
    return head + `<li role="option" id="po${i}" aria-selected="${i === palSel}" data-i="${i}">${esc(it.label)}${it.hint ? `<small>${esc(it.hint)}</small>` : ""}</li>`; }).join("") || `<li class="grp">No results</li>`;
  $("#palette-q").setAttribute("aria-activedescendant", "po" + palSel);
  $("#po" + palSel)?.scrollIntoView({ block: "nearest" });
  $$("#palette-list [data-i]").forEach((li) => li.addEventListener("click", () => { const it = palItems[+li.dataset.i]; closeDialog($("#palette")); it.run(); }));
}
function renderShortcuts() {
  const rows = [["Command palette", "Ctrl K"], ["Go to a page", "1 – 5"], ["Toggle light / dark", "T"], ["Show this list", "?"], ["Move between beds", "Arrow keys"], ["Open a bed", "Enter"], ["Read a chart hour by hour", "← →"], ["Close a panel", "Esc"]];
  $("#sc-body").innerHTML = `<div class="sc-grid">${rows.map(([a, k]) => `<div><span>${a}</span><kbd>${k}</kbd></div>`).join("")}</div>`;
}
function renderA11y() {
  const opt = (group, val, label, sub, sw) => `<button type="button" class="opt" role="radio" aria-checked="${prefs[group] === val}" data-pg="${group}" data-pv="${val}">
    <span class="sw" style="${sw.bg}">${sw.bars.map((c, i) => `<i style="background:${c};height:${[70, 45, 85][i]}%"></i>`).join("")}</span>${label}<small>${sub}</small></button>`;
  $("#a11y-body").innerHTML = `<div class="a11y"><div class="d-head" style="margin:0"><div><div class="eyebrow">Accessibility</div><h2 id="a11y-title">Built for a night shift</h2></div>
      <button class="close" data-close aria-label="Close accessibility settings">✕</button></div>
    <p>Saved on this device. The floor map, charts and alerts update instantly.</p>
    <fieldset><legend>Theme</legend><div class="opt-grid" role="radiogroup" aria-label="Theme">
      ${opt("theme", "dark", "Dark", "night shift", { bg: "background:#08101c", bars: ["#3b82f6", "#34d399", "#fbbf24"] })}
      ${opt("theme", "light", "Light", "day shift", { bg: "background:#f3f6fb", bars: ["#2563eb", "#10b981", "#f59e0b"] })}
      ${opt("theme", "contrast", "High contrast", "WCAG AAA text", { bg: "background:#000;border-color:#fff", bars: ["#4d8dff", "#00ff9c", "#ffe500"] })}</div></fieldset>
    <fieldset><legend>Colour vision</legend><div class="opt-grid" role="radiogroup" aria-label="Colour vision">
      ${opt("cvd", "default", "Default", "blue, green, amber", { bg: "background:var(--panel-2)", bars: ["#3b82f6", "#34d399", "#f97316"] })}
      ${opt("cvd", "safe", "Colour-blind safe", "Okabe–Ito", { bg: "background:var(--panel-2)", bars: ["#0072b2", "#009e73", "#d55e00"] })}
      ${opt("cvd", "mono", "Monochrome", "patterns + text", { bg: "background:var(--panel-2)", bars: ["#ccc", "#888", "#555"] })}</div></fieldset>
    <fieldset><legend>Text size <output id="fs-out" class="num" style="color:var(--mint);margin-left:6px">${Math.round(prefs.fs * 100)}%</output></legend>
      <input type="range" id="fs" min="0.9" max="1.4" step="0.05" value="${prefs.fs}" aria-label="Text size"></fieldset>
    <fieldset><legend>Motion</legend><div class="seg" role="group" aria-label="Motion">${[["system", "Follow system"], ["reduced", "Reduced"], ["full", "Full"]].map(([v, l]) => `<button type="button" data-mo="${v}" aria-pressed="${prefs.motion === v}">${l}</button>`).join("")}</div></fieldset>
    <div class="switch"><span>Show charts as tables<small>Every chart gets its numbers underneath</small></span><button type="button" role="switch" data-sw="tables" aria-checked="${prefs.tables}" aria-label="Show charts as tables"></button></div>
    <div class="switch"><span>Compact density<small>More of the house on one screen</small></span><button type="button" role="switch" data-sw="density" aria-checked="${prefs.density === "compact"}" aria-label="Compact density"></button></div>
    <div class="switch"><span>Screen reader announcements<small>Speak bed reservations and surge changes</small></span><button type="button" role="switch" data-sw="announce" aria-checked="${prefs.announce}" aria-label="Screen reader announcements"></button></div>
    <p class="demo-note" style="margin-top:16px">Every bed is a button with a full spoken description. Press <kbd>?</kbd> for shortcuts.</p></div>`;
  const body = $("#a11y-body");
  $$("[data-pg]", body).forEach((b) => b.addEventListener("click", () => { prefs[b.dataset.pg] = b.dataset.pv; applyPrefs(); $$(`[data-pg="${b.dataset.pg}"]`, body).forEach((x) => x.setAttribute("aria-checked", x === b)); route(); }));
  $("#fs", body).addEventListener("input", (e) => { prefs.fs = +e.target.value; applyPrefs(); $("#fs-out").textContent = Math.round(prefs.fs * 100) + "%"; });
  $("#fs", body).addEventListener("change", () => route());
  $$("[data-mo]", body).forEach((b) => b.addEventListener("click", () => { prefs.motion = b.dataset.mo; applyPrefs(); $$("[data-mo]", body).forEach((x) => x.setAttribute("aria-pressed", x === b)); }));
  $$("[data-sw]", body).forEach((b) => b.addEventListener("click", () => {
    const k = b.dataset.sw;
    if (k === "density") prefs.density = prefs.density === "compact" ? "comfortable" : "compact"; else prefs[k] = !prefs[k];
    b.setAttribute("aria-checked", k === "density" ? prefs.density === "compact" : prefs[k]); applyPrefs(); if (k === "tables") route();
  }));
}

/* ---------------------------------------------------------------- boot */
(async function boot() {
  [state.layout, state.live, state.metrics] = await Promise.all([api("/api/layout"), api("/api/live"), api("/api/metrics")]);
  UNITS = Object.fromEntries(state.layout.units.map((u) => [u.key, u]));
  const now = new Date(state.live.now);
  $("#today-chip").textContent = now.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  updateBadge();
  addEventListener("hashchange", route);
  route();
})();
