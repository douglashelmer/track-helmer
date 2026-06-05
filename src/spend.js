// Pulls per-ad daily spend from the Meta Marketing API into ad_spend.
import { q } from "./db.js";

const V = "v25.0";
const TOKEN = process.env.META_CAPI_TOKEN; // CLAUDAO token also has ads_read
const ACCT = process.env.FB_AD_ACCOUNT_ID;

export async function syncSpend(datePreset = "last_30d") {
  if (!TOKEN || !ACCT) return { ok: false, reason: "missing META_CAPI_TOKEN/FB_AD_ACCOUNT_ID" };
  const url = new URL(`https://graph.facebook.com/${V}/${ACCT}/insights`);
  url.searchParams.set("level", "ad");
  url.searchParams.set(
    "fields",
    "ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,spend,impressions,clicks"
  );
  url.searchParams.set("time_increment", "1");
  url.searchParams.set("date_preset", datePreset);
  url.searchParams.set("limit", "500");
  url.searchParams.set("access_token", TOKEN);

  let next = url.toString();
  let rows = 0;
  while (next) {
    const res = await fetch(next);
    const j = await res.json();
    if (j.error) return { ok: false, error: j.error.message };
    for (const r of j.data || []) {
      await q(
        `INSERT INTO ad_spend (date,ad_id,adset_id,campaign_id,ad_name,adset_name,campaign_name,spend,impressions,clicks,pulled_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
         ON CONFLICT (date,ad_id) DO UPDATE SET
           spend=EXCLUDED.spend, impressions=EXCLUDED.impressions, clicks=EXCLUDED.clicks,
           ad_name=EXCLUDED.ad_name, adset_name=EXCLUDED.adset_name, campaign_name=EXCLUDED.campaign_name, pulled_at=now()`,
        [r.date_start, r.ad_id, r.adset_id, r.campaign_id, r.ad_name, r.adset_name, r.campaign_name,
         r.spend || 0, r.impressions || 0, r.clicks || 0]
      );
      rows++;
    }
    next = j.paging?.next || null;
  }
  return { ok: true, rows };
}
