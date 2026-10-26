// Cloudbeds rate + availability proxy for the booking widget calendar.
//
// GET /api/rates?start=YYYY-MM-DD&end=YYYY-MM-DD&roomId=<optional accommodation_types value>
//
// Returns: { start, end, roomId, days: { "YYYY-MM-DD": { rate: number|null, available: boolean } } }
//
// - roomId omitted/empty -> property-wide: rate = cheapest available room type
//   that day, available = true if ANY room type has inventory that day. 
// - roomId given -> scoped to that one room type only (same accommodation_types
//   value the widget already sends to Cloudbeds' reservation form).
//
// Requires env vars (set in Vercel -> Project -> Settings -> Environment Variables):
//   CLOUDBEDS_API_KEY     - self-service API key (Account > Apps & Marketplace >
//                            API Credentials on your Cloudbeds account)
//   CLOUDBEDS_PROPERTY_ID - this property's Cloudbeds property ID
//
// Until both are set, every request returns 503 { code: "NOT_CONFIGURED" } so the
// widget can fall back to plain date selection instead of breaking — UNLESS the
// request explicitly adds &mock=1, which returns deterministic fake rate/
// availability data instead of the 503. This is opt-in and requires an explicit
// query param specifically so a real site visitor's normal request can never
// trigger it by accident — only code that deliberately asks for it (the local
// prototype's widget does this automatically on localhost; nothing else should).
//
// Caching: in-memory per warm serverless instance, 20 minutes per (roomId, month).
// One visitor "warms" a month for everyone after them. Fine at this property's
// traffic; if that ever changes, swap the Map below for Vercel KV or Upstash
// without touching anything else in this file.

const CLOUDBEDS_BASE = "https://api.cloudbeds.com/api/v1.3/getRatePlans";
const CLOUDBEDS_ROOM_TYPES_BASE = "https://api.cloudbeds.com/api/v1.3/getRoomTypes";
const CACHE_TTL_MS = 20 * 60 * 1000;
// Room photos change far less often than rates/availability, so this gets
// its own long-TTL cache rather than riding the 20-minute one above.
const ROOM_TYPES_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const cache = new Map();
var roomTypesCache = null; // { expires, byId: Map<roomTypeID, {name, thumbnailUrl}> }

function cacheKey(start, end, roomId) {
  return start + "|" + end + "|" + (roomId || "all");
}

// Fetches Cloudbeds' own room-type list (name + photos) once per TTL window
// and indexes it by roomTypeID — the same ID the widget already sends as
// roomId, so the booking panel's room chip can show a thumbnail without a
// separate Webflow CMS lookup. Fails silently (returns null) on any error:
// a missing thumbnail degrades gracefully, it shouldn't break rates.
async function fetchRoomTypesMap() {
  if (roomTypesCache && roomTypesCache.expires > Date.now()) {
    return roomTypesCache.byId;
  }

  var apiKey = process.env.CLOUDBEDS_API_KEY;
  var propertyId = process.env.CLOUDBEDS_PROPERTY_ID;
  if (!apiKey || !propertyId) return null;

  try {
    var params = new URLSearchParams({ propertyIDs: propertyId });
    var response = await fetch(CLOUDBEDS_ROOM_TYPES_BASE + "?" + params.toString(), {
      headers: { Authorization: "Bearer " + apiKey, Accept: "application/json" }
    });
    var body = await response.json();
    if (!response.ok || body.success === false) return null;

    var byId = new Map();
    (body.data || []).forEach(function (roomType) {
      var photos = roomType.roomTypePhotos || [];
      byId.set(roomType.roomTypeID, {
        name: roomType.roomTypeName || null,
        thumbnailUrl: photos[0] || null
      });
    });

    roomTypesCache = { expires: Date.now() + ROOM_TYPES_CACHE_TTL_MS, byId: byId };
    return byId;
  } catch (e) {
    return null;
  }
}

// A day only counts as bookable if it has inventory AND isn't blocked/CTA'd —
// matches what a guest could actually select as a check-in date, not just
// what's numerically "in stock."
function isDayUsable(entry) {
  return entry.roomsAvailable > 0 && !entry.blocked && !entry.closedToArrival;
}

// Cloudbeds' getRatePlans treats endDate as exclusive — a request for
// start=2027-01-01&end=2027-01-31 comes back with data through 2027-01-30
// only, silently dropping the actual last day of whatever range is asked
// for (confirmed by querying this endpoint directly: every month's own
// final day was missing, including ones with no month-boundary/mock
// involvement at all). Asking Cloudbeds for one extra day past `end`
// compensates for that; shapeDays() below still only gets used for dates
// this function's caller cares about, so the harmless extra day is simply
// never looked up.
function addDaysISO(isoDate, days) {
  const d = new Date(isoDate + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function fetchCloudbedsRatePlans(start, end, roomId) {
  const apiKey = process.env.CLOUDBEDS_API_KEY;
  const propertyId = process.env.CLOUDBEDS_PROPERTY_ID;

  if (!apiKey || !propertyId) {
    const err = new Error("Cloudbeds credentials are not configured yet");
    err.code = "NOT_CONFIGURED";
    throw err;
  }

  const params = new URLSearchParams({
    propertyIDs: propertyId,
    startDate: start,
    endDate: addDaysISO(end, 1),
    detailedRates: "true"
  });
  if (roomId) params.set("roomTypeID", roomId);

  // NOTE: auth header confirmed against Cloudbeds' docs as Bearer-token style
  // self-service API key auth. Verify this against a real request once the key
  // exists — if Cloudbeds expects a different header name, this is the one line
  // to change.
  const response = await fetch(CLOUDBEDS_BASE + "?" + params.toString(), {
    headers: {
      Authorization: "Bearer " + apiKey,
      Accept: "application/json"
    }
  });

  const body = await response.json();
  if (!response.ok || body.success === false) {
    const err = new Error(body.message || ("Cloudbeds API error (" + response.status + ")"));
    err.code = "UPSTREAM_ERROR";
    throw err;
  }
  return body.data || [];
}

// Deterministic fake data for building/testing the widget before real
// credentials exist. Same (start, roomId) always produces the same numbers,
// so the UI doesn't flicker between reloads during development.
//
// The two rooms on this demo property, used only to build the "general"
// (no roomId) mock response as a real union of both rooms — see
// mockGeneralDays. Matches the actual room pages' data-room-id values.
var MOCK_ROOM_IDS = ["118854202368251", "118857280032901"];

// Each room's own sold-out pattern is independently hash-derived (below),
// so two rooms' sold-out days won't reliably coincide within any given
// month — which means the general view's "every room is booked" case
// might never actually show up in a demo. Forcing the 15th of every month
// sold out for BOTH rooms guarantees at least one such day always exists,
// without needing to touch the per-room pattern logic at all.
var FORCED_SOLDOUT_DAY_OF_MONTH = 15;

function hashString(str) {
  var hash = 0;
  for (var i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return hash;
}

// One room's fake rates/availability. Base rate AND sold-out pattern both
// derive from the room's own id, so two different rooms never coincidentally
// look identical — each gets its own rhythm of sold-out days, not just a
// different price.
function mockRoomDays(start, end, roomId) {
  var hash = hashString(roomId);
  var baseRate = 180 + (hash % 150);
  var soldOutOffset = hash % 11;
  var soldOutPeriod = 9 + (hash % 5); // 9–13 days between sellouts, varies per room

  var days = {};
  var cursor = new Date(start + "T00:00:00Z");
  var endDate = new Date(end + "T00:00:00Z");
  var i = 0;

  while (cursor <= endDate) {
    var iso = cursor.toISOString().slice(0, 10);
    var weekday = cursor.getUTCDay();
    var isWeekend = weekday === 5 || weekday === 6;
    var soldOut = (i + soldOutOffset) % soldOutPeriod === 0
      || cursor.getUTCDate() === FORCED_SOLDOUT_DAY_OF_MONTH;

    days[iso] = soldOut
      ? { rate: null, available: false }
      : { rate: baseRate + (isWeekend ? 60 : 0) + ((i * 37) % 50), available: true };

    cursor.setUTCDate(cursor.getUTCDate() + 1);
    i++;
  }

  return days;
}

// The property-wide view a day is only "sold out" here if EVERY known room
// is sold out that day — same rule shapeDays() applies to real Cloudbeds
// data (available if ANY room type has inventory), so mock and real behave
// identically once credentials are live. Rate shown is the cheapest of
// whichever room(s) are actually available.
function mockGeneralDays(start, end) {
  var perRoom = MOCK_ROOM_IDS.map(function (id) { return mockRoomDays(start, end, id); });
  var days = {};

  Object.keys(perRoom[0]).forEach(function (iso) {
    var best = null;
    var available = false;
    perRoom.forEach(function (roomDays) {
      var info = roomDays[iso];
      if (info && info.available) {
        available = true;
        if (best === null || info.rate < best) best = info.rate;
      }
    });
    days[iso] = { rate: available ? best : null, available: available };
  });

  return days;
}

function mockDays(start, end, roomId) {
  return roomId ? mockRoomDays(start, end, roomId) : mockGeneralDays(start, end);
}

// Collapses Cloudbeds' per-rate-plan response into one entry per date: the
// cheapest usable rate that day, and whether anything was bookable at all.
function shapeDays(ratePlans) {
  var days = {};

  ratePlans.forEach(function (plan) {
    (plan.roomRateDetailed || []).forEach(function (entry) {
      var date = entry.date;
      if (!days[date]) days[date] = { rate: null, available: false };

      if (isDayUsable(entry)) {
        days[date].available = true;
        if (days[date].rate === null || entry.totalRate < days[date].rate) {
          days[date].rate = entry.totalRate;
        }
      }
    });
  });

  return days;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  var start = req.query.start;
  var end = req.query.end;
  var roomId = req.query.roomId;
  var mock = req.query.mock === "1";

  if (!start || !end || !DATE_RE.test(start) || !DATE_RE.test(end)) {
    res.status(400).json({ error: "start and end are required, as YYYY-MM-DD" });
    return;
  }

  if (mock) {
    // Deliberately not cached: it's already instant, and caching it
    // separately would just be one more code path to keep in sync with
    // the real one for no benefit.
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      start: start,
      end: end,
      roomId: roomId || null,
      mock: true,
      days: mockDays(start, end, roomId || null)
    });
    return;
  }

  var key = cacheKey(start, end, roomId);
  var cached = cache.get(key);
  if (cached && cached.expires > Date.now()) {
    res.setHeader("Cache-Control", "public, max-age=60");
    res.status(200).json(cached.data);
    return;
  }

  try {
    var ratePlans = await fetchCloudbedsRatePlans(start, end, roomId || null);
    var days = shapeDays(ratePlans);
    var payload = { start: start, end: end, roomId: roomId || null, days: days };

    // Pulled in the same call the widget already uses to check availability,
    // rather than a separate request — only when scoped to one room, since
    // the general "all rooms" view has no single thumbnail to show.
    if (roomId) {
      var roomTypes = await fetchRoomTypesMap();
      var roomInfo = roomTypes && roomTypes.get(roomId);
      if (roomInfo) {
        payload.roomName = roomInfo.name;
        payload.thumbnailUrl = roomInfo.thumbnailUrl;
      }
    }

    cache.set(key, { expires: Date.now() + CACHE_TTL_MS, data: payload });

    res.setHeader("Cache-Control", "public, max-age=60");
    res.status(200).json(payload);
  } catch (err) {
    if (err.code === "NOT_CONFIGURED") {
      res.status(503).json({ error: err.message, code: err.code });
      return;
    }
    console.error("Cloudbeds proxy error:", err);
    res.status(502).json({ error: "Failed to fetch rates from Cloudbeds", code: err.code || "UNKNOWN" });
  }
}
