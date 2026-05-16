// Shared geocoder for UK locations. Used by the Meta lead webhook
// (auto-geocode on insert) and the manual backfill endpoint.
//
// Three tiers, tried in order, short-circuit on success:
//   1. Full UK postcode via postcodes.io /postcodes/{postcode}
//   2. Outward-code only via postcodes.io /outcodes/{outcode}        (e.g. "EC2A")
//   3. Free-text area name via Nominatim /search                      (e.g. "Canary Wharf")
//
// Returns one of:
//   { status: 'success', postcode|area, lat, lng, geocoded_at }
//   { status: 'failed', postcode|area }     - normalised but not resolvable
//   { status: 'no_postcode' }                - input empty / unparseable
//   { status: 'pending', error }             - transient (timeout, 5xx) — caller should not block

const POSTCODES_IO = 'https://api.postcodes.io';
const NOMINATIM_BASE = process.env.NOMINATIM_BASE_URL || 'https://nominatim.openstreetmap.org';
const NOMINATIM_UA = 'starbot-crm/1.0 (+https://partner.starbot.co.uk; ops@starbot.co.uk)';
const TIMEOUT_MS = 4000;

// Suburb-ish addresstype values Nominatim returns that we treat as
// "real place" results. Anything else (building, club, road, etc.) is
// noise — we'd rather drop the lead to Needs Location than pin it on a
// random gym whose name happened to match.
const PLACE_ADDRESS_TYPES = new Set([
  'city', 'town', 'village', 'suburb', 'neighbourhood', 'neighborhood',
  'hamlet', 'borough', 'locality', 'county', 'state_district', 'district',
  'region', 'postcode', 'administrative',
]);

// Normalise UK postcode: trim, uppercase, strip internal whitespace.
// Returns null if input is blank / clearly not a postcode.
export function normalisePostcode(raw) {
  if (raw == null) return null;
  const stripped = String(raw).replace(/\s+/g, '').toUpperCase();
  if (!stripped) return null;
  // Full postcodes are 5-7 alphanumerics (e.g. M11AE, EC2A4DP, SW1A1AA).
  // We let postcodes.io be the final arbiter — this filter just rejects
  // obvious non-postcodes so we don't burn a network call on them.
  if (!/^[A-Z0-9]{5,8}$/.test(stripped)) return null;
  return stripped;
}

// Extract a UK outward code (1-2 letters, digit, optional letter/digit).
// Examples that match: M, B, L1, M1, EC, SW1, EC2A, SW1A.
// We only accept the bare outcode here — full postcodes go via tier 1.
export function normaliseOutcode(raw) {
  if (raw == null) return null;
  const stripped = String(raw).replace(/\s+/g, '').toUpperCase();
  if (!stripped) return null;
  // 2-4 alphanumerics matching the UK outward-code shape. Refuses
  // strings of 5+ chars (those are caught by tier 1) and refuses single
  // letters (too ambiguous to be a useful centroid).
  if (!/^[A-Z]{1,2}[0-9][A-Z0-9]?$/.test(stripped)) return null;
  return stripped;
}

// Looks like a free-text place name (not garbage). Requires 3+ chars and
// at least one letter; rejects single letters and pure-symbol input.
export function isLikelyAreaName(raw) {
  if (raw == null) return false;
  const s = String(raw).trim();
  if (s.length < 3) return false;
  if (!/[A-Za-z]/.test(s)) return false;
  return true;
}

export async function geocodePostcode(rawInput) {
  if (rawInput == null) return { status: 'no_postcode' };
  const trimmed = String(rawInput).trim();
  if (!trimmed) return { status: 'no_postcode' };

  let lastPending = null;

  // Tier 1: full UK postcode (precise)
  const postcode = normalisePostcode(trimmed);
  if (postcode) {
    const r = await fetchPostcode(postcode);
    if (r.status === 'success') return r;
    if (r.status === 'pending') lastPending = r;
  }

  // Tier 2: outward code (e.g. "EC2A", "SW1") → district centroid
  const outcode = normaliseOutcode(trimmed);
  if (outcode) {
    const r = await fetchOutcode(outcode);
    if (r.status === 'success') return r;
    if (r.status === 'pending') lastPending = r;
  }

  // Tier 3: free-text area name (Nominatim) → place centroid
  if (isLikelyAreaName(trimmed)) {
    const r = await fetchPlace(trimmed);
    if (r.status === 'success') return r;
    if (r.status === 'pending') lastPending = r;
  }

  if (lastPending) return lastPending;
  if (postcode || outcode) {
    return { status: 'failed', postcode: postcode || outcode };
  }
  if (isLikelyAreaName(trimmed)) {
    return { status: 'failed', area: trimmed };
  }
  return { status: 'no_postcode' };
}

async function fetchPostcode(postcode) {
  const url = `${POSTCODES_IO}/postcodes/${encodeURIComponent(postcode)}`;
  return fetchWithTimeout(url, {}, (body) => {
    const result = body && body.result;
    if (!result || typeof result.latitude !== 'number' || typeof result.longitude !== 'number') {
      return null;
    }
    return {
      status: 'success',
      postcode: result.postcode || postcode,
      lat: result.latitude,
      lng: result.longitude,
      geocoded_at: new Date().toISOString(),
    };
  }, { failedPayload: { postcode } });
}

async function fetchOutcode(outcode) {
  const url = `${POSTCODES_IO}/outcodes/${encodeURIComponent(outcode)}`;
  return fetchWithTimeout(url, {}, (body) => {
    const result = body && body.result;
    if (!result || typeof result.latitude !== 'number' || typeof result.longitude !== 'number') {
      return null;
    }
    return {
      status: 'success',
      postcode: result.outcode || outcode,
      lat: result.latitude,
      lng: result.longitude,
      geocoded_at: new Date().toISOString(),
    };
  }, { failedPayload: { postcode: outcode } });
}

async function fetchPlace(query) {
  const url =
    `${NOMINATIM_BASE}/search?format=json&limit=1&countrycodes=gb` +
    `&q=${encodeURIComponent(query + ', United Kingdom')}`;
  return fetchWithTimeout(
    url,
    { headers: { 'User-Agent': NOMINATIM_UA, 'Accept-Language': 'en-GB,en' } },
    (body) => {
      if (!Array.isArray(body) || body.length === 0) return null;
      const hit = body[0];
      if (!hit) return null;
      const lat = Number(hit.lat);
      const lng = Number(hit.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      // Reject low-quality matches: only accept hits whose addresstype
      // describes a settlement / district / administrative area. This
      // protects against e.g. "North London" matching a random sports
      // club just because the words appear in the name.
      const at = String(hit.addresstype || '').toLowerCase();
      if (!PLACE_ADDRESS_TYPES.has(at)) return null;
      return {
        status: 'success',
        area: query,
        lat,
        lng,
        geocoded_at: new Date().toISOString(),
      };
    },
    { failedPayload: { area: query } }
  );
}

async function fetchWithTimeout(url, init, onSuccess, { failedPayload } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal });
    clearTimeout(timer);

    if (r.status === 404) {
      return { status: 'failed', ...(failedPayload || {}) };
    }
    if (!r.ok) {
      return { status: 'pending', error: `HTTP ${r.status} from ${hostOf(url)}` };
    }

    let body;
    try {
      body = await r.json();
    } catch {
      return { status: 'pending', error: `malformed JSON from ${hostOf(url)}` };
    }

    const success = onSuccess(body);
    if (success) return success;
    // 200-ish but no usable result — treat as 'failed' (we asked, got nothing).
    return { status: 'failed', ...(failedPayload || {}) };
  } catch (err) {
    clearTimeout(timer);
    return { status: 'pending', error: err && err.message ? err.message : String(err) };
  }
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return 'upstream'; }
}

// Map a geocode result onto the starbot_leads columns. Caller spreads this
// into the row patch / insert. We don't overwrite a successful geocode with
// 'pending' so that transient errors don't clobber existing coordinates.
//
// Both `postcode` (tiers 1-2) and `area` (tier 3) land in venue_postcode so
// the dashboard tooltip / Needs-Location panel has a label to show.
export function geocodeColumns(result, { allowDowngrade = true } = {}) {
  if (!result) return {};
  switch (result.status) {
    case 'success':
      return {
        venue_postcode: result.postcode || result.area || null,
        venue_lat: result.lat,
        venue_lng: result.lng,
        venue_geocoded_at: result.geocoded_at,
        venue_geocode_status: 'success',
      };
    case 'failed':
      return {
        venue_postcode: result.postcode || result.area || null,
        venue_lat: null,
        venue_lng: null,
        venue_geocoded_at: null,
        venue_geocode_status: 'failed',
      };
    case 'no_postcode':
      return {
        venue_geocode_status: 'no_postcode',
      };
    case 'pending':
      // Transient: keep any existing coordinates unless explicitly allowed.
      return allowDowngrade
        ? { venue_geocode_status: 'pending' }
        : {};
    default:
      return {};
  }
}

export const __test__ = {
  normalisePostcode,
  normaliseOutcode,
  isLikelyAreaName,
  PLACE_ADDRESS_TYPES,
};
