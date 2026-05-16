// Shared geocoder for UK postcodes via postcodes.io. Used by the Meta lead
// webhook (auto-geocode on insert) and the manual backfill endpoint.
//
// Returns one of:
//   { status: 'success', postcode, lat, lng, geocoded_at }
//   { status: 'failed', postcode }                        - postcode normalised but not found
//   { status: 'no_postcode' }                             - input was empty / not parseable as a postcode
//   { status: 'pending', error }                          - transient (timeout, 5xx) — caller should not block

const POSTCODES_IO = 'https://api.postcodes.io/postcodes';
const TIMEOUT_MS = 4000;

// Normalise UK postcode: trim, uppercase, strip internal whitespace.
// Postcodes.io accepts unspaced form (SW1A1AA) and spaced form (SW1A 1AA);
// we send unspaced. Returns null if input is blank / clearly not a postcode.
export function normalisePostcode(raw) {
  if (raw == null) return null;
  const stripped = String(raw).replace(/\s+/g, '').toUpperCase();
  if (!stripped) return null;
  // Loose shape filter: UK postcodes are 5-7 alphanumerics. We let postcodes.io
  // be the final arbiter — this filter just rejects obvious garbage so we
  // don't burn a network call on it.
  if (!/^[A-Z0-9]{5,8}$/.test(stripped)) return null;
  return stripped;
}

export async function geocodePostcode(rawPostcode) {
  const postcode = normalisePostcode(rawPostcode);
  if (!postcode) return { status: 'no_postcode' };

  const url = `${POSTCODES_IO}/${encodeURIComponent(postcode)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);

    if (r.status === 404) {
      return { status: 'failed', postcode };
    }
    if (!r.ok) {
      // 5xx or other transient
      return { status: 'pending', error: `postcodes.io HTTP ${r.status}` };
    }

    const body = await r.json();
    const result = body && body.result;
    if (!result || typeof result.latitude !== 'number' || typeof result.longitude !== 'number') {
      return { status: 'pending', error: 'postcodes.io malformed body' };
    }

    return {
      status: 'success',
      postcode,
      lat: result.latitude,
      lng: result.longitude,
      geocoded_at: new Date().toISOString(),
    };
  } catch (err) {
    clearTimeout(timer);
    return { status: 'pending', error: err && err.message ? err.message : String(err) };
  }
}

// Map a geocode result onto the starbot_leads columns. Caller spreads this
// into the row patch / insert. We don't overwrite a successful geocode with
// 'pending' so that transient errors don't clobber existing coordinates.
export function geocodeColumns(result, { allowDowngrade = true } = {}) {
  if (!result) return {};
  switch (result.status) {
    case 'success':
      return {
        venue_postcode: result.postcode,
        venue_lat: result.lat,
        venue_lng: result.lng,
        venue_geocoded_at: result.geocoded_at,
        venue_geocode_status: 'success',
      };
    case 'failed':
      return {
        venue_postcode: result.postcode,
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
