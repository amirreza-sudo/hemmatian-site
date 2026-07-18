// live-comps.js — DXB Property Expert
//
// Live, per-visitor cross-check against Property Finder's public sale-transactions
// pages (DLD-sourced, server-rendered -- no login required). Called by the Price
// Checker in index.html on every submission.
//
// v2 (2026-07-18): no longer limited to a fixed list of 10 areas. Any area name
// the visitor types (including free text via the "Other" field) is resolved to a
// Property Finder URL slug dynamically -- a few known-good mappings are tried
// first (fast path), then a handful of slug guesses derived from the text itself.
// Whichever candidate actually returns real transaction data wins; if none do, we
// fail soft exactly as before. This also adds project/building-level filtering:
// if the visitor's project name matches transactions for that specific building,
// those are used instead of the area-wide average.
//
// Why only Property Finder and not Bayut too: Bayut's equivalent transactions page
// renders its table client-side via JavaScript, so a lightweight serverless fetch
// only sees an empty shell -- there is no real data to parse without running a full
// headless browser per visitor, which is too slow/fragile for a live request path.
// Bayut, Property Monitor and DXB Interact (the latter two need a personal login)
// are instead refreshed on the twice-weekly Cowork scheduled task directly into
// index.html's static MKT dataset.
//
// This function fails soft on every error path: any problem (no working slug,
// fetch timeout, HTTP error, unparsable page) returns { ok:false, reason } with
// HTTP 200, and the frontend falls back to the static MKT/CITY_BENCH figures
// already baked into index.html. Nothing here should ever be able to break the
// Price Checker.

// Known-good area-name -> Property Finder URL slug mappings, confirmed manually.
// Tried first (fast path, no guessing needed) before falling back to dynamic
// slug candidates for anything not listed here -- including free-text area names
// typed via the site's "Other" field.
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

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Build an ordered list of slug candidates to try for a given area name.
function slugCandidates(area) {
  const candidates = [];
  if (AREA_SLUGS[area]) candidates.push(AREA_SLUGS[area]);
  const parenMatch = area.match(/\(([^)]+)\)/);
  const withoutParen = area.replace(/\([^)]*\)/g, ' ').trim();
  if (parenMatch) candidates.push(slugify(parenMatch[1]));
  candidates.push(slugify(withoutParen));
  candidates.push(slugify(area));
  // de-dupe while preserving order
  return candidates.filter((c, i) => c && candidates.indexOf(c) === i);
}

function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

async function fetchPage(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; DXBPropertyExpertBot/1.0; +https://dxbpropertyexpert.com)',
        'Accept': 'text/html'
      },
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    return await res.text();
  } catch (e) {
    clearTimeout(timeout);
    return null;
  }
}

function parseRows(text) {
  const rowRe = /([\d,]{5,12})\s+(\d{2,5}\.\d{1,2})\s+(\d{1,2} [A-Z][a-z]{2} \d{4})\s+(Ready|Off-plan)\s+(Apartment|Villa|Townhouse|Hotel Apartment|Land)\s+(Studio|\d Beds?)\s+(\d{2,6}\.\d{1,2})/g;
  let m, comps = [], lastEnd = 0;
  while ((m = rowRe.exec(text)) && comps.length < 40) {
    const label = text.slice(lastEnd, m.index).trim().slice(-140);
    lastEnd = rowRe.lastIndex;
    comps.push({
      label,
      priceAED: parseInt(m[1].replace(/,/g, ''), 10),
      psf: parseFloat(m[2]),
      date: m[3],
      status: m[4],
      type: m[5],
      beds: m[6],
      sizeSqft: parseFloat(m[7])
    });
  }
  return comps;
}

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  const params = event.queryStringParameters || {};
  const area = (params.area || '').trim();
  const project = (params.project || '').trim();

  if (!area) {
    return jsonResponse({ ok: false, reason: 'no-area' });
  }

  const candidates = slugCandidates(area);
  if (!candidates.length) {
    return jsonResponse({ ok: false, reason: 'unresolvable-area', area });
  }

  let html = null, usedSlug = null, tried = [];
  for (const slug of candidates) {
    tried.push(slug);
    const url = `https://www.propertyfinder.ae/en/transactions/buy/dubai/${slug}`;
    const pageHtml = await fetchPage(url);
    if (pageHtml && /average sale price of [\d,]+\s*AED/i.test(pageHtml)) {
      html = pageHtml;
      usedSlug = slug;
      break;
    }
  }

  if (!html) {
    return jsonResponse({ ok: false, reason: 'no-matching-slug', area, tried });
  }

  try {
    let avgSalePriceAED = null, salesAnalyzed = null, roiPct = null;
    const metaMatch = html.match(/average sale price of ([\d,]+)\s*AED\.\s*Analyse (\d+)\s*sales?,?\s*with a ([\d.]+)%\s*return on investment/i);
    if (metaMatch) {
      avgSalePriceAED = parseInt(metaMatch[1].replace(/,/g, ''), 10);
      salesAnalyzed = parseInt(metaMatch[2], 10);
      roiPct = parseFloat(metaMatch[3]);
    }

    let text = stripTags(html);
    let comps = parseRows(text);

    // If a project/building name was given, fetch a second page to widen the
    // sample -- a specific building may not appear in just the first 10 sales.
    if (project && comps.length) {
      const page2Html = await fetchPage(`https://www.propertyfinder.ae/en/transactions/buy/dubai/${usedSlug}?page=2`);
      if (page2Html) {
        comps = comps.concat(parseRows(stripTags(page2Html)));
      }
    }

    let matchedProject = false, usedComps = comps;
    if (project) {
      const pWords = normalize(project).split(' ').filter(w => w.length > 2);
      if (pWords.length) {
        const projectComps = comps.filter(c => {
          const lNorm = normalize(c.label);
          return pWords.every(w => lNorm.includes(w));
        });
        if (projectComps.length) {
          usedComps = projectComps;
          matchedProject = true;
        }
      }
    }

    let sampleAvgPsf = null;
    if (usedComps.length) {
      sampleAvgPsf = Math.round(usedComps.reduce((s, c) => s + c.psf, 0) / usedComps.length);
    }

    if (!avgSalePriceAED && !sampleAvgPsf) {
      return jsonResponse({ ok: false, reason: 'parse-failed', area, usedSlug });
    }

    return jsonResponse({
      ok: true,
      area,
      resolvedSlug: usedSlug,
      source: 'Property Finder — live DLD-sourced transactions',
      sourceUrl: `https://www.propertyfinder.ae/en/transactions/buy/dubai/${usedSlug}`,
      asOf: new Date().toISOString().slice(0, 10),
      avgSalePriceAED,
      salesAnalyzed,
      roiPct,
      sampleAvgPsf,
      sampleCount: usedComps.length,
      matchedProject,
      comps: usedComps.slice(0, 5).map(c => ({ priceAED: c.priceAED, psf: c.psf, date: c.date, status: c.status, type: c.type, beds: c.beds, sizeSqft: c.sizeSqft }))
    });
  } catch (e) {
    return jsonResponse({ ok: false, reason: 'parse-error', detail: String((e && e.message) || e), area });
  }
};
