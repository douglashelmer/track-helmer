import { q } from "./db.js";

// Per-ad join: spend (Meta) × real sales (Greenn) × funnel events (pixel).
export async function getRows() {
  const { rows } = await q(`
    WITH ids AS (
      SELECT ad_id FROM ad_spend WHERE ad_id IS NOT NULL
      UNION SELECT ad_id FROM sales  WHERE ad_id IS NOT NULL
      UNION SELECT ad_id FROM events WHERE ad_id IS NOT NULL
    ),
    sp AS (
      SELECT ad_id, MAX(ad_name) ad_name, MAX(adset_name) adset_name, MAX(campaign_name) campaign_name,
             SUM(spend) spend, SUM(impressions) impressions, SUM(clicks) clicks
      FROM ad_spend GROUP BY ad_id
    ),
    sl AS (
      SELECT ad_id,
        COUNT(*) FILTER (WHERE status='paid') sales,
        COALESCE(SUM(value) FILTER (WHERE status='paid'),0) revenue
      FROM sales WHERE ad_id IS NOT NULL GROUP BY ad_id
    ),
    ev AS (
      SELECT ad_id,
        COUNT(*) FILTER (WHERE event_name='PageView') pv,
        COUNT(*) FILTER (WHERE event_name='ViewContent') vc,
        COUNT(*) FILTER (WHERE event_name='InitiateCheckout') ic
      FROM events WHERE ad_id IS NOT NULL GROUP BY ad_id
    )
    SELECT i.ad_id, sp.ad_name, sp.adset_name, sp.campaign_name,
      COALESCE(sp.spend,0)::float spend, COALESCE(sp.impressions,0) impressions, COALESCE(sp.clicks,0) clicks,
      COALESCE(sl.sales,0) sales, COALESCE(sl.revenue,0)::float revenue,
      COALESCE(ev.pv,0) pv, COALESCE(ev.vc,0) vc, COALESCE(ev.ic,0) ic
    FROM ids i
    LEFT JOIN sp ON sp.ad_id=i.ad_id
    LEFT JOIN sl ON sl.ad_id=i.ad_id
    LEFT JOIN ev ON ev.ad_id=i.ad_id
    ORDER BY revenue DESC, spend DESC
  `);
  return rows;
}

const brl = (n) => "R$ " + Number(n || 0).toFixed(2).replace(".", ",");
const td = (v, cls = "") => `<td class="${cls}">${v}</td>`;

export function renderHtml(rows, key) {
  const T = { spend: 0, sales: 0, revenue: 0, pv: 0, vc: 0, ic: 0 };
  const body = rows
    .map((r) => {
      T.spend += +r.spend; T.sales += +r.sales; T.revenue += +r.revenue;
      T.pv += +r.pv; T.vc += +r.vc; T.ic += +r.ic;
      const roas = r.spend > 0 ? r.revenue / r.spend : 0;
      const profit = r.revenue - r.spend;
      const cpa = r.sales > 0 ? r.spend / r.sales : null;
      const roasCls = roas >= 2 ? "good" : roas >= 1 ? "mid" : r.spend > 0 ? "bad" : "";
      return `<tr>
        ${td(`<b>${r.ad_name || r.ad_id || "?"}</b><br><span class="dim">${r.campaign_name || ""}</span>`)}
        ${td(brl(r.spend), "num")}
        ${td(r.sales, "num")}
        ${td(brl(r.revenue), "num")}
        ${td(roas ? roas.toFixed(2) + "x" : "—", "num " + roasCls)}
        ${td(brl(profit), "num " + (profit >= 0 ? "good" : "bad"))}
        ${td(cpa != null ? brl(cpa) : "—", "num")}
        ${td(r.pv, "num dim")}
        ${td(r.vc, "num dim")}
        ${td(r.ic, "num dim")}
      </tr>`;
    })
    .join("");
  const tRoas = T.spend > 0 ? (T.revenue / T.spend).toFixed(2) + "x" : "—";
  const tProfit = T.revenue - T.spend;

  return `<!doctype html><html lang="pt-br"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>track-helmer · dashboard</title>
<style>
 :root{--bg:#0c0913;--card:#161020;--ink:#ece9f3;--dim:#8b85a0;--good:#46d39a;--mid:#e6b450;--bad:#ef6b6b;--line:#241b33}
 *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
 header{padding:20px 28px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px}
 h1{font-size:17px;margin:0;letter-spacing:.02em}.sub{color:var(--dim);font-size:12px}
 .kpis{display:flex;gap:10px;flex-wrap:wrap;padding:18px 28px}
 .kpi{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 16px;min-width:120px}
 .kpi .v{font-size:20px;font-weight:700}.kpi .l{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.06em}
 .wrap{padding:0 28px 40px}table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
 th,td{padding:11px 14px;text-align:left;border-bottom:1px solid var(--line)}th{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.06em}
 td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}.dim{color:var(--dim)}
 .good{color:var(--good)}.mid{color:var(--mid)}.bad{color:var(--bad)}
 tr:last-child td{border-bottom:none}tfoot td{font-weight:700;background:#1d1530}
 a.btn{background:#6d28d9;color:#fff;text-decoration:none;padding:8px 14px;border-radius:9px;font-size:13px}
</style></head><body>
<header>
  <div><h1>📊 track-helmer</h1><div class="sub">ROAS real por anúncio · gasto (Meta) × vendas (Greenn) × funil (pixel)</div></div>
  <a class="btn" href="/admin/sync?key=${key || ""}">↻ Sincronizar gasto do Meta</a>
</header>
<div class="kpis">
  <div class="kpi"><div class="v">${brl(T.spend)}</div><div class="l">Gasto</div></div>
  <div class="kpi"><div class="v">${T.sales}</div><div class="l">Vendas</div></div>
  <div class="kpi"><div class="v">${brl(T.revenue)}</div><div class="l">Receita</div></div>
  <div class="kpi"><div class="v ${tProfit>=0?'good':'bad'}">${brl(tProfit)}</div><div class="l">Lucro</div></div>
  <div class="kpi"><div class="v">${tRoas}</div><div class="l">ROAS</div></div>
  <div class="kpi"><div class="v dim">${T.pv} / ${T.vc} / ${T.ic}</div><div class="l">PV / VC / IC</div></div>
</div>
<div class="wrap"><table>
 <thead><tr><th>Anúncio</th><th class="num">Gasto</th><th class="num">Vendas</th><th class="num">Receita</th><th class="num">ROAS</th><th class="num">Lucro</th><th class="num">CPA</th><th class="num">PV</th><th class="num">VC</th><th class="num">IC</th></tr></thead>
 <tbody>${body || '<tr><td colspan="10" class="dim">Sem dados ainda — aguardando tráfego e o sync de gasto.</td></tr>'}</tbody>
 <tfoot><tr><td>TOTAL</td><td class="num">${brl(T.spend)}</td><td class="num">${T.sales}</td><td class="num">${brl(T.revenue)}</td><td class="num">${tRoas}</td><td class="num ${tProfit>=0?'good':'bad'}">${brl(tProfit)}</td><td></td><td class="num dim">${T.pv}</td><td class="num dim">${T.vc}</td><td class="num dim">${T.ic}</td></tr></tfoot>
</table></div>
</body></html>`;
}
