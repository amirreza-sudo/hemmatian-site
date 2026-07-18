// live-comps.js — DXB Property Expert
//
// Live, per-visitor cross-check against Property Finder's public sale-transactions
// pages (DLD-sourced, server-rendered — no login required). Called by the Price
// Checker in index.html on every submission for areas we have a verified URL
// mapping for.
//
// Why only Property Finder and not Bayut too: Bayut's equivalent transactions page
// renders its table client-side via JavaScript, so a lightweight serverless fetch
// only sees an empty shell — there is no real data to parse without running a full
// headless browser per visitor, which is too slow/fragile for a live request path.
// Property Finder's page is server-rendered, so a plain fetch already returns the
// real transaction table. Bayut (and Property Monitor / DXB Interact, which need a
// personal login) are instead refreshed on a periodic Cowork schedule directly into
// index.html's static MKT dataset — see project instructions, "W1: cross-source
// data refresh".
//
// This function fails soft on every error path: any problem (unmapped area, fetch
// timeout, HTTP error, unparsable page) returns { ok:false, reason } with HTTP 200,
// and the frontend falls back to the static MKT/CITY_BENCH figures already baked
// into index.html. Nothing here should ever be able to break the Price Checker.

// Verified area-name -> Property Finder URL slug. Only include areas we have
// actually confirmed return a real transactions page (checked manually before
// adding). Leave an area out of this map rather than guess a slug -- an
// unmapped area just falls back to the static dataset, which is safe.
const AREA_SLUGS = {
  'Business Bay': 'business-bay',
  'Downtown Dubai': 'downtown-dubai',
  'Dubai Marina': 'dubai-marina',
  'Dubai Hills Estate': 'dubai-hills-estate',
  'Palm Jumeirah': 'palm-jumeirah',
  'DAMAC Hills': 'damac-hills',
  'MBR City / Meydan': 'mohammed-bin-rashid-city',
  'JLT': 'jumeirah-lake-towers',
  'DIFC': 'difc',
  'JVT': 'jumeirah-village-triangle'
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json'
};

function jsonResponse(body) {
  return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify(body) };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  const params = event.queryStringParameters || {};
  const area = (params.area || '').trim();
  const slug = AREA_SLUGS[area];

  if (!slug) {
    return jsonResponse({ ok: false, reason: 'unmapped-area', area });
  }

  const url = `https://www.propertyfinder.ae/en/transactions/buy/dubai/${slug}`;

  let html;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; DXBPropertyExpertBot/1.0; +https://dxbpropertyexpert.com)',
        'Accept': 'text/html'
      },
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!res.ok) {
      return jsonResponse({ ok: false, reason: 'http-' + res.status, area });
    }
    html = await res.text();
  } catch (e) {
    return jsonResponse({ ok: false, reason: 'fetch-error', detail: String((e && e.message) || e), area });
  }

  try {
    // 1) Headline area stat -- lives in <meta name="description">, present on every
    //    confirmed area page in a stable, consistent format:
    //    "Understand {Area}'s property scene with average sale price of X AED.
    //     Analyse N sales, with a Y% return on investment"
    let avgSalePriceAED = null, salesAnalyzed = null, roiPct = null;
    const metaMatch = html.match(/average sale price of ([\d,]+)\s*AED\.\s*Analyse (\d+)\s*sales?,?\s*with a ([\d.]+)%\s*return on investment/i);
    if (metaMatch) {
      avgSalePriceAED = parseInt(metaMatch[1].replace(/,/g, ''), 10);
      salesAnalyzed = parseInt(metaMatch[2], 10);
      roiPct = parseFloat(metaMatch[3]);
    }

    // 2) Best-effort per-transaction sample from the visible table, for a real
    //    AED/sqft figure. Strip tags to plain text and scan for the repeating
    //    row shape: price, price-per-sqft, date, status, type, beds, size.
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ');

    const rowRe = /([\d,]{5,12})\s+(\d{2,5}\.\d{1,2})\s+(\d{1,2} [A-Z][a-z]{2} \d{4})\s+(Ready|Off-plan)\s+(Apartment|Villa|Townhouse|Hotel Apartment|Land)\s+(Studio|\d Beds?)\s+(\d{2,6}\.\d{1,2})/g;
    let m, comps = [];
    while ((m = rowRe.exec(text)) && comps.length < 10) {
      comps.push({
        priceAED: parseInt(m[1].replace(/,/g, ''), 10),
        psf: parseFloat(m[2]),
        date: m[3],
        status: m[4],
        type: m[5],
        beds: m[6],
        sizeSqft: parseFloat(m[7])
      });
    }

    let sampleAvgPsf = null;
    if (comps.length) {
      sampleAvgPsf = Math.round(comps.reduce((s, c) => s + c.psf, 0) / comps.length);
    }

    if (!avgSalePriceAED && !sampleAvgPsf) {
      return jsonResponse({ ok: false, reason: 'parse-failed', area });
    }

    return jsonResponse({
      ok: true,
      area,
      source: 'Property Finder — live DLD-sourced transactions',
      sourceUrl: url,
      asOf: new Date().toISOString().slice(0, 10),
      avgSalePriceAED,
      salesAnalyzed,
      roiPct,
      sampleAvgPsf,
      sampleCount: comps.length,
      comps: comps.slice(0, 5)
    });
  } catch (e) {
    return jsonResponse({ ok: false, reason: 'parse-error', detail: String((e && e.message) || e), area });
  }
};
