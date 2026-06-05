// Meta Conversions API sender (Graph v25.0). Hashes PII (SHA-256), leaves
// fbp/fbc/ip/ua raw, and reuses the browser event_id for deduplication.
import crypto from "node:crypto";

const API_VERSION = "v25.0";
const PIXEL_ID = process.env.META_PIXEL_ID;
const TOKEN = process.env.META_CAPI_TOKEN;
const TEST_CODE = process.env.META_TEST_EVENT_CODE || null;
const ENABLED = process.env.CAPI_ENABLED === "true";

const sha256 = (v) =>
  v == null || v === ""
    ? undefined
    : crypto.createHash("sha256").update(String(v).trim().toLowerCase()).digest("hex");

export function buildEvent(e) {
  const user_data = {
    em: sha256(e.email),
    ph: e.phone ? sha256(String(e.phone).replace(/\D/g, "")) : undefined,
    ct: sha256(e.city),
    st: sha256(e.state),
    zp: sha256(e.zip),
    country: sha256(e.country || "br"),
    external_id: sha256(e.visitor_id),
    fbp: e.fbp || undefined,
    fbc: e.fbc || undefined,
    client_ip_address: e.ip || undefined,
    client_user_agent: e.user_agent || undefined,
  };
  Object.keys(user_data).forEach((k) => user_data[k] === undefined && delete user_data[k]);

  const custom_data = {};
  if (e.value != null) custom_data.value = Number(e.value);
  if (e.currency) custom_data.currency = e.currency;
  if (e.content_ids) custom_data.content_ids = e.content_ids;
  if (e.content_type) custom_data.content_type = e.content_type;
  if (e.order_id) custom_data.order_id = e.order_id;

  return {
    event_name: e.event_name,
    event_time: Math.floor(new Date(e.event_time || Date.now()).getTime() / 1000),
    event_id: e.event_id,
    action_source: "website",
    event_source_url: e.page_url || undefined,
    user_data,
    custom_data,
  };
}

export async function sendEvents(events) {
  if (!ENABLED) return { ok: true, skipped: true, reason: "CAPI_ENABLED=false" };
  if (!PIXEL_ID || !TOKEN) return { ok: false, reason: "missing META_PIXEL_ID/META_CAPI_TOKEN" };

  const body = { data: events.map(buildEvent) };
  if (TEST_CODE) body.test_event_code = TEST_CODE;

  const res = await fetch(
    `https://graph.facebook.com/${API_VERSION}/${PIXEL_ID}/events?access_token=${TOKEN}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok && !json.error, status: res.status, body: json };
}

export const capiEnabled = ENABLED;
