// Hand-built SVG charts. Every chart gets an accessible name, a text summary, keyboard focus where it is
// interactive, and the caller can render the same data as a table.
const NS = "http://www.w3.org/2000/svg";
const tip = () => document.getElementById("tip");

export function showTip(html, x, y) {
  const t = tip();
  t.innerHTML = html;
  t.hidden = false;
  const r = t.getBoundingClientRect();
  let left = x + 16, top = y - r.height / 2;
  if (left + r.width > innerWidth - 10) left = x - r.width - 16;
  top = Math.max(10, Math.min(innerHeight - r.height - 10, top));
  t.style.left = left + "px";
  t.style.top = top + "px";
}
export function hideTip() { tip().hidden = true; }

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim() || v;

function scale(d0, d1, r0, r1) {
  const f = (v) => r0 + ((v - d0) / (d1 - d0 || 1)) * (r1 - r0);
  f.inv = (p) => d0 + ((p - r0) / (r1 - r0 || 1)) * (d1 - d0);
  return f;
}
function nice(lo, hi, n = 4) {
  const span = hi - lo || 1, step0 = span / n, mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0);
  const a = Math.floor(lo / step) * step, b = Math.ceil(hi / step) * step, out = [];
  for (let v = a; v <= b + 1e-9; v += step) out.push(+v.toFixed(6));
  return out;
}
const path = (pts) => pts.reduce((s, p, i) => (p == null ? s : s + (i && pts[i - 1] != null ? "L" : "M") + p[0].toFixed(1) + "," + p[1].toFixed(1)), "");
function smooth(pts) {                          // monotone-ish cubic for nicer curves; gaps break the line
  let d = "";
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (!p) continue;
    const prev = pts[i - 1];
    if (!prev) { d += `M${p[0].toFixed(1)},${p[1].toFixed(1)}`; continue; }
    const mx = (prev[0] + p[0]) / 2;
    d += `C${mx.toFixed(1)},${prev[1].toFixed(1)} ${mx.toFixed(1)},${p[1].toFixed(1)} ${p[0].toFixed(1)},${p[1].toFixed(1)}`;
  }
  return d;
}

export function sparkline(values, { w = 120, h = 34, color = "var(--ours)", values2 = null, color2 = "var(--coral)", fill = true } = {}) {
  const all = values.concat(values2 || []).filter((v) => v != null);
  const lo = Math.min(...all), hi = Math.max(...all);
  const x = scale(0, values.length - 1, 2, w - 2), y = scale(lo, hi, h - 3, 3);
  const pts = values.map((v, i) => (v == null ? null : [x(i), y(v)]));
  const p2 = values2 ? values2.map((v, i) => (v == null ? null : [x(i), y(v)])) : null;
  const last = pts.filter(Boolean).pop();
  const gid = "sg" + Math.random().toString(36).slice(2, 8);
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".28"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
    ${fill ? `<path d="${path(pts)}L${w - 2},${h}L2,${h}Z" fill="url(#${gid})"/>` : ""}
    ${p2 ? `<path d="${path(p2)}" fill="none" stroke="${color2}" stroke-width="1.3" stroke-dasharray="3 3" opacity=".9"/>` : ""}
    <path d="${path(pts)}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round"/>
    ${last ? `<circle cx="${last[0]}" cy="${last[1]}" r="2.6" fill="${color}"/>` : ""}</svg>`;
}

export function ring(score, { size = 54, stroke = 6, color = "var(--mint)", label = true } = {}) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r, v = Math.max(0, Math.min(1, score));
  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="Match score ${Math.round(v * 100)} percent">
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--line-2)" stroke-width="${stroke}"/>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round"
      stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - v)}" transform="rotate(-90 ${size / 2} ${size / 2})" style="transition:stroke-dashoffset 1s cubic-bezier(.2,.8,.2,1)"/>
    ${label ? `<text x="50%" y="53%" text-anchor="middle" dominant-baseline="middle" style="fill:var(--text);font:700 ${size * 0.26}px var(--mono)">${Math.round(v * 100)}</text>` : ""}</svg>`;
}

/* Multi-series time chart with crosshair, keyboard scrubbing, bands (promos), hatched gaps (stock-outs),
   a reference line (MAP) and point markers (pricing errors). */
export function lineChart(el, o) {
  const W = Math.max(320, el.clientWidth || 600), H = o.height || 260, m = { t: 14, r: 16, b: 26, l: 52 };
  const n = o.labels.length;
  const vals = o.series.flatMap((s) => s.values).filter((v) => v != null);
  if (o.ref) vals.push(o.ref.y);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (o.yMin != null) lo = Math.min(lo, o.yMin);
  if (o.yMax != null) hi = Math.max(hi, o.yMax);
  const padv = (hi - lo) * 0.08 || 1;
  const ticks = nice(lo >= 0 ? Math.max(0, lo - padv) : lo - padv, hi + padv, 4).filter((t, i, arr) => !(lo >= 0 && t < 0));
  const x = scale(0, n - 1, m.l, W - m.r), y = scale(ticks[0], ticks[ticks.length - 1], H - m.b, m.t);
  const fmt = o.fmt || ((v) => v.toFixed(0));
  const id = "lc" + Math.random().toString(36).slice(2, 7);
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" tabindex="0" aria-label="${esc(o.title || "Chart")}" aria-describedby="${id}-d">
  <desc id="${id}-d">${esc(o.summary || "")} Use the left and right arrow keys to read each day.</desc>
  <defs>
    <pattern id="${id}-h" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="var(--faint)" stroke-width="2" opacity=".6"/></pattern>
    <filter id="${id}-g" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="3.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    ${o.series.map((se, i) => `<linearGradient id="${id}-a${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${se.color}" stop-opacity=".22"/><stop offset="1" stop-color="${se.color}" stop-opacity="0"/></linearGradient>`).join("")}
  </defs><g class="grid">`;
  for (const t of ticks) s += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}"/><text x="${m.l - 10}" y="${y(t) + 3.5}" text-anchor="end">${fmt(t)}</text>`;
  s += `</g>`;
  const every = Math.ceil(n / 7);
  o.labels.forEach((l, i) => { if (i % every === 0 || i === n - 1) s += `<text x="${x(i)}" y="${H - 6}" text-anchor="middle">${esc(l)}</text>`; });
  for (const b of o.bands || []) {
    const x0 = x(Math.max(0, b.from - 0.5)), x1 = x(Math.min(n - 1, b.to + 0.5));
    s += `<rect x="${x0}" y="${m.t}" width="${x1 - x0}" height="${H - m.b - m.t}" fill="${b.color}" opacity=".09" rx="6"/>
          <text x="${(x0 + x1) / 2}" y="${m.t + 11}" text-anchor="middle" style="fill:${b.color};font-size:9.5px">${esc(b.label)}</text>`;
  }
  for (const hz of o.hatches || []) {
    const x0 = x(Math.max(0, hz.from - 0.5)), x1 = x(Math.min(n - 1, hz.to + 0.5));
    s += `<rect x="${x0}" y="${m.t}" width="${x1 - x0}" height="${H - m.b - m.t}" fill="url(#${id}-h)" opacity=".55"/>
          <text x="${(x0 + x1) / 2}" y="${H - m.b - 6}" text-anchor="middle" style="font-size:9.5px">${esc(hz.label)}</text>`;
  }
  for (const rb of o.ribbons || []) {                // shaded interval, e.g. an 80% forecast band
    const up = [], dn = [];
    rb.hi.forEach((v, j) => { if (v != null && rb.lo[j] != null) { up.push([x(j), y(v)]); dn.push([x(j), y(rb.lo[j])]); } });
    if (up.length) s += `<path d="M${up.map((p) => p.join(",")).join("L")}L${dn.reverse().map((p) => p.join(",")).join("L")}Z" fill="${rb.color}" opacity=".16"/>`;
  }
  for (const vl of o.vlines || []) {
    s += `<line x1="${x(vl.x)}" x2="${x(vl.x)}" y1="${m.t}" y2="${H - m.b}" stroke="${vl.color || "var(--line-2)"}" stroke-dasharray="4 4"/>
          <text x="${x(vl.x) + 6}" y="${m.t + 11}" style="fill:${vl.color || "var(--muted)"};font-size:9.5px">${esc(vl.label || "")}</text>`;
  }
  if (o.ref) s += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(o.ref.y)}" y2="${y(o.ref.y)}" stroke="${o.ref.color}" stroke-dasharray="5 5" stroke-width="1.4"/>
     <text x="${m.l + 8}" y="${y(o.ref.y) + 14}" text-anchor="start" style="fill:${o.ref.color}">${esc(o.ref.label)}</text>`;
  o.series.forEach((se, i) => {
    const pts = se.values.map((v, j) => (v == null ? null : [x(j), y(v)]));
    const d = o.step ? path(stepify(pts)) : smooth(pts);
    if (se.area) {
      const first = pts.find(Boolean), last = [...pts].reverse().find(Boolean);
      s += `<path class="area" d="${d}L${last[0]},${H - m.b}L${first[0]},${H - m.b}Z" fill="url(#${id}-a${i})"/>`;
    }
    s += `<path class="draw" pathLength="1000" style="--len:1000;animation-delay:${i * 120}ms" d="${d}" fill="none" stroke="${se.color}" stroke-width="${se.width || 2}"
            ${se.dash ? `stroke-dasharray="${se.dash}"` : ""} stroke-linejoin="round" stroke-linecap="round" ${se.glow ? `filter="url(#${id}-g)"` : ""}/>`;
  });
  for (const mk of o.markers || []) {
    s += `<g><circle cx="${x(mk.x)}" cy="${y(mk.y)}" r="11" fill="${mk.color}" opacity=".16"><animate attributeName="r" values="7;14;7" dur="2.2s" repeatCount="indefinite"/></circle>
          <circle cx="${x(mk.x)}" cy="${y(mk.y)}" r="4.5" fill="${mk.color}" stroke="var(--panel-solid)" stroke-width="2"/>
          <text x="${x(mk.x) + (x(mk.x) > W * 0.7 ? -14 : 14)}" y="${y(mk.y) + 4}" text-anchor="${x(mk.x) > W * 0.7 ? "end" : "start"}" style="fill:${mk.color};font-weight:600">${esc(mk.label)}</text></g>`;
  }
  s += `<g class="xh" opacity="0"><line y1="${m.t}" y2="${H - m.b}" stroke="var(--line-2)" stroke-dasharray="3 3"/>
        ${o.series.map((se) => `<circle r="4.5" fill="${se.color}" stroke="var(--panel-solid)" stroke-width="2"/>`).join("")}</g>
        <rect class="hit" x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}" fill="transparent"/></svg>`;
  el.innerHTML = s;
  const svg = el.querySelector("svg"), xh = svg.querySelector(".xh"), line = xh.querySelector("line"), dots = xh.querySelectorAll("circle");
  let cur = n - 1;
  const show = (i, cx, cy) => {
    cur = Math.max(0, Math.min(n - 1, i));
    xh.setAttribute("opacity", 1);
    line.setAttribute("x1", x(cur)); line.setAttribute("x2", x(cur));
    o.series.forEach((se, k) => {
      const v = se.values[cur];
      dots[k].setAttribute("cx", x(cur)); dots[k].setAttribute("cy", v == null ? -99 : y(v));
    });
    const rows = o.series.map((se) => `<div class="tr"><span><i class="pip" style="background:${se.color}"></i>${esc(se.name)}</span>${se.values[cur] == null ? "—" : fmt(se.values[cur])}</div>`).join("");
    const extra = o.note ? o.note(cur) : "";
    const r = svg.getBoundingClientRect();
    showTip(`<b>${esc(o.tipLabels ? o.tipLabels[cur] : o.labels[cur])}</b>${rows}${extra}`, cx ?? r.left + (x(cur) / W) * r.width, cy ?? r.top + r.height / 3);
  };
  svg.querySelector(".hit").addEventListener("mousemove", (e) => {
    const r = svg.getBoundingClientRect();
    show(Math.round(x.inv(((e.clientX - r.left) / r.width) * W)), e.clientX, e.clientY);
  });
  svg.addEventListener("mouseleave", () => { xh.setAttribute("opacity", 0); hideTip(); });
  svg.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); show(cur + (e.key === "ArrowRight" ? 1 : -1)); }
    if (e.key === "Home") show(0);
    if (e.key === "End") show(n - 1);
  });
  svg.addEventListener("blur", () => { xh.setAttribute("opacity", 0); hideTip(); });
  return { show };
}
function stepify(pts) {
  const out = [];
  pts.forEach((p, i) => { if (!p) { out.push(null); return; } const prev = pts[i - 1]; if (prev) out.push([p[0], prev[1]]); out.push(p); });
  return out;
}

/* Price Compass: one spoke per category, rings around 100 = parity. Our index is the bright polygon. */
export function compass(el, { axes, series, range = [90, 112] }) {
  const avail = el.clientWidth > 200 ? el.clientWidth : (el.parentElement?.clientWidth || 800) * 0.55;
  const S = Math.max(300, Math.min(avail, 470)), c = S / 2, R = S / 2 - 58;
  const rs = scale(range[0], range[1], R * 0.12, R);
  const ang = (i) => -Math.PI / 2 + (i / axes.length) * Math.PI * 2;
  const pt = (i, v) => [c + Math.cos(ang(i)) * rs(Math.max(range[0], Math.min(range[1], v))), c + Math.sin(ang(i)) * rs(Math.max(range[0], Math.min(range[1], v)))];
  let s = `<svg class="chart" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}" role="img" aria-label="Price compass by category">
    <defs><radialGradient id="cg"><stop offset="0" stop-color="var(--mint)" stop-opacity=".12"/><stop offset="1" stop-color="var(--mint)" stop-opacity="0"/></radialGradient>
    <filter id="cglow"><feGaussianBlur stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
    <circle cx="${c}" cy="${c}" r="${R}" fill="url(#cg)"/>`;
  for (const v of [92, 96, 100, 104, 108, 112]) {
    if (v < range[0] || v > range[1]) continue;
    s += `<circle cx="${c}" cy="${c}" r="${rs(v)}" fill="none" stroke="${v === 100 ? "var(--line-2)" : "var(--line)"}" ${v === 100 ? 'stroke-dasharray="4 4" stroke-width="1.4"' : ""}/>
          <text x="${c + 4}" y="${c - rs(v) - 3}" style="font-size:9px">${v}</text>`;
  }
  axes.forEach((a, i) => {
    const [x2, y2] = [c + Math.cos(ang(i)) * R, c + Math.sin(ang(i)) * R];
    const [lx, ly] = [c + Math.cos(ang(i)) * (R + 26), c + Math.sin(ang(i)) * (R + 26)];
    s += `<line x1="${c}" y1="${c}" x2="${x2}" y2="${y2}" stroke="var(--line)"/>
          <text class="ax" data-i="${i}" x="${lx}" y="${ly}" text-anchor="middle" dominant-baseline="middle" style="fill:var(--text);font:600 11px var(--ui);cursor:pointer" tabindex="0">${esc(a)}</text>`;
  });
  series.forEach((se, k) => {
    const pts = se.values.map((v, i) => pt(i, v));
    s += `<polygon class="compass-poly" style="animation-delay:${k * 140}ms" points="${pts.map((p) => p.join(",")).join(" ")}"
            fill="${se.color}" fill-opacity="${se.main ? 0.16 : 0.04}" stroke="${se.color}" stroke-width="${se.main ? 2.4 : 1.3}"
            ${se.main ? 'filter="url(#cglow)"' : 'stroke-dasharray="4 3"'} stroke-linejoin="round"/>`;
    if (se.main) pts.forEach((p) => (s += `<circle cx="${p[0]}" cy="${p[1]}" r="3.6" fill="${se.color}" stroke="var(--panel-solid)" stroke-width="1.5"/>`));
  });
  s += `<circle cx="${c}" cy="${c}" r="${rs(100)}" fill="none" stroke="var(--ours)" stroke-width="1.6" stroke-dasharray="5 5" opacity=".9"/>
        <g transform="translate(${c + rs(100) * 0.71},${c + rs(100) * 0.71})"><rect x="-4" y="-9" width="34" height="17" rx="8" fill="var(--panel-solid)" stroke="var(--ours)"/>
        <text x="13" y="3" text-anchor="middle" style="fill:var(--ours);font:700 9.5px var(--ui)">You</text></g>
        <text x="${c}" y="${c + 4}" text-anchor="middle" style="fill:var(--faint);font-size:9px">cheaper</text></svg>`;
  el.innerHTML = s;
  el.querySelectorAll(".ax").forEach((t) => {
    const i = +t.dataset.i;
    const html = () => `<b>${esc(axes[i])}</b>` + series.map((se) => `<div class="tr"><span><i class="pip" style="background:${se.color}"></i>${esc(se.name)}</span>${se.values[i]?.toFixed(1) ?? "—"}</div>`).join("");
    t.addEventListener("mouseenter", (e) => showTip(html(), e.clientX, e.clientY));
    t.addEventListener("mouseleave", hideTip);
    t.addEventListener("focus", () => { const r = t.getBoundingClientRect(); showTip(html(), r.right, r.top); });
    t.addEventListener("blur", hideTip);
  });
}

export function histogram(el, { bins, lo, step }, { height = 150 } = {}) {
  const W = Math.max(300, el.clientWidth || 500), H = height, m = { t: 8, r: 6, b: 22, l: 6 };
  const mx = Math.max(1, ...bins), bw = (W - m.l - m.r) / bins.length;
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Distribution of suggested price moves">`;
  bins.forEach((b, i) => {
    const v0 = lo + i * step, h = ((H - m.t - m.b) * b) / mx;
    const col = v0 < 0 ? "var(--coral)" : "var(--mint)";
    s += `<rect x="${m.l + i * bw + 1.5}" y="${H - m.b - h}" width="${bw - 3}" height="${Math.max(h, b ? 2 : 0)}" rx="3" fill="${col}" opacity="${b ? 0.85 : 0.15}">
            <title>${b} products ${v0 >= 0 ? "+" : ""}${v0}% to ${v0 + step}%</title></rect>`;
    if ((v0 % 4 === 0)) s += `<text x="${m.l + i * bw}" y="${H - 6}" text-anchor="middle">${v0 > 0 ? "+" : ""}${v0}%</text>`;
  });
  s += `<line x1="${m.l + ((0 - lo) / step) * bw}" x2="${m.l + ((0 - lo) / step) * bw}" y1="${m.t}" y2="${H - m.b}" stroke="var(--line-2)"/></svg>`;
  el.innerHTML = s;
}

export function bars(el, values, { labels = [], height = 120, color = "var(--violet)", fmtTip = (v) => v } = {}) {
  const W = Math.max(300, el.clientWidth || 500), H = height, m = { t: 6, r: 4, b: 20, l: 4 };
  const mx = Math.max(1, ...values), bw = (W - m.l - m.r) / values.length;
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Alerts per day">`;
  values.forEach((v, i) => {
    const h = ((H - m.t - m.b) * v) / mx;
    s += `<rect class="bar" data-i="${i}" x="${m.l + i * bw + 1.5}" y="${H - m.b - h}" width="${bw - 3}" height="${Math.max(h, v ? 2 : 1)}" rx="3"
            fill="${color}" opacity="${v ? 0.9 : 0.2}" style="transform-origin:center ${H - m.b}px;animation:grow2 .7s ${i * 18}ms cubic-bezier(.2,.8,.2,1) both"/>`;
    if (labels[i] && i % 5 === 0) s += `<text x="${m.l + i * bw + bw / 2}" y="${H - 5}" text-anchor="middle">${esc(labels[i])}</text>`;
  });
  s += `<style>@keyframes grow2{from{transform:scaleY(0)}}</style></svg>`;
  el.innerHTML = s;
  el.querySelectorAll(".bar").forEach((b) => {
    b.addEventListener("mouseenter", (e) => showTip(fmtTip(values[+b.dataset.i], +b.dataset.i), e.clientX, e.clientY));
    b.addEventListener("mouseleave", hideTip);
  });
}

export function stacked(el, rows, keys, colors, { height = 170, labels = [] } = {}) {
  const W = Math.max(300, el.clientWidth || 500), H = height, m = { t: 8, r: 4, b: 20, l: 40 };
  const tot = rows.map((r) => keys.reduce((a, k) => a + (r[k] || 0), 0));
  const ticks = nice(0, Math.max(...tot), 3);
  const y = scale(0, ticks[ticks.length - 1], H - m.b, m.t), bw = (W - m.l - m.r) / rows.length;
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Requests per day by store"><g class="grid">`;
  ticks.forEach((t) => (s += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}"/><text x="${m.l - 8}" y="${y(t) + 3.5}" text-anchor="end">${t}</text>`));
  s += "</g>";
  rows.forEach((r, i) => {
    let acc = 0;
    keys.forEach((k, j) => {
      const v = r[k] || 0, y0 = y(acc), y1 = y(acc + v);
      s += `<rect class="sb" data-i="${i}" x="${m.l + i * bw + 2}" y="${y1}" width="${bw - 4}" height="${Math.max(0, y0 - y1)}" fill="${colors[j]}" rx="2"
               style="transform-origin:center ${H - m.b}px;animation:grow2 .8s ${i * 20}ms cubic-bezier(.2,.8,.2,1) both"/>`;
      acc += v;
    });
    if (labels[i] && i % 5 === 0) s += `<text x="${m.l + i * bw + bw / 2}" y="${H - 5}" text-anchor="middle">${esc(labels[i])}</text>`;
  });
  s += `<style>@keyframes grow2{from{transform:scaleY(0)}}</style></svg>`;
  el.innerHTML = s;
  el.querySelectorAll(".sb").forEach((b) => {
    b.addEventListener("mouseenter", (e) => {
      const r = rows[+b.dataset.i];
      showTip(`<b>${esc(labels[+b.dataset.i])}</b>` + keys.map((k, j) => `<div class="tr"><span><i class="pip" style="background:${colors[j]}"></i>${esc(k)}</span>${r[k]}</div>`).join(""), e.clientX, e.clientY);
    });
    b.addEventListener("mouseleave", hideTip);
  });
}

export function heatColor(gap) {          // gap = competitor vs us, %: positive = they are pricier (good for us)
  if (gap == null) return "transparent";
  if (gap === "oos") return "var(--panel-2)";
  const t = Math.min(1, Math.abs(gap) / 10);
  const c = gap >= 0 ? "var(--good)" : "var(--bad)";
  return `color-mix(in srgb, ${c} ${Math.round(12 + t * 70)}%, transparent)`;
}

/* Reliability diagram: predicted probability vs what actually happened, bubble size = number of patients. */
export function calibration(el, pts, { size = 300 } = {}) {
  const W = Math.max(260, Math.min(el.clientWidth || size, 420)), H = W * 0.8, m = { t: 12, r: 12, b: 30, l: 40 };
  const x = (v) => m.l + v * (W - m.l - m.r), y = (v) => H - m.b - v * (H - m.t - m.b);
  const mx = Math.max(...pts.map((p) => p.n));
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Calibration: predicted against observed">
    <g class="grid">${[0, 0.25, 0.5, 0.75, 1].map((v) => `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${m.l - 8}" y="${y(v) + 3.5}" text-anchor="end">${v * 100}%</text>
      <text x="${x(v)}" y="${H - 10}" text-anchor="middle">${v * 100}%</text>`).join("")}</g>
    <line x1="${x(0)}" y1="${y(0)}" x2="${x(1)}" y2="${y(1)}" stroke="var(--faint)" stroke-dasharray="5 5"/>
    <path class="draw" pathLength="1000" style="--len:1000" d="${pts.map((p, i) => (i ? "L" : "M") + x(p.p) + "," + y(p.obs)).join("")}" fill="none" stroke="var(--mint)" stroke-width="2"/>
    ${pts.map((p) => `<circle cx="${x(p.p)}" cy="${y(p.obs)}" r="${3 + 9 * Math.sqrt(p.n / mx)}" fill="var(--mint)" fill-opacity=".25" stroke="var(--mint)"><title>predicted ${Math.round(p.p * 100)}%, observed ${Math.round(p.obs * 100)}%, ${p.n} patients</title></circle>`).join("")}
    <text x="${x(0.02)}" y="${y(0.92)}" style="fill:var(--muted);font-size:10px">observed ↑</text><text x="${x(0.98)}" y="${y(0.06)}" text-anchor="end" style="fill:var(--muted);font-size:10px">predicted →</text></svg>`;
  el.innerHTML = s;
}

/* Two series of bars side by side per bin (e.g. boarding hours under two policies). */
export function pairBars(el, a, b, { labels = [], colors = ["var(--faint)", "var(--mint)"], names = ["A", "B"], height = 170 } = {}) {
  const W = Math.max(300, el.clientWidth || 500), H = height, m = { t: 10, r: 6, b: 24, l: 36 };
  const mx = Math.max(...a, ...b, 1), n = a.length, gw = (W - m.l - m.r) / n, bw = gw * 0.36;
  const yv = (v) => H - m.b - ((H - m.t - m.b) * v) / mx;
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(names[0])} against ${esc(names[1])}"><g class="grid">`;
  for (const t of [0, Math.round(mx / 2), mx]) s += `<line x1="${m.l}" x2="${W - m.r}" y1="${yv(t)}" y2="${yv(t)}"/><text x="${m.l - 6}" y="${yv(t) + 3.5}" text-anchor="end">${t}</text>`;
  s += "</g>";
  for (let i = 0; i < n; i++) {
    const x0 = m.l + i * gw + gw * 0.12;
    [[a[i], colors[0], 0], [b[i], colors[1], 1]].forEach(([v, c, k]) => {
      s += `<rect class="pb" data-i="${i}" x="${x0 + k * (bw + 2)}" y="${yv(v)}" width="${bw}" height="${H - m.b - yv(v)}" rx="3" fill="${c}"
        style="transform-origin:center ${H - m.b}px;animation:grow2 .8s ${i * 30}ms cubic-bezier(.2,.8,.2,1) both"/>`;
    });
    if (labels[i] != null) s += `<text x="${x0 + bw}" y="${H - 7}" text-anchor="middle">${esc(labels[i])}</text>`;
  }
  s += `<style>@keyframes grow2{from{transform:scaleY(0)}}</style></svg>`;
  el.innerHTML = s;
  el.querySelectorAll(".pb").forEach((r) => {
    r.addEventListener("mouseenter", (e) => { const i = +r.dataset.i; showTip(`<b>${esc(labels[i])}</b><div class="tr"><span>${esc(names[0])}</span>${a[i]}</div><div class="tr"><span>${esc(names[1])}</span>${b[i]}</div>`, e.clientX, e.clientY); });
    r.addEventListener("mouseleave", hideTip);
  });
}
