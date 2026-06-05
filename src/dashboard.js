import { q } from "./db.js";

export function presetRange(preset) {
  const fmt = (x) => x.toISOString().slice(0, 10);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const sub = (n) => { const x = new Date(today); x.setDate(x.getDate() - n); return x; };
  switch (preset) {
    case "today": return { since: fmt(today), until: fmt(today), meta: "today" };
    case "yesterday": { const y = sub(1); return { since: fmt(y), until: fmt(y), meta: "yesterday" }; }
    case "7d": return { since: fmt(sub(6)), until: fmt(today), meta: "last_7d" };
    case "30d": return { since: fmt(sub(29)), until: fmt(today), meta: "last_30d" };
    case "month": return { since: fmt(new Date(now.getFullYear(), now.getMonth(), 1)), until: fmt(today), meta: "this_month" };
    case "max": return { since: null, until: null, meta: "maximum" };
    default: return null;
  }
}

const safeDate = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s || "") ? s : null);
const wd = (col, since, until, ts) => {
  const c = [];
  if (since) c.push(ts ? `${col} >= '${since}'::date` : `${col} >= '${since}'`);
  if (until) c.push(ts ? `${col} < ('${until}'::date + 1)` : `${col} <= '${until}'`);
  return c.length ? " AND " + c.join(" AND ") : "";
};
const num = (x) => Number(x || 0);
const GROUPS = { ad: "ad_id", adset: "adset_id", campaign: "campaign_id" };
const NAMES = { ad: "ad_name", adset: "adset_name", campaign: "campaign_name" };

export async function getData({ since, until } = {}) {
  since = safeDate(since); until = safeDate(until);
  const sales = (await q(
    `SELECT status,value,fee,product,payment_method,utm_source,paid_at,created_at
     FROM sales WHERE 1=1 ${wd("COALESCE(paid_at,created_at)", since, until, true)}`
  )).rows;
  const sp = (await q(
    `SELECT COALESCE(SUM(spend),0)::float spend, COALESCE(SUM(clicks),0)::int clicks
     FROM ad_spend WHERE 1=1 ${wd("date", since, until, false)}`
  )).rows[0];
  const evs = (await q(
    `SELECT event_name, COUNT(*)::int c FROM events WHERE 1=1 ${wd("event_time", since, until, true)} GROUP BY event_name`
  )).rows;
  const evMap = Object.fromEntries(evs.map((e) => [e.event_name, e.c]));

  const paid = sales.filter((s) => s.status === "paid");
  const sum = (arr, f) => arr.reduce((a, s) => a + num(f(s)), 0);
  const fat = sum(paid, (s) => s.value);
  const taxas = sum(paid, (s) => s.fee);
  const gasto = num(sp.spend);
  const lucro = fat - gasto - taxas;
  const grp = (arr, k, v = () => 1) => { const m = {}; arr.forEach((x) => { const key = k(x); (m[key] ||= { count: 0, value: 0 }); m[key].count++; m[key].value += num(v(x)); }); return m; };
  const cleanSrc = (s) => { const v = (s || "").toLowerCase(); if (v.includes("fb") || v.includes("face")) return "Facebook/Meta"; if (v.includes("ig") || v.includes("insta")) return "Instagram"; if (v.includes("membros")) return "Membros"; return s || "Direto"; };
  const payLabel = (m) => ({ CREDIT_CARD: "Cartão", PIX: "Pix", BOLETO: "Boleto", PAYPAL: "PayPal", TWO_CREDIT_CARDS: "Cartão" }[m] || m || "—");

  const byHour = {}; for (let h = 0; h < 24; h++) byHour[h] = 0;
  paid.forEach((s) => { if (s.paid_at) byHour[(new Date(s.paid_at).getUTCHours() + 21) % 24]++; });

  const approval = {};
  sales.forEach((s) => { const k = payLabel(s.payment_method); (approval[k] ||= { paid: 0, total: 0 }); approval[k].total++; if (s.status === "paid") approval[k].paid++; });

  const cbCount = sales.filter((s) => s.status === "chargeback").length;
  return {
    kpi: {
      fat, gasto, taxas, lucro,
      roas: gasto > 0 ? fat / gasto : 0,
      roi: gasto > 0 ? lucro / gasto : 0,
      margem: fat > 0 ? lucro / fat : 0,
      cpa: paid.length ? gasto / paid.length : 0,
      pending: sum(sales.filter((s) => s.status === "pending"), (s) => s.value),
      refunded: sum(sales.filter((s) => s.status === "refunded"), (s) => s.value),
      cbPct: paid.length + cbCount ? cbCount / (paid.length + cbCount) : 0,
      sales: paid.length,
    },
    funnel: { clicks: num(sp.clicks), pv: evMap.PageView || 0, ic: evMap.InitiateCheckout || 0, vendasInic: sales.length, vendasApr: paid.length },
    byProduct: grp(paid, (s) => s.product || "—", (s) => s.value),
    bySource: grp(paid, (s) => cleanSrc(s.utm_source)),
    byPayment: grp(paid, (s) => payLabel(s.payment_method)),
    byHour, approval,
  };
}

export async function getRows({ since, until, group = "ad", status = "paid" } = {}) {
  since = safeDate(since); until = safeDate(until);
  if (!GROUPS[group]) group = "ad";
  const key = GROUPS[group], name = NAMES[group];
  const sf = status === "all" ? "TRUE" : `status='${["paid", "pending", "refunded", "chargeback"].includes(status) ? status : "paid"}'`;
  const sql = `
    WITH sp AS (SELECT ${key} k, MAX(${name}) name, MAX(campaign_name) campaign_name, SUM(spend) spend
                FROM ad_spend WHERE ${key} IS NOT NULL${wd("date", since, until, false)} GROUP BY ${key}),
    sl AS (SELECT ${key} k, COUNT(*) FILTER (WHERE ${sf}) sales, COALESCE(SUM(value) FILTER (WHERE ${sf}),0) revenue
           FROM sales WHERE ${key} IS NOT NULL${wd("COALESCE(paid_at,created_at)", since, until, true)} GROUP BY ${key}),
    ev AS (SELECT ${key} k, COUNT(*) FILTER (WHERE event_name='PageView') pv,
             COUNT(*) FILTER (WHERE event_name='InitiateCheckout') ic
           FROM events WHERE ${key} IS NOT NULL${wd("event_time", since, until, true)} GROUP BY ${key}),
    ids AS (SELECT k FROM sp UNION SELECT k FROM sl UNION SELECT k FROM ev)
    SELECT i.k id, sp.name, sp.campaign_name, COALESCE(sp.spend,0)::float spend,
      COALESCE(sl.sales,0) sales, COALESCE(sl.revenue,0)::float revenue,
      COALESCE(ev.pv,0) pv, COALESCE(ev.ic,0) ic
    FROM ids i LEFT JOIN sp ON sp.k=i.k LEFT JOIN sl ON sl.k=i.k LEFT JOIN ev ON ev.k=i.k
    ORDER BY revenue DESC, spend DESC`;
  return (await q(sql)).rows;
}

const brl = (n) => "R$ " + Number(n || 0).toFixed(2).replace(".", ",");
const pct = (n) => (Number(n || 0) * 100).toFixed(1).replace(".", ",") + "%";
const esc = (s) => String(s ?? "").replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));

function donut(segments) {
  const total = segments.reduce((a, s) => a + s.value, 0) || 1;
  const R = 52, C = 2 * Math.PI * R; let off = 0;
  const arcs = segments.map((s) => { const dash = (s.value / total) * C; const el = `<circle r="${R}" cx="70" cy="70" fill="none" stroke="${s.color}" stroke-width="20" stroke-dasharray="${dash} ${C - dash}" stroke-dashoffset="${-off}" transform="rotate(-90 70 70)"/>`; off += dash; return el; }).join("");
  return `<svg width="140" height="140" viewBox="0 0 140 140">${arcs}<text x="70" y="66" text-anchor="middle" fill="#8b85a0" font-size="12">Total</text><text x="70" y="88" text-anchor="middle" fill="#ece9f3" font-size="22" font-weight="700">${total}</text></svg>`;
}
function listRows(obj, money) {
  const e = Object.entries(obj).sort((a, b) => b[1].count - a[1].count);
  const tot = e.reduce((a, [, v]) => a + v.count, 0) || 1;
  return e.map(([k, v]) => `<div class="lrow"><span class="ln">${esc(k)}</span><span class="lv">${money ? brl(v.value) : v.count}</span><span class="lp">${pct(v.count / tot)}</span></div>`).join("") || '<div class="dim">—</div>';
}

export function renderHtml(rows, data, st = {}) {
  const key = st.key || "";
  const qs = (extra) => "?key=" + encodeURIComponent(key) + extra;
  const k = data.kpi, f = data.funnel;
  const kp = (l, v, cls = "") => `<div class="kpi"><div class="kl">${l}</div><div class="kv ${cls}">${v}</div></div>`;

  const base = f.clicks || 1;
  const stages = [["Cliques", f.clicks], ["Vis. Página", f.pv], ["ICs", f.ic], ["Vendas Inic.", f.vendasInic], ["Vendas Apr.", f.vendasApr]];
  const funnelHtml = stages.map(([l, v]) => {
    const p = Math.round((v / base) * 1000) / 10;
    return `<div class="fstage"><div class="fbar" style="width:${Math.max(6, Math.min(100, p))}%"></div><div class="fmeta"><span>${l}</span><b>${v}</b><i>${p}%</i></div></div>`;
  }).join("");

  const colors = { "Pix": "#2563eb", "Cartão": "#38bdf8", "Boleto": "#eab308", "PayPal": "#a855f7", "—": "#6b7280" };
  const paySeg = Object.entries(data.byPayment).map(([n, v]) => ({ label: n, value: v.count, color: colors[n] || "#6b7280" }));
  const payLegend = paySeg.map((s) => `<span class="leg"><i style="background:${s.color}"></i>${esc(s.label)}</span>`).join("");

  const maxH = Math.max(1, ...Object.values(data.byHour));
  const hours = Object.entries(data.byHour).map(([h, c]) => `<div class="hb" title="${h}h: ${c}"><div style="height:${Math.round(c / maxH * 100)}%"></div><span>${String(h).padStart(2, "0")}</span></div>`).join("");

  const approvalHtml = Object.entries(data.approval).map(([m, v]) => `<div class="lrow"><span class="ln">${esc(m)}</span><span class="lp">${v.total ? pct(v.paid / v.total) : "—"}</span></div>`).join("") || '<div class="dim">—</div>';

  const tbody = rows.map((r) => {
    const roas = r.spend > 0 ? r.revenue / r.spend : 0;
    const rc = roas >= 2 ? "good" : roas >= 1 ? "mid" : r.spend > 0 ? "bad" : "";
    const profit = r.revenue - r.spend;
    const sub = st.group === "campaign" ? "" : `<br><span class="dim">${esc(r.campaign_name)}</span>`;
    return `<tr><td><b>${esc(r.name || r.id || "?")}</b>${sub}</td><td class="num">${brl(r.spend)}</td><td class="num">${r.sales}</td><td class="num">${brl(r.revenue)}</td><td class="num ${rc}">${roas ? roas.toFixed(2) + "x" : "—"}</td><td class="num ${profit >= 0 ? "good" : "bad"}">${brl(profit)}</td><td class="num dim">${r.pv}</td><td class="num dim">${r.ic}</td></tr>`;
  }).join("") || '<tr><td colspan="8" class="dim">Sem dados no período.</td></tr>';

  const presets = [["today", "Hoje"], ["yesterday", "Ontem"], ["7d", "7 dias"], ["30d", "30 dias"], ["month", "Este mês"], ["max", "Máximo"]];
  const chips = presets.map(([p, l]) => `<a class="chip ${st.preset === p ? "on" : ""}" href="${qs(`&preset=${p}&group=${st.group}&status=${st.status}`)}">${l}</a>`).join("");
  const opt = (v, l, cur) => `<option value="${v}" ${cur === v ? "selected" : ""}>${l}</option>`;

  return `<!doctype html><html lang="pt-br"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>track-helmer</title><style>
 :root{--bg:#0a0a14;--card:#13131f;--ink:#eef;--dim:#8b8ba3;--good:#46d39a;--bad:#ef6b6b;--line:#22223a;--accent:#2563eb;--p:#7c3aed}
 *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,Segoe UI,Roboto,sans-serif}
 header{padding:16px 24px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px}
 h1{font-size:16px;margin:0}.sub{color:var(--dim);font-size:12px}
 .bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:0 24px 14px}
 .chip{color:var(--dim);text-decoration:none;padding:6px 12px;border:1px solid var(--line);border-radius:20px;font-size:12.5px}.chip.on{background:var(--accent);color:#fff;border-color:var(--accent)}
 .bar input,.bar select{background:var(--card);color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:7px 9px;font-size:12.5px}
 .btn{background:var(--accent);color:#fff;border:none;text-decoration:none;padding:8px 14px;border-radius:9px;font-size:13px;cursor:pointer}
 .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:12px;padding:0 24px}
 .kpi{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px}
 .kl{color:var(--dim);font-size:12px}.kv{font-size:21px;font-weight:700;margin-top:4px}
 .cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px;padding:14px 24px}
 .panel{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px}
 .panel h3{margin:0 0 12px;font-size:13px;color:var(--dim);font-weight:600;text-transform:uppercase;letter-spacing:.05em}
 .fstage{margin:9px 0}.fbar{height:10px;background:linear-gradient(90deg,var(--accent),var(--p));border-radius:6px}
 .fmeta{display:flex;gap:8px;align-items:baseline;font-size:12.5px;margin-top:3px}.fmeta b{margin-left:auto}.fmeta i{color:var(--dim);font-style:normal;width:54px;text-align:right}
 .lrow{display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--line);font-size:13px}.lrow:last-child{border:none}
 .ln{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.lv{font-variant-numeric:tabular-nums}.lp{color:var(--dim);width:54px;text-align:right}
 .donutwrap{display:flex;gap:14px;align-items:center;flex-wrap:wrap}.leg{display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--dim);margin-right:10px}.leg i{width:10px;height:10px;border-radius:3px;display:inline-block}
 .hours{display:flex;gap:2px;align-items:flex-end;height:110px}.hb{flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;height:100%}
 .hb>div{width:60%;background:var(--accent);border-radius:3px 3px 0 0;min-height:2px}.hb span{font-size:8px;color:var(--dim);margin-top:3px;transform:rotate(-60deg)}
 table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden}
 th,td{padding:10px 13px;text-align:left;border-bottom:1px solid var(--line)}th{color:var(--dim);font-size:11px;text-transform:uppercase}
 td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}.dim{color:var(--dim)}.good{color:var(--good)}.bad{color:var(--bad)}.mid{color:#e6b450}
 .wrap{padding:0 24px 40px}
</style></head><body>
<header><div><h1>📊 track-helmer</h1><div class="sub">Resumo · gasto (Meta) × vendas (Greenn) × funil (pixel)</div></div>
 <a class="btn" href="/admin/sync${qs(`&preset=${st.preset || "30d"}&group=${st.group}&status=${st.status}`)}">↻ Atualizar gasto</a></header>
<form class="bar" method="get" action="/dashboard"><input type="hidden" name="key" value="${esc(key)}">
 ${chips}
 <label><input type="date" name="since" value="${st.since || ""}"></label>
 <label><input type="date" name="until" value="${st.until || ""}"></label>
 <select name="group">${opt("ad", "Por anúncio", st.group)}${opt("adset", "Por conjunto", st.group)}${opt("campaign", "Por campanha", st.group)}</select>
 <select name="status">${opt("paid", "Pagas", st.status)}${opt("all", "Todas", st.status)}${opt("pending", "Pendentes", st.status)}${opt("refunded", "Reembolsadas", st.status)}</select>
 <button class="btn" type="submit">Filtrar</button>
 <input type="search" placeholder="🔍 Buscar..." oninput="flt(this.value)">
</form>
<div class="grid">
 ${kp("Faturamento Líquido", brl(k.fat))}
 ${kp("Gastos com anúncios", brl(k.gasto))}
 ${kp("ROAS", k.roas ? k.roas.toFixed(2) + "x" : "—", k.roas >= 1 ? "good" : k.gasto ? "bad" : "")}
 ${kp("Lucro", brl(k.lucro), k.lucro >= 0 ? "good" : "bad")}
 ${kp("ROI", k.roi ? (k.roi * 100).toFixed(0) + "%" : "—", k.roi >= 0 ? "good" : "bad")}
 ${kp("Margem", k.fat ? pct(k.margem) : "—", k.margem >= 0 ? "good" : "bad")}
 ${kp("Vendas aprovadas", k.sales)}
 ${kp("Vendas pendentes", brl(k.pending))}
 ${kp("Reembolsadas", brl(k.refunded))}
 ${kp("Taxas (Greenn)", brl(k.taxas))}
 ${kp("Chargeback", pct(k.cbPct))}
 ${kp("CPA", brl(k.cpa))}
</div>
<div class="cols">
 <div class="panel"><h3>Funil de Conversão (Meta Ads)</h3>${funnelHtml}</div>
 <div class="panel"><h3>Vendas por Fonte</h3>${listRows(data.bySource)}</div>
 <div class="panel"><h3>Vendas por Pagamento</h3><div class="donutwrap">${donut(paySeg)}<div>${payLegend}</div></div></div>
 <div class="panel"><h3>Vendas por Produto</h3>${listRows(data.byProduct, true)}</div>
 <div class="panel"><h3>Vendas por Horário</h3><div class="hours">${hours}</div></div>
 <div class="panel"><h3>Taxa de Aprovação</h3>${approvalHtml}</div>
</div>
<div class="wrap"><table>
 <thead><tr><th>${st.group === "campaign" ? "Campanha" : st.group === "adset" ? "Conjunto" : "Anúncio"}</th><th class="num">Gasto</th><th class="num">Vendas</th><th class="num">Receita</th><th class="num">ROAS</th><th class="num">Lucro</th><th class="num">PV</th><th class="num">IC</th></tr></thead>
 <tbody>${tbody}</tbody>
</table></div>
<script>function flt(v){v=v.toLowerCase();document.querySelectorAll('tbody tr').forEach(function(tr){tr.style.display=tr.textContent.toLowerCase().includes(v)?'':'none';});}</script>
</body></html>`;
}
