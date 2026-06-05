import Fastify from "fastify";
import cors from "@fastify/cors";
import fstatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { q, pool } from "./db.js";
import { sendEvents, capiEnabled } from "./capi.js";

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

app.post("/webhook/greenn", async (req, reply) => {
  req.log.info({ greenn: req.body }, "greenn webhook received");
  return reply.send({ ok: true, note: "stub — mapping in Phase 2" });
});

const port = Number(process.env.PORT || 8080);
app.listen({ port, host: "0.0.0.0" }).then(() => console.log("track-helmer on :" + port));
