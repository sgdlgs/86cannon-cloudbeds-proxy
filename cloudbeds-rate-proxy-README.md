# Cloudbeds rate proxy

Serverless proxy between the booking widget's calendar and Cloudbeds'
`getRatePlans` endpoint. Holds the Cloudbeds API key server-side (it can
never live in the widget's client-side script) and caches responses so the
widget can poll freely without approaching Cloudbeds' rate limit.

## Endpoint

```
GET /api/rates?start=YYYY-MM-DD&end=YYYY-MM-DD&roomId=<optional>
```

- `roomId` omitted → property-wide: the cheapest available room type's rate
  each day, available if ANY room type has inventory.
- `roomId` given → scoped to that one room type (same value already used as
  `data-room-id` / `accommodation_types` on the room pages).

Response:

```json
{
  "start": "2026-11-01",
  "end": "2026-11-30",
  "roomId": null,
  "days": {
    "2026-11-01": { "rate": 229, "available": true },
    "2026-11-02": { "rate": null, "available": false }
  }
}
```

## Setup

In the Vercel project's **Settings → Environment Variables**, set:

| Variable | Value |
|---|---|
| `CLOUDBEDS_API_KEY` | Self-service API key — Cloudbeds account → Account → Apps & Marketplace → API Credentials → generate an API Key with the `read:rate` scope |
| `CLOUDBEDS_PROPERTY_ID` | This property's Cloudbeds property ID (same page) |
| `ALLOWED_ORIGIN` | *(optional)* Lock CORS to your real domain once live, e.g. `https://hotel-booking-demo.webflow.io`. Defaults to `*`, which is fine while testing since this endpoint only ever returns public rate/availability data — nothing sensitive. |

Until the first two are set, every request returns `503` with
`{ "code": "NOT_CONFIGURED" }` — the widget should treat that as "no rate
data available" and fall back to plain date selection, not a hard failure.

## One thing to verify once the real key exists

The auth header is built as `Authorization: Bearer <CLOUDBEDS_API_KEY>`,
based on Cloudbeds' documented self-service API key auth. This is the one
piece I couldn't confirm against a live request — if Cloudbeds expects a
different header, that's the single line to change, in
`fetchCloudbedsRatePlans()` in `api/rates.js`.

## Caching

In-memory per warm serverless instance, 20 minutes per `(roomId, month)`.
One visitor's request warms it for everyone after them until it expires.
Good enough for this property's traffic. If that ever stops being true,
swap the `Map` in `api/rates.js` for Vercel KV or Upstash — nothing else
in the file needs to change.
