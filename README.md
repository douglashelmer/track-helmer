# track-helmer

Rastreamento first-party + gateway de Conversions API (CAPI) do Meta + dashboard de atribuição (estilo Utmify, self-hosted).

- `public/pixel.js` — pixel first-party (gera `_fbp`, deriva `fbc` do `fbclid`, captura UTMs, dispara PageView + `thelmer.track()`)
- `src/server.js` — Fastify: `/collect`, `/webhook/greenn`, `/health` (auto-migra o schema no boot)
- `src/capi.js` — envio CAPI v25.0 com hash SHA-256 + dedup por `event_id`
- `schema.sql` — tabelas `events`, `sales`, `ad_spend`

Deploy no Easypanel: app (Dockerfile) + Postgres + domínio `track.helmer.com.br`.
