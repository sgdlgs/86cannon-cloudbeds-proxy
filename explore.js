// Temporary read-only explorer for trying out Cloudbeds endpoints beyond
// rates/availability — e.g. getRoomTypes for capacity, getHotelDetails for
// property info — without ever putting the API key in front of the client
// or in chat. It reuses the same CLOUDBEDS_API_KEY / CLOUDBEDS_PROPERTY_ID
// env vars as rates.js.
//
// GET /api/explore?endpoint=getRoomTypes
// GET /api/explore?endpoint=getAvailableRoomTypes&startDate=2026-11-01&endDate=2026-11-02&adults=2
//
// Deliberately whitelisted to safe, non-sensitive metadata endpoints — no
// guest, reservation, payment, or user data goes through this, since unlike
// rates.js this has no caller-facing purpose and shouldn't become a general
// Cloudbeds passthrough. This file is a dev tool, not part of the booking
// widget's runtime — delete it once done exploring.

const CLOUDBEDS_BASE = "https://api.cloudbeds.com/api/v1.3";

const ALLOWED_ENDPOINTS = [
  "getRoomTypes",
  "getAvailableRoomTypes",
  "getHotelDetails",
  "getHotels",
  "getRate",
  "getRatePlans",
  "getTaxesAndFees",
  "getCurrencySettings",
  "getAppPropertySettings"
];

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const endpoint = req.query.endpoint;
  if (!endpoint || !ALLOWED_ENDPOINTS.includes(endpoint)) {
    res.status(400).json({
      error: "Pass a supported ?endpoint=",
      allowed: ALLOWED_ENDPOINTS
    });
    return;
  }

  const apiKey = process.env.CLOUDBEDS_API_KEY;
  const propertyId = process.env.CLOUDBEDS_PROPERTY_ID;
  if (!apiKey || !propertyId) {
    res.status(503).json({ error: "Cloudbeds credentials are not configured" });
    return;
  }

  const params = new URLSearchParams({ propertyIDs: propertyId });
  Object.keys(req.query).forEach((key) => {
    if (key === "endpoint") return;
    params.set(key, req.query[key]);
  });

  try {
    const response = await fetch(CLOUDBEDS_BASE + "/" + endpoint + "?" + params.toString(), {
      headers: { Authorization: "Bearer " + apiKey, Accept: "application/json" }
    });
    const body = await response.json();
    res.status(response.status).json(body);
  } catch (err) {
    res.status(502).json({ error: "Failed to reach Cloudbeds", detail: err.message });
  }
}
