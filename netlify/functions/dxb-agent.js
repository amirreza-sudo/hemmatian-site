// dxb-agent.js — DXB Property Expert AI Concierge
// Powers the visitor-facing chat/voice widget on dxbpropertyexpert.com.
// - Pulls live launch pricing + FX constants directly from the site's own index.html
//   (so the agent never quotes stale numbers — see references/site-sections.md)
// - Uses the dxb-concierge Skill as its system prompt
// - When a lead is qualified, calls the existing submit-lead pipeline
//   (HubSpot + Brevo + Telegram + Formspree) — no new CRM integration needed

const SKILL_CONTENT = require('./skill-content.js');

const SITE_URL = 'https://dxbpropertyexpert.com';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-6';

// index.html is a large single-file site (6MB+, all languages/sections/images
// inline). Re-downloading the whole thing on every single chat message just to
// regex-scrape a couple of small numbers (FX rate, launch prices) was adding
// real latency to every reply and was the likely cause of intermittent
// "Connection error" reports -- under any latency variance it was pushing
// total response time past Netlify's function timeout. Cache the result for a
// few minutes (module-level, survives across invocations on a warm container)
// so most messages skip the big fetch entirely. Prices/FX only change a
// handful of times a day at most, so a short staleness window is harmless.
let _liveDataCache = null;
let _liveDataCacheAt = 0;
const LIVE_DATA_TTL_MS = 5 * 60 * 1000;

// Give any single network call a hard ceiling so one slow leg can't silently
// consume the whole function's time budget -- fail fast with a clear error
// instead of hanging until Netlify kills the invocation.
async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      },
      body: ''
    };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  if (!ANTHROPIC_API_KEY) {
    return { statusCode: 500, body: 'Missing ANTHROPIC_API_KEY env var' };
  }

  let data;
  try { data = JSON.parse(event.body); }
  catch (e) { return { statusCode: 400, body: 'Invalid JSON' }; }

  const { message, history = [] } = data;
  if (!message) return { statusCode: 400, body: 'Missing message' };

  try {
    const liveData = await fetchLiveData();
    const systemPrompt = buildSystemPrompt(liveData);

    const messages = [
      ...history.map(h => ({ role: h.role, content: h.content })),
      { role: 'user', content: message }
    ];

    const reply = await runAgentTurn(systemPrompt, messages);

    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type'
      },
      body: JSON.stringify({ reply })
    };
  } catch (err) {
    console.error('dxb-agent error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'agent_failed' }) };
  }
};

// -- Live data extraction -- reads the site's own current numbers ------
async function fetchLiveData() {
  const now = Date.now();
  if (_liveDataCache && (now - _liveDataCacheAt) < LIVE_DATA_TTL_MS) {
    return _liveDataCache;
  }

  let html;
  try {
    const res = await fetchWithTimeout(SITE_URL, {}, 6000);
    html = await res.text();
  } catch (e) {
    // Self-fetch failed or timed out (slow network, cold start, etc). Serve
    // stale cached data if we have any rather than failing the whole chat
    // turn over a non-essential enrichment step; otherwise fall back to
    // built-in defaults below (fxMatch stays null).
    if (_liveDataCache) return _liveDataCache;
    html = '';
  }

  // FX constants: const AED_USD=1/3.65, AED_TMN=45800;
  const fxMatch = html.match(/AED_USD\s*=\s*1\s*\/\s*([\d.]+)\s*,\s*AED_TMN\s*=\s*(\d+)/);
  const aedToUsdDivisor = fxMatch ? parseFloat(fxMatch[1]) : 3.65;
  const aedToTomanRate = fxMatch ? parseInt(fxMatch[2], 10) : null;

  // Launch 1: Raw District II by Imtiaz — lnchSelect(...) — 60/40 plan
  const rawDistrictUnits = [];
  const lnchRegex = /lnchSelect\('(\w+)','([^']+)','([\d,]+)','([\d,]+)','([^']+)'\)/g;
  let m;
  while ((m = lnchRegex.exec(html)) !== null) {
    rawDistrictUnits.push({
      type: m[2],
      priceAED: parseInt(m[3].replace(/,/g, ''), 10),
      eoiAED: parseInt(m[4].replace(/,/g, ''), 10),
      plan: m[5]
    });
  }

  // Launch 2: Arancia Yards (City of Arabia) — aySelect(...) — separate project, separate plan
  const aranciaUnits = [];
  const ayRegex = /aySelect\('(\w+)','([^']+)','([\d,]+)','([\d,]+)','([^']+)'\)/g;
  while ((m = ayRegex.exec(html)) !== null) {
    aranciaUnits.push({
      type: m[2],
      priceAED: parseInt(m[3].replace(/,/g, ''), 10),
      eoiAED: parseInt(m[4].replace(/,/g, ''), 10),
      plan: m[5]
    });
  }

  // Launch 3: Palm Central Private Residences — Frond D, Palm Jebel Ali (Nakheel) — pcfSelect(...)
  // Two plans: 70/30 for 1BR/2BR/2BR+Maid, 60/40 for 3BR and up. Reservation AED 100K, cash or
  // manager's cheque to Nakheel only (no bank transfer). Closes Mon 7 Dec 2026 23:59 Dubai.
  const palmCentralUnits = [];
  const pcfRegex = /pcfSelect\('(\w+)','([^']+)','([\d,]+)','([\d,]+)','([^']+)'\)/g;
  while ((m = pcfRegex.exec(html)) !== null) {
    palmCentralUnits.push({
      type: m[2],
      priceAED: parseInt(m[3].replace(/,/g, ''), 10),
      eoiAED: parseInt(m[4].replace(/,/g, ''), 10),
      plan: m[5]
    });
  }
  const PCF_DEADLINE = Date.parse('2026-12-07T23:59:59+04:00');
  const pcfOpen = Date.now() <= PCF_DEADLINE;

  // Launch 4: The Beach Collection — Frond J beach villas, Palm Jebel Ali (Nakheel) — pjfSelect(...)
  // 15 standalone 5/6-bedroom villas, one 70/30 plan. Reservation AED 150,000 per villa by MANAGER'S
  // CHEQUE ONLY. Closes Fri 11 Dec 2026 23:59 Dubai (4 days after Palm Central). Added 2026-11-27.
  const frondJVillas = [];
  const pjfRegex = /pjfSelect\('(\w+)','([^']+)','([\d,]+)','([\d,]+)','([^']+)'\)/g;
  while ((m = pjfRegex.exec(html)) !== null) {
    frondJVillas.push({
      type: m[2],
      priceAED: parseInt(m[3].replace(/,/g, ''), 10),
      eoiAED: parseInt(m[4].replace(/,/g, ''), 10),
      plan: m[5]
    });
  }
  const PJF_DEADLINE = Date.parse('2026-12-11T23:59:59+04:00');
  const pjfOpen = Date.now() <= PJF_DEADLINE;

  const liveData = {
    aedToUsdDivisor, aedToTomanRate,
    launches: [
      { name: 'Raw District II (Imtiaz Developments)', units: rawDistrictUnits },
      { name: 'Arancia Yards (City of Arabia) — Phase 2', units: aranciaUnits },
      {
        name: 'Palm Central Private Residences — Frond D, Palm Jebel Ali (developer: Nakheel). 216 beachfront homes in 3 buildings, private beach, infinity pool. Estimated completion October 2030. RESERVATIONS CLOSE MONDAY 7 DECEMBER 2026, 11:59 PM DUBAI TIME. Reservation amount is AED 100,000 for every unit type, paid ONLY as cash or a manager\'s cheque payable to Nakheel, delivered in person in Dubai (by the client, their exchange house/sarraf, or a representative) — bank/account-to-account transfers are NOT accepted. Visitors reserve through the "Reserve a Unit" button in the Launches section, where they pick the unit, enter their details and choose the delivery date, time and place. A 4% DLD fee applies on top of the price. Prices are starting prices; final price depends on building, floor and view',
        units: pcfOpen ? palmCentralUnits : []
      },
      {
        name: 'The Beach Collection — Frond J beach villas, Palm Jebel Ali (developer: Nakheel). Only 15 standalone beachfront villas in 5 designs (Cyan Sky, Baia Luna, Wave Crest, Ocean Whisper, Bluejay), 5 or 6 bedrooms, each with a private lift, roof lounge and direct beach access. Estimated completion March 2030. RESERVATIONS CLOSE FRIDAY 11 DECEMBER 2026, 11:59 PM DUBAI TIME. Reservation amount is AED 150,000 per villa, paid ONLY by manager\'s cheque payable to Nakheel (Dubai Holding) — cash and bank/account-to-account transfers are NOT accepted. Visitors reserve through the "Reserve a Villa" button in the Launches section (below Palm Central), where they pick the villa, accept the payment plan, upload a passport or ID card and say which day they will be ready to hand over the cheque; AmirReza then arranges the time with them on WhatsApp, and any questions go to him on WhatsApp. Payment plan 70/30: 20% on booking, 50% in 8 instalments Apr 2027–Aug 2029, 30% on completion. A 4% DLD fee applies on top. Swimming pools and landscaping are not included',
        units: pjfOpen ? frondJVillas : []
      }
    ],
    fetchedAt: new Date().toISOString()
  };

  if (html) {
    _liveDataCache = liveData;
    _liveDataCacheAt = now;
  }

  return liveData;
}

function buildSystemPrompt(liveData) {
  const openLaunches = liveData.launches.filter(l => l.units.length);
  const launchBlock = !openLaunches.length
    ? `NO LAUNCH IS OPEN FOR REGISTRATION RIGHT NOW. The previous launches (including Palm Central Frond D — which closed on 7 December 2026 — The Beach Collection Frond J villas — which closed on 11 December 2026 — Palm Jebel Ali Frond F, Raw District II and Arancia Yards) are closed. The site's Launches section shows no open registration. AmirReza is deliberately keeping the next project secret — do NOT guess or hint at its name, location, developer, price, or whether it is residential or commercial. If a visitor asks about launches, build curiosity, say details go to the list first, and invite them to join the Telegram channel (t.me/amirrez_realtor) or message AmirReza on WhatsApp for early access; you may also offer to note their interest with submit_qualified_lead once you have name, email and WhatsApp.`
    : openLaunches.map(l => {
    const lines = l.units.map(u => `  - ${u.type}: from AED ${u.priceAED.toLocaleString()} | reservation/EOI: AED ${u.eoiAED.toLocaleString()} (cash or manager's cheque) | ${u.plan}`).join('\n');
    return `${l.name}:\n${lines}`;
  }).join('\n\n');

  const liveBlock = `
## LIVE DATA (fetched just now from dxbpropertyexpert.com — use these, don't guess)

${openLaunches.length > 1 ? 'There are currently several separate active launches. Do not mix their names, prices, or plans together — they are different projects with different developers and different payment plans.\n' : ''}
${launchBlock}

FX: 1 AED = ${liveData.aedToUsdDivisor ? (1 / liveData.aedToUsdDivisor).toFixed(4) : '0.2740'} USD (divide AED by ${liveData.aedToUsdDivisor || 3.65}) · 1 AED ≈ ${liveData.aedToTomanRate || 'N/A'} Toman

## RESPONSE FORMAT — STRICT

This reply is displayed in a small chat bubble and may be read aloud by TTS. Every response MUST:
- Be plain conversational sentences only — NO markdown of any kind: no **, no ##, no bullet points, no tables, no pipes.
- Be 2-3 short sentences MAX unless the visitor explicitly asks for a detailed breakdown of every unit.
- Answer only the specific question asked — don't append extra unit types, extra sections, or unrelated info "just in case."
- When a visitor asks about ONE unit type, give ONLY that unit's numbers — not the full price list.
`;

  return SKILL_CONTENT + '\n\n' + liveBlock;
}

// Strip any markdown that slips through, as a safety net for the chat-bubble UI
function stripMarkdown(text) {
  return text
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\|/g, ' ')
    .trim();
}

// ── Agent turn — handles Claude's tool use loop for lead submission ──
async function runAgentTurn(systemPrompt, messages) {
  const tools = [{
    name: 'submit_qualified_lead',
    description: 'Submit a qualified visitor lead into AmirReza\'s CRM (HubSpot/Brevo/Telegram). Only call this once you have collected name, email, and WhatsApp number, and the visitor has shown genuine buying/selling/investment intent.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string', description: 'WhatsApp number with country code' },
        budget: { type: 'string' },
        goal: { type: 'string', description: 'Rental Income / Capital Growth / Golden Visa-Residency / Personal Use' },
        role: { type: 'string', enum: ['buyer', 'owner', 'agent'] }
      },
      required: ['name', 'email', 'phone']
    }
  }];

  let currentMessages = [...messages];

  for (let turn = 0; turn < 3; turn++) {
    const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 300,
        system: systemPrompt,
        messages: currentMessages,
        tools
      })
    }, 20000);

    const result = await res.json();
    if (!res.ok) throw new Error('Anthropic API error: ' + JSON.stringify(result));

    const toolUse = result.content.find(b => b.type === 'tool_use');
    const textBlocks = result.content.filter(b => b.type === 'text').map(b => b.text).join('\n');

    if (!toolUse) {
      return stripMarkdown(textBlocks);
    }

    // Execute the tool call (submit lead into existing CRM pipeline)
    let toolResultText = 'ok';
    if (toolUse.name === 'submit_qualified_lead') {
      try {
        await submitLead(toolUse.input);
        toolResultText = 'Lead submitted successfully to CRM.';
      } catch (e) {
        toolResultText = 'Lead submission failed: ' + e.message;
      }
    }

    currentMessages = [
      ...currentMessages,
      { role: 'assistant', content: result.content },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: toolResultText }] }
    ];
  }

  return "Let me get AmirReza to follow up with you directly on WhatsApp.";
}

// ── Reuses the existing submit-lead pipeline (HubSpot/Brevo/Telegram/Formspree) ──
async function submitLead({ name, email, phone, budget, goal, role }) {
  const url = (process.env.URL || SITE_URL) + '/.netlify/functions/submit-lead';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name, email, phone,
      budget: budget || '',
      goal: goal || '',
      role: role || 'buyer',
      emailSequence: 'full-5-sequence',
      source: 'ai-agent-chat'
    })
  });
  if (!res.ok) throw new Error('submit-lead returned ' + res.status);
}
