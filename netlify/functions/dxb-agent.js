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

  // Current live launch slug: source:'LAUNCH_RAW-DISTRICT-II'
  const launchSlugMatch = html.match(/source:'LAUNCH_([^']+)'/);
  const launchSlug = launchSlugMatch ? launchSlugMatch[1].replace(/-/g, ' ') : null;

  // Launch units: lnchSelect('STU','Studio','666,000','50,000','60/40 Plan')
  const unitRegex = /lnchSelect\('(\w+)','([^']+)','([\d,]+)','([\d,]+)','([^']+)'\)/g;
  const units = [];
  let m;
  while ((m = unitRegex.exec(html)) !== null) {
    units.push({
      code: m[1],
      type: m[2],
      priceAED: parseInt(m[3].replace(/,/g, ''), 10),
      eoiAED: parseInt(m[4].replace(/,/g, ''), 10),
      plan: m[5]
    });
  }

  return { aedToUsdDivisor, aedToTomanRate, launchSlug, units, fetchedAt: new Date().toISOString() };
}

function buildSystemPrompt(liveData) {
  const liveBlock = `
## LIVE DATA (fetched just now from dxbpropertyexpert.com — use these, don't guess)

Current launch: ${liveData.launchSlug || 'unknown — check site'}
FX: 1 AED = ${liveData.aedToUsdDivisor ? (1 / liveData.aedToUsdDivisor).toFixed(4) : '0.2740'} USD (divide AED by ${liveData.aedToUsdDivisor || 3.65}) · 1 AED ≈ ${liveData.aedToTomanRate || 'N/A'} Toman
Available units:
${liveData.units.map(u => `- ${u.type}: AED ${u.priceAED.toLocaleString()} | EOI: AED ${u.eoiAED.toLocaleString()} cash | ${u.plan}`).join('\n') || 'none found — direct visitor to check the Launch page directly'}

Use these numbers directly in your calculations. Do not mention 50/50 or any plan not listed above.
`;

  return SKILL_CONTENT + '\n\n' + liveBlock;
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
        max_tokens: 1024,
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
      return textBlocks;
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
