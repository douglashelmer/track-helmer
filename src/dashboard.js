import { q } from "./db.js";

// Map a preset key → {since, until (YYYY-MM-DD or null), meta (FB date_preset)}.
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
const GROUPS = { ad: "ad_id", adset: "adset_id", campaign: "campaign_id" };
const NAMES = { ad: "ad_name", adset: "adset_name", campaign: "campaign_name" };

// Per-(ad|adset|campaign) join: spend × sales × funnel, scoped by date/status.
export async function getRows({ since, until, group = "ad", status = "paid" } = {}) {
  since = safeDate(since); until = safeDate(until);
  if (!GROUPS[group]) group = "ad";
  const key = GROUPS[group], name = NAMES[group];
  const dr = (col, ts) => {
    const c = [];
    if (since) c.push(ts ? `${col} >= '${since}'::date` : `${col} >= '${since}'`);
    if (until) c.push(ts ? `${col} < ('${until}'::date + 1)` : `${col} <= '${until}'`);
    return c.length ? " AND " + c.join(" AND ") : "";
  };
  const sf = status === "all" ? "TRUE" : `status='${["paid","pending","refunded","chargeback"].includes(status) ? status : "paid"}'`;

  const sql = `
    WITH sp AS (
      SELECT ${key} k, MAX(${name}) name, MAX(campaign_name) campaign_name,
             SUM(spend) spend, SUM(impressions) impressions, SUM(clicks) clicks
      FROM ad_spend WHERE ${key} IS NOT NULL${dr("date", false)} GROUP BY ${key}
    ),
    sl AS (
      SELECT ${key} k,
        COUNT(*) FILTER (WHERE ${sf}) sales,
        COALESCE(SUM(value) FILTER (WHERE ${sf}),0) revenue
      FROM sales WHERE ${key} IS NOT NULL${dr("COALESCE(paid_at,created_at)", true)} GROUP BY ${key}
    ),
    ev AS (
      SELECT ${key} k,
        COUNT(*) FILTER (WHERE event_name='PageView') pv,
        COUNT(*) FILTER (WHERE event_name='ViewContent') vc,
        COUNT(*) FILTER (WHERE event_name='InitiateCheckout') ic
      FROM events WHERE ${key} IS NOT NULL${dr("event_time", true)} GROUP BY ${key}
    ),
    ids AS (SELECT k FROM sp UNION SELECT k FROM sl UNION SELECT k FROM ev)
    SELECT i.k id, sp.name, sp.campaign_name,
      COALESCE(sp.spend,0)::float spend, COALESCE(sp.impressions,0) impressions, COALESCE(sp.clicks,0) clicks,
      COALESCE(sl.sales,0) sales, COALESCE(sl.revenue,0)::float revenue,
      COALESCE(ev.pv,0) pv, COALESCE(ev.vc,0) vc, COALESCE(ev.ic,0) ic
    FROM ids i
    LEFT JOIN sp ON sp.k=i.k LEFT JOIN sl ON sl.k=i.k LEFT JOIN ev ON ev.k=i.k
    ORDER BY revenue DESC, spend DESC`;
  const { rows } = await q(sql);
  return rows;
}

const brl = (n) => "R$ " + Number(n || 0).toFixed(2).replace(".", ",");
const td = (v, cls = "") => `<td class="${cls}">${v}</td>`;
const esc = (s) => String(s || "").replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));

export function renderHtml(rows, st = {}) {
  const key = st.key || "";
  const qs = (extra) => "?key=" + encodeURIComponent(key) + extra;
  const T = { spend: 0, sales: 0, revenue: 0, pv: 0, vc: 0, ic: 0 };
  const body = rows.map((r) => {
    T.spend += +r.spend; T.sales += +r.sales; T.revenue += +r.revenue;
    T.pv += +r.pv; T.vc += +r.vc; T.ic += +r.ic;
    const roas = r.spend > 0 ? r.revenue / r.spend : 0;
    const profit = r.revenue - r.spend;
    const cpa = r.sales > 0 ? r.spend / r.sales : null;
    const rc = roas >= 2 ? "good" : roas >= 1 ? "mid" : r.spend > 0 ? "bad" : "";
    const sub = st.group === "campaign" ? "" : `<br><span class="dim">${esc(r.campaign_name)}</span>`;
    return `<tr><td><b>${esc(r.name || r.id || "?")}</b>${sub}</td>
      ${td(brl(r.spend), "num")}${td(r.sales, "num")}${td(brl(r.revenue), "num")}
      ${td(roas ? roas.toFixed(2) + "x" : "—", "num " + rc)}
      ${td(brl(profit), "num " + (profit >= 0 ? "good" : "bad"))}
      ${td(cpa != null ? brl(cpa) : "—", "num")}
      ${td(r.pv, "num dim")}${td(r.vc, "num dim")}${td(r.ic, "num dim")}</tr>`;
  }).join("");
  const tRoas = T.spend > 0 ? (T.revenue / T.spend).toFixed(2) + "x" : "—";
  const tProfit = T.revenue - T.spend;

  const presets = [["today","Hoje"],["yesterday","Ontem"],["7d","7 dias"],["30d","30 dias"],["month","Este mês"],["max","Máximo"]];
  const presetBtns = presets.map(([p, l]) =>
    `<a class="chip ${st.preset === p ? "on" : ""}" href="${qs(`&preset=${p}&group=${st.group}&status=${st.status}`)}">${l}</a>`
  ).join("");
  const opt = (v, l, cur) => `<option value="${v}" ${cur === v ? "selected" : ""}>${l}</option>`;

  return `<!doctype html><html lang="pt-br"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>track-helmer · dashboard</title>
<style>
 :root{--bg:#0c0913;--card:#161020;--ink:#ece9f3;--dim:#8b85a0;--good:#46d39a;--mid:#e6b450;--bad:#ef6b6b;--line:#241b33;--accent:#6d28d9}
 *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
 header{padding:18px 28px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px}
 h1{font-size:17px;margin:0}.sub{color:var(--dim);font-size:12px}
 .bar{display:flex;gap:10px;flex-wrap:wrap;align-items:center;padding:14px 28px;border-bottom:1px solid var(--line)}
 .chip{color:var(--dim);text-decoration:none;padding:6px 12px;border:1px solid var(--line);border-radius:20px;font-size:12.5px}
 .chip.on{background:var(--accent);color:#fff;border-color:var(--accent)}
 .bar input,.bar select{background:var(--card);color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:7px 10px;font-size:13px}
 .bar label{color:var(--dim);font-size:12px;display:flex;gap:6px;align-items:center}
 .btn{background:var(--accent);color:#fff;border:none;text-decoration:none;padding:8px 14px;border-radius:9px;font-size:13px;cursor:pointer}
 .kpis{display:flex;gap:10px;flex-wrap:wrap;padding:18px 28px}
 .kpi{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 16px;min-width:120px}
 .kpi .v{font-size:20px;font-weight:700}.kpi .l{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.06em}
 .wrap{padding:0 28px 40px}table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
 th,td{padding:11px 14px;text-align:left;border-bottom:1px solid var(--line)}th{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.06em}
 td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}.dim{color:var(--dim)}
 .good{color:var(--good)}.mid{color:var(--mid)}.bad{color:var(--bad)}
 tfoot td{font-weight:700;background:#1d1530}
</style></head><body>
<header>
  <div><h1>📊 track-helmer</h1><div class="sub">ROAS real · gasto (Meta) × vendas (Greenn) × funil (pixel)</div></div>
  <a class="btn" href="/admin/sync${qs(`&preset=${st.preset || "30d"}&group=${st.group}&status=${st.status}`)}">↻ Sincronizar gasto</a>
</header>
<form class="bar" method="get" action="/dashboard">
  <input type="hidden" name="key" value="${esc(key)}">
  ${presetBtns}
  <label>De <input type="date" name="since" value="${st.since || ""}"></label>
  <label>Até <input type="date" name="until" value="${st.until || ""}"></label>
  <label>Ver <select name="group">${opt("ad","Anúncio",st.group)}${opt("adset","Conjunto",st.group)}${opt("campaign","Campanha",st.group)}</select></label>
  <label>Status <select name="status">${opt("paid","Pagas",st.status)}${opt("all","Todas",st.status)}${opt("pending","Pendentes",st.status)}${opt("refunded","Reembolsadas",st.status)}</select></label>
  <button class="btn" type="submit">Filtrar</button>
  <input type="search" id="q" placeholder="🔍 Buscar nome..." oninput="flt(this.value)">
</form>
<div class="kpis">
  <div class="kpi"><div class="v">${brl(T.spend)}</div><div class="l">Gasto</div></div>
  <div class="kpi"><div class="v">${T.sales}</div><div class="l">Vendas</div></div>
  <div class="kpi"><div class="v">${brl(T.revenue)}</div><div class="l">Receita</div></div>
  <div class="kpi"><div class="v ${tProfit>=0?'good':'bad'}">${brl(tProfit)}</div><div class="l">Lucro</div></div>
  <div class="kpi"><div class="v">${tRoas}</div><div class="l">ROAS</div></div>
  <div class="kpi"><div class="v dim">${T.pv} / ${T.vc} / ${T.ic}</div><div class="l">PV / VC / IC</div></div>
</div>
<div class="wrap"><table>
 <thead><tr><th>${st.group === "campaign" ? "Campanha" : st.group === "adset" ? "Conjunto" : "Anúncio"}</th><th class="num">Gasto</th><th class="num">Vendas</th><th class="num">Receita</th><th class="num">ROAS</th><th class="num">Lucro</th><th class="num">CPA</th><th class="num">PV</th><th class="num">VC</th><th class="num">IC</th></tr></thead>
 <tbody>${body || '<tr><td colspan="10" class="dim">Sem dados no período/filtro selecionado.</td></tr>'}</tbody>
 <tfoot><tr><td>TOTAL</td><td class="num">${brl(T.spend)}</td><td class="num">${T.sales}</td><td class="num">${brl(T.revenue)}</td><td class="num">${tRoas}</td><td class="num ${tProfit>=0?'good':'bad'}">${brl(tProfit)}</td><td></td><td class="num dim">${T.pv}</td><td class="num dim">${T.vc}</td><td class="num dim">${T.ic}</td></tr></tfoot>
</table></div>
<script>
 function flt(v){v=v.toLowerCase();document.querySelectorAll('tbody tr').forEach(function(tr){tr.style.display=tr.textContent.toLowerCase().includes(v)?'':'none';});}
</script>
</body></html>`;
}
