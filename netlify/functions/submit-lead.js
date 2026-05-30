// submit-lead.js — DXB Property Expert
// Handles two paths:
//   source:'hero-form'          → role:'buyer', emailSequence:'full-5-sequence'  → Brevo list 3
//   source:'price-checker-signup' → role:'agent'  → emailSequence:'agent-welcome-only' → Brevo list 6
//                                 → role:'buyer'|'owner' → emailSequence:'full-5-sequence'  → Brevo list 3

exports.handler = async (event) => {
  // Handle preflight CORS
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

  let data;
  try { data = JSON.parse(event.body); }
  catch(e) { return { statusCode: 400, body: 'Invalid JSON' }; }

  const {
    name, email, phone, budget, goal,
    role          = 'buyer',
    emailSequence = 'full-5-sequence',
    source        = 'hero-form'
  } = data;

  if (!name || !email || !phone) {
    return { statusCode: 400, body: 'Missing required fields' };
  }

  const firstName = name.split(' ')[0];
  const lastName  = name.split(' ').slice(1).join(' ') || '';

  // Brevo list routing:
  //   list 3 = Full 5-email sequence (buyers, owners, hero form)
  //   list 4 = Agent welcome only (1 email)
  // ⚠️  Update list IDs if you change them in Brevo
  const brevoListId = (emailSequence === 'agent-welcome-only') ? 6 : 3;

  await Promise.allSettled([
    addToHubSpot({ firstName, lastName, email, phone, budget, goal, role, source }),
    addToBrevo({ firstName, email, phone, budget, goal, role, source, listId: brevoListId }),
    sendTelegram({ name, email, phone, budget, goal, role, source }),
    sendFormspree({ name, email, phone, budget, goal, role, source })
  ]);

  return {
    statusCode: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type'
    },
    body: JSON.stringify({ ok: true })
  };
};

// ── HubSpot — Forms API ───────────────────────────────────────
async function addToHubSpot({ firstName, lastName, email, phone, budget, goal, role, source }) {
  const portalId = process.env.HUBSPOT_PORTAL_ID;
  const formId   = process.env.HUBSPOT_FORM_ID;
  if (!portalId || !formId) {
    console.error('HubSpot: missing HUBSPOT_PORTAL_ID or HUBSPOT_FORM_ID');
    return;
  }

  const res = await fetch(
    `https://api.hsforms.com/submissions/v3/integration/submit/${portalId}/${formId}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: [
          { name: 'firstname',        value: firstName       },
          { name: 'lastname',         value: lastName        },
          { name: 'email',            value: email           },
          { name: 'phone',            value: phone           },
          { name: 'investment_budget',value: budget || ''    },
          { name: 'investment_goal',  value: goal   || ''    },
          { name: 'lead_role',        value: role   || ''    },
          { name: 'lead_source',      value: source || ''    }
        ],
        context: {
          pageUri: 'https://dxbpropertyexpert.com',
          pageName: 'DXB Property Expert'
        }
      })
    }
  );

  if (!res.ok) {
    const body = await res.text();
    console.error('HubSpot error:', res.status, body);
  } else {
    console.log('HubSpot: contact submitted OK');
  }
}

// ── Brevo — API v3 ────────────────────────────────────────────
// Email automation is triggered by adding the contact to the correct list:
//   List 3 → Full 5-email sequence (buyers, owners, hero form leads)
//   List 4 → Agent welcome email only
// Set up the automation in Brevo → Automations → "Contact added to list X"
async function addToBrevo({ firstName, email, phone, budget, goal, role, source, listId }) {
  const key = process.env.BREVO_API_KEY;
  if (!key) {
    console.error('Brevo: missing BREVO_API_KEY');
    return;
  }

  const res = await fetch('https://api.brevo.com/v3/contacts', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': key
    },
    body: JSON.stringify({
      email,
      attributes: {
        FIRSTNAME:   firstName,
        SMS:         phone,
        BUDGET:      budget || '',
        GOAL:        goal   || '',
        ROLE:        role   || 'buyer',
        LEAD_SOURCE: source || 'hero-form'
      },
      listIds:       [listId],
      updateEnabled: true
    })
  });

  if (!res.ok) {
    const body = await res.text();
    console.error('Brevo error:', res.status, body);
  } else {
    console.log(`Brevo: contact added to list ${listId} OK`);
  }
}

// ── Telegram notification ─────────────────────────────────────
async function sendTelegram({ name, email, phone, budget, goal, role, source }) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.error('Telegram: missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
    return;
  }

  const cleanPhone = phone.replace(/\D/g, '');

  const roleEmoji = { buyer: '🏠', owner: '🔑', agent: '🤝' }[role] || '👤';
  const sourceLabel = source === 'hero-form' ? 'Hero Form (Consultation)' : 'Price Checker Sign-Up';

  const text =
    `🔔 <b>NEW LEAD — dxbpropertyexpert.com</b>\n\n` +
    `${roleEmoji} <b>Role:</b> ${(role || 'buyer').toUpperCase()}\n` +
    `📍 <b>Source:</b> ${sourceLabel}\n\n` +
    `👤 <b>Name:</b> ${name}\n` +
    `📧 <b>Email:</b> ${email}\n` +
    `📱 <b>WhatsApp:</b> ${phone}\n` +
    `💰 <b>Budget:</b> ${budget || '—'}\n` +
    `🎯 <b>Goal:</b> ${goal || '—'}\n\n` +
    `<a href="https://wa.me/${cleanPhone}">💬 Open WhatsApp</a>`;

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
  });

  if (!res.ok) {
    const body = await res.text();
    console.error('Telegram error:', res.status, body);
  } else {
    console.log('Telegram: notification sent OK');
  }
}

// ── Formspree — email backup ──────────────────────────────────
async function sendFormspree({ name, email, phone, budget, goal, role, source }) {
  const url = process.env.FORMSPREE_URL;
  if (!url) {
    console.error('Formspree: missing FORMSPREE_URL');
    return;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({
      name, email, phone, budget, goal, role, source,
      _subject: `🔔 New ${(role||'buyer').toUpperCase()} Lead: ${name} — ${budget || 'budget n/a'}`
    })
  });

  if (!res.ok) {
    const body = await res.text();
    console.error('Formspree error:', res.status, body);
  } else {
    console.log('Formspree: email sent OK');
  }
}
