-- track-helmer schema (PostgreSQL)

-- Raw funnel events captured from the first-party pixel (PageView, ViewContent,
-- InitiateCheckout, Purchase). One row per event; event_id is the Meta dedup key.
CREATE TABLE IF NOT EXISTS events (
  id            BIGSERIAL PRIMARY KEY,
  event_id      TEXT NOT NULL,
  event_name    TEXT NOT NULL,
  event_time    TIMESTAMPTZ NOT NULL DEFAULT now(),
  visitor_id    TEXT,
  session_id    TEXT,
  fbp           TEXT,
  fbc           TEXT,
  fbclid        TEXT,
  utm_source    TEXT,
  utm_medium    TEXT,
  utm_campaign  TEXT,
  utm_content   TEXT,
  utm_term      TEXT,
  xcod          TEXT,
  campaign_id   TEXT,
  adset_id      TEXT,
  ad_id         TEXT,
  page_url      TEXT,
  referrer      TEXT,
  ip            TEXT,
  user_agent    TEXT,
  country       TEXT,
  city          TEXT,
  state         TEXT,
  value         NUMERIC(12,2),
  currency      TEXT DEFAULT 'BRL',
  content_ids   JSONB,
  capi_sent     BOOLEAN DEFAULT false,
  capi_status   INT,
  capi_response JSONB,
  raw           JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_events_ad_id    ON events(ad_id);
CREATE INDEX IF NOT EXISTS idx_events_name_time ON events(event_name, event_time);
CREATE INDEX IF NOT EXISTS idx_events_visitor  ON events(visitor_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_events_eventid_name ON events(event_id, event_name);

-- Real sales from the checkout webhook (Greenn). Source of truth for revenue.
CREATE TABLE IF NOT EXISTS sales (
  id            BIGSERIAL PRIMARY KEY,
  order_id      TEXT UNIQUE NOT NULL,
  status        TEXT NOT NULL,
  value         NUMERIC(12,2) NOT NULL,
  currency      TEXT DEFAULT 'BRL',
  product       TEXT,
  payment_method TEXT,
  email_hash    TEXT,
  phone_hash    TEXT,
  city          TEXT,
  state         TEXT,
  zip           TEXT,
  country       TEXT DEFAULT 'br',
  utm_source    TEXT,
  utm_medium    TEXT,
  utm_campaign  TEXT,
  utm_content   TEXT,
  utm_term      TEXT,
  xcod          TEXT,
  campaign_id   TEXT,
  adset_id      TEXT,
  ad_id         TEXT,
  visitor_id    TEXT,
  event_id      TEXT,
  fbp           TEXT,
  fbc           TEXT,
  capi_sent     BOOLEAN DEFAULT false,
  raw           JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_sales_ad_id  ON sales(ad_id);
CREATE INDEX IF NOT EXISTS idx_sales_status ON sales(status);

-- Daily ad spend pulled from the Meta Marketing API, keyed by ad.
CREATE TABLE IF NOT EXISTS ad_spend (
  date          DATE NOT NULL,
  ad_id         TEXT NOT NULL,
  adset_id      TEXT,
  campaign_id   TEXT,
  ad_name       TEXT,
  adset_name    TEXT,
  campaign_name TEXT,
  spend         NUMERIC(12,2) DEFAULT 0,
  impressions   INT DEFAULT 0,
  clicks        INT DEFAULT 0,
  pulled_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (date, ad_id)
);

-- Incremental columns (safe to re-run on an existing DB).
ALTER TABLE sales ADD COLUMN IF NOT EXISTS fee        NUMERIC(12,2);
ALTER TABLE sales ADD COLUMN IF NOT EXISTS net_value  NUMERIC(12,2);
