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
  'JVT': 'jumeirah-village-triangle',
  // Added 2026-08-27 (Price Checker accuracy fix, PR TBD) — each slug below was
  // manually confirmed live against propertyfinder.ae before being hardcoded here,
  // per the "never guess a slug for the fast-path map itself" rule above.
  'The Valley': 'the-valley',
  'Arabian Ranches': 'arabian-ranches',
  'Town Square': 'town-square',
  'Al Furjan': 'al-furjan',
  'DAMAC Hills 2': 'damac-hills-2'
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
  // Added 2026-08-27: visitors very often type the developer name along with the
  // community when filling in the free-text "Other" area field -- e.g. "The Valley
  // by Emaar" or "Damac Hills by Damac". Property Finder's own slugs never include
  // the developer, so a trailing " by <Developer>" (and any sub-community suffix
  // after a comma, e.g. "The Valley, Al Yufrah 1") broke slug resolution entirely
  // and silently fell back to the (much less accurate) citywide benchmark. Strip
  // both before falling back to the raw guesses.
  const withoutDeveloper = withoutParen.replace(/\s+by\s+[a-z][a-z .]*$/i, '').trim();
  const beforeComma = withoutDeveloper.split(',')[0].trim();
  if (beforeComma && beforeComma !== withoutDeveloper) candidates.push(slugify(beforeComma));
  if (withoutDeveloper && withoutDeveloper !== withoutParen) candidates.push(slugify(withoutDeveloper));
  candidates.push(slugify(withoutParen));
  candidates.push(slugify(area));
  // de-dupe while preserving order
  return candidates.filter((c, i) => c && candidates.indexOf(c) === i);
}

// Map the Price Checker's "Property Type" field to the category labels Property
// Finder uses on its transaction rows, so an area-wide average is never diluted
// by mixing villas/townhouses in with apartments (or vice versa) when no specific
// project match is found. Added 2026-08-27.
function typeCategory(type) {
  const t = String(type || '').toLowerCase();
  if (t === 'villa' || t === 'townhouse') return ['Villa', 'Townhouse'];
  return ['Apartment', 'Hotel Apartment']; // Apartment, Penthouse, Duplex all sell as "Apartment" rows on PF
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

// Rewritten 2026-08-28 (Price Checker accuracy fix, round 2). The previous regex
// assumed decimal-point numbers (e.g. "1234.56") and a single trailing size
// column. Live-checked against the actual page on 2026-08-28: Property Finder's
// current table is Date | Location | Sold price | Price/ft² | Completion Status |
// Property Type | Bedrooms | Plot size (ft²) | Built-up area (ft²) -- all numbers
// are comma-grouped INTEGERS (no decimals), and there are two size columns. For
// villas/townhouses "Plot size" is the basis their displayed Price/ft² is computed
// from; for apartments the "Plot size" column actually holds the unit's own size
// and "Built-up area" shows "-". Anchoring on the fixed tokens (Ready/Off-plan,
// the property-type word, the beds pattern) after the price+psf pair, same
// approach as before, just with the corrected number format and column order.
function parseRows(text) {
  const rowRe = /([\d,]{4,15})\s+([\d,]{1,7})\s+(Ready|Off-plan)\s+(Apartment|Villa|Townhouse|Hotel Apartment|Land)\s+(Studio|\d Beds?)\s+([\d,]{1,7})\s+([\d,]{1,7}|-)/g;
  let m, comps = [], lastEnd = 0;
  while ((m = rowRe.exec(text)) && comps.length < 40) {
    const label = text.slice(lastEnd, m.index).trim().slice(-140);
    lastEnd = rowRe.lastIndex;
    const dateMatch = label.match(/(\d{1,2}\s+[A-Z][a-z]{2}\s+.?\d{2,4})/);
    // "location" strips the date prefix so the frontend can show a clean
    // project/community name (e.g. "Elora The Valley") instead of the raw
    // "27 Aug '26 Elora The Valley" text.
    const location = dateMatch ? label.slice(dateMatch.index + dateMatch[0].length).trim() : label;
    const builtUpRaw = m[7];
    comps.push({
      label,
      location,
      date: dateMatch ? dateMatch[1] : null,
      priceAED: parseInt(m[1].replace(/,/g, ''), 10),
      psf: parseInt(m[2].replace(/,/g, ''), 10),
      status: m[3],
      type: m[4],
      beds: m[5],
      // The size the displayed Price/ft² is actually based on (plot size for
      // villas/townhouses; the apartment's own unit size for apartments).
      sizeSqft: parseInt(m[6].replace(/,/g, ''), 10),
      builtUpAreaSqft: builtUpRaw === '-' ? null : parseInt(builtUpRaw.replace(/,/g, ''), 10)
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
  const propType = (params.type || '').trim();

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

    let matchedProject = false, usedComps = comps, typeFiltered = false;
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
    // No specific building match -- at least keep the area average honest by not
    // blending villas/townhouses in with apartments (or vice versa). Added 2026-08-27.
    if (!matchedProject && propType) {
      const cats = typeCategory(propType);
      const typeComps = comps.filter(c => cats.indexOf(c.type) !== -1);
      if (typeComps.length) {
        usedComps = typeComps;
        typeFiltered = true;
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
      typeFiltered,
      comps: usedComps.slice(0, 5).map(c => ({ location: c.location, priceAED: c.priceAED, psf: c.psf, date: c.date, status: c.status, type: c.type, beds: c.beds, sizeSqft: c.sizeSqft, builtUpAreaSqft: c.builtUpAreaSqft }))
    });
  } catch (e) {
    return jsonResponse({ ok: false, reason: 'parse-error', detail: String((e && e.message) || e), area });
  }
};
