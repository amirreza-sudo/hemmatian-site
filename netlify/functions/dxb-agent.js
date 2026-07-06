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

// ── Live data extraction — reads the site's own current numbers ──────
async function fetchLiveData() {
  const res = await fetch(SITE_URL);
  const html = await res.text();

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

  return {
    aedToUsdDivisor, aedToTomanRate,
    launches: [
      { name: 'Raw District II (Imtiaz Developments)', units: rawDistrictUnits },
      { name: 'Arancia Yards (City of Arabia) — Phase 2', units: aranciaUnits }
    ],
    fetchedAt: new Date().toISOString()
  };
}

function buildSystemPrompt(liveData) {
  const launchBlock = liveData.launches.map(l => {
    if (!l.units.length) return `${l.name}: no live units found — direct visitor to check the Launch page directly.`;
    const lines = l.units.map(u => `  - ${u.type}: AED ${u.priceAED.toLocaleString()} | EOI: AED ${u.eoiAED.toLocaleString()} cash | ${u.plan}`).join('\n');
    return `${l.name}:\n${lines}`;
  }).join('\n\n');

  const liveBlock = `
## LIVE DATA (fetched just now from dxbpropertyexpert.com — use these, don't guess)

There are currently TWO separate active launches. Do not mix their names, prices, or plans together — they are different projects with different developers and different payment plans.

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
    const res = await fetch('https://api.anthropic.com/v1/messages', {
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
    });

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
