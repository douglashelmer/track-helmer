import Fastify from "fastify";
import cors from "@fastify/cors";
import fstatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import crypto from "node:crypto";
import { q, pool } from "./db.js";
import { sendEvents, capiEnabled } from "./capi.js";
import { syncSpend } from "./spend.js";
import { getRows, getData, renderHtml, presetRange } from "./dashboard.js";

const sha = (v) =>
  v == null || v === ""
    ? null
    : crypto.createHash("sha256").update(String(v).trim().toLowerCase()).digest("hex");

const __dirname = dirname(fileURLToPath(import.meta.url));

try {
  await pool.query(readFileSync(join(__dirname, "..", "schema.sql"), "utf8"));
  console.log("✓ schema ok");
} catch (e) {
  console.error("migration failed:", e.message);
}
const app = Fastify({ logger: true, trustProxy: true });
await app.register(cors, { origin: true });
await app.register(fstatic, { root: join(__dirname, "..", "public"), prefix: "/" });

const lastId = (v) => (v && v.includes("|") ? v.split("|").pop().trim() : null);
const clientIp = (req) =>
  (req.headers["cf-connecting-ip"] ||
    req.headers["x-forwarded-for"]?.split(",")[0] ||
    req.ip ||
    "").trim();

app.get("/health", async () => ({ ok: true, capi: capiEnabled }));

app.post("/collect", async (req, reply) => {
  const b = req.body || {};
  const ip = clientIp(req);
  const ua = req.headers["user-agent"] || "";
  const row = {
    event_id: b.event_id,
    event_name: b.event_name,
    event_time: b.event_time ? new Date(b.event_time) : new Date(),
    visitor_id: b.visitor_id || null,
    session_id: b.session_id || null,
    fbp: b.fbp || null,
    fbc: b.fbc || null,
    fbclid: b.fbclid || null,
    utm_source: b.utm_source || null,
    utm_medium: b.utm_medium || null,
    utm_campaign: b.utm_campaign || null,
    utm_content: b.utm_content || null,
    utm_term: b.utm_term || null,
    xcod: b.xcod || null,
    campaign_id: lastId(b.utm_campaign),
    adset_id: lastId(b.utm_medium),
    ad_id: lastId(b.utm_content),
    page_url: b.page_url || null,
    referrer: b.referrer || null,
    ip,
    user_agent: ua,
    country: b.country || "br",
    city: b.city || null,
    state: b.state || null,
    value: b.value ?? null,
    currency: b.currency || "BRL",
    content_ids: b.content_ids ? JSON.stringify(b.content_ids) : null,
  };
  if (!row.event_id || !row.event_name) return reply.code(400).send({ error: "event_id+event_name required" });

  await q(
    `INSERT INTO events (event_id,event_name,event_time,visitor_id,session_id,fbp,fbc,fbclid,
       utm_source,utm_medium,utm_campaign,utm_content,utm_term,xcod,campaign_id,adset_id,ad_id,
       page_url,referrer,ip,user_agent,country,city,state,value,currency,content_ids,raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
     ON CONFLICT (event_id,event_name) DO NOTHING`,
    [row.event_id,row.event_name,row.event_time,row.visitor_id,row.session_id,row.fbp,row.fbc,row.fbclid,
     row.utm_source,row.utm_medium,row.utm_campaign,row.utm_content,row.utm_term,row.xcod,row.campaign_id,row.adset_id,row.ad_id,
     row.page_url,row.referrer,row.ip,row.user_agent,row.country,row.city,row.state,row.value,row.currency,row.content_ids,
     JSON.stringify(b)]
  );

  const r = await sendEvents([{ ...row, content_ids: b.content_ids }]).catch((e) => ({ ok: false, body: String(e) }));
  if (!r.skipped) {
    await q(`UPDATE events SET capi_sent=$1,capi_status=$2,capi_response=$3 WHERE event_id=$4 AND event_name=$5`,
      [!!r.ok, r.status || null, JSON.stringify(r.body || {}), row.event_id, row.event_name]);
  }
  return { ok: true, capi: r.skipped ? "disabled" : r.ok };
});

// ---- Greenn sale webhook → sales row + Purchase CAPI (dedup event_id) ---------
const parseId = (v) => {
  if (!v) return null;
  const after = v.includes("|") ? v.split("|").pop() : v;
  return (after.split("::")[0] || "").trim() || null;
};
const mapStatus = (s) => {
  s = (s || "").toLowerCase();
  if (s === "paid") return "paid";
  if (s.includes("refund")) return "refunded";
  if (s.includes("charge")) return "chargeback";
  if (s.includes("wait") || s === "pending" || s === "unpaid") return "pending";
  return s || "unknown";
};

app.post("/webhook/greenn", async (req, reply) => {
  const secret = process.env.GREENN_WEBHOOK_TOKEN;
  if (secret && req.headers["x-webhook-token"] !== secret) return reply.code(401).send({ error: "bad token" });

  let p = req.body;
  if (Array.isArray(p)) p = p[0];
  if (p && p.body) p = p.body;
  if (!p || !p.sale) return reply.code(400).send({ error: "no sale in payload" });

  const sale = p.sale;
  const client = p.client || {};
  const metas = Object.fromEntries((p.saleMetas || []).map((m) => [m.meta_key, m.meta_value]));
  const status = mapStatus(p.currentStatus || sale.status);
  const orderId = String(sale.id);
  const eventId = "greenn-" + orderId;
  const fbclid = metas.fbclid || null;

  let m = {};
  if (fbclid) {
    const r = await q(
      `SELECT visitor_id, fbp, fbc, ip, user_agent FROM events WHERE fbclid=$1 ORDER BY event_time DESC LIMIT 1`,
      [fbclid]
    );
    m = r.rows[0] || {};
  }
  const fbc =
    m.fbc ||
    (fbclid ? `fb.1.${Math.floor(new Date(sale.created_at || Date.now()).getTime() / 1000)}.${fbclid}` : null);

  const value = sale.amount ?? sale.total ?? null;
  const currency = p.currency || "BRL";
  const adId = parseId(metas.utm_content);

  await q(
    `INSERT INTO sales (order_id,status,value,currency,product,payment_method,email_hash,phone_hash,city,state,zip,country,
       utm_source,utm_medium,utm_campaign,utm_content,utm_term,xcod,campaign_id,adset_id,ad_id,visitor_id,event_id,fbp,fbc,paid_at,fee,net_value,raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)
     ON CONFLICT (order_id) DO UPDATE SET status=EXCLUDED.status, value=EXCLUDED.value, paid_at=EXCLUDED.paid_at,
       fee=EXCLUDED.fee, net_value=EXCLUDED.net_value, raw=EXCLUDED.raw`,
    [orderId, status, value, currency, p.product?.name || null, sale.method || null,
     sha(client.email), sha(client.cellphone ? String(client.cellphone).replace(/\D/g, "") : null),
     client.city || null, client.uf || null, client.zipcode || null, "br",
     metas.utm_source || null, metas.utm_medium || null, metas.utm_campaign || null, metas.utm_content || null,
     metas.utm_term || null, metas.xcod || null,
     parseId(metas.utm_campaign), parseId(metas.utm_medium), adId, m.visitor_id || null, eventId,
     m.fbp || null, fbc, sale.paid_at || null, sale.fee ?? null, sale.seller_balance ?? null, JSON.stringify(p)]
  );

  let capi = { skipped: true };
  if (status === "paid") {
    capi = await sendEvents([{
      event_name: "Purchase",
      event_time: sale.paid_at || Date.now(),
      event_id: eventId,
      page_url: "https://nexia.helmer.com.br/",
      value, currency, content_type: "product",
      content_ids: [String(p.product?.id || "nexia")],
      order_id: orderId,
      email: client.email, phone: client.cellphone,
      city: client.city, state: client.uf, zip: client.zipcode, country: "br",
      visitor_id: m.visitor_id, fbp: m.fbp, fbc, ip: m.ip, user_agent: m.user_agent,
    }]).catch((e) => ({ ok: false, body: String(e) }));
    if (!capi.skipped) await q(`UPDATE sales SET capi_sent=$1 WHERE order_id=$2`, [!!capi.ok, orderId]);
  }

  return { ok: true, order_id: orderId, status, ad_id: adId, matched_session: !!m.visitor_id, capi: capi.skipped ? "disabled" : capi.ok };
});

// ---- Dashboard + spend sync (key-protected) ----------------------------------
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const authed = (req) => !ADMIN_KEY || req.query.key === ADMIN_KEY;

app.get("/dashboard", async (req, reply) => {
  if (!authed(req)) return reply.code(401).send("unauthorized");
  const qy = req.query;
  let since = qy.since, until = qy.until, preset = qy.preset;
  if (!preset && !since && !until) preset = "30d";
  if (preset) { const r = presetRange(preset); if (r) { since = r.since; until = r.until; } }
  const group = ["ad", "adset", "campaign"].includes(qy.group) ? qy.group : "ad";
  const status = ["paid", "all", "pending", "refunded", "chargeback"].includes(qy.status) ? qy.status : "paid";
  const [rows, data] = await Promise.all([getRows({ since, until, group, status }), getData({ since, until })]);
  return reply.type("text/html").send(renderHtml(rows, data, { key: qy.key, since, until, preset: preset || "", group, status }));
});

app.get("/admin/sync", async (req, reply) => {
  if (!authed(req)) return reply.code(401).send("unauthorized");
  const preset = req.query.preset || "30d";
  const meta = (presetRange(preset) || {}).meta || "last_30d";
  const r = await syncSpend(meta);
  req.log.info({ syncSpend: r }, "spend synced");
  const g = req.query.group || "ad", s = req.query.status || "paid";
  return reply.redirect(`/dashboard?key=${encodeURIComponent(req.query.key || "")}&preset=${preset}&group=${g}&status=${s}`);
});

setInterval(() => { syncSpend().catch(() => {}); }, 6 * 3600 * 1000);

const port = Number(process.env.PORT || 8080);
app.listen({ port, host: "0.0.0.0" }).then(() => console.log("track-helmer on :" + port));
