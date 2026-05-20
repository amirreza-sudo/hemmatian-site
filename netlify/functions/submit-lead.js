// Netlify Function: submit-lead.js
// Receives form data from dxbpropertyexpert.com and forwards to:
// HubSpot CRM, Brevo email list, Telegram bot, Formspree
//
// All secrets are stored as Netlify environment variables (not in code).
// Required env vars:
//   HUBSPOT_PORTAL_ID, HUBSPOT_FORM_ID
//   BREVO_FORM_URL
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
//   FORMSPREE_URL

exports.handler = async (event) => {
  const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Parse incoming JSON
  let data;
  try {
    data = JSON.parse(event.body);
  } catch (err) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { name, email, phone, budget, goal } = data;

  // Basic validation
  if (!name || !email || !phone) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Missing required fields' }) };
  }

  // Split name into first/last
  const nameParts = String(name).trim().split(/\s+/);
  const firstName = nameParts[0] || '';
  const lastName = nameParts.slice(1).join(' ') || '';

  // Read secrets from environment
  const {
    HUBSPOT_PORTAL_ID,
    HUBSPOT_FORM_ID,
    BREVO_FORM_URL,
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID,
    FORMSPREE_URL
  } = process.env;

  // Build Telegram message
  const dubaiTime = new Date().toLocaleString('en-AE', { timeZone: 'Asia/Dubai' });
  const telegramText = [
    '🔔 NEW LEAD - DXB Property Expert',
    '',
    '👤 Name: ' + name,
    '📧 Email: ' + email,
    '📱 Phone: ' + phone,
    '💰 Budget: ' + (budget || 'Not specified'),
    '🎯 Goal: ' + (goal || 'Not specified'),
    '',
    '🕐 ' + dubaiTime + ' (Dubai)'
  ].join('\n');

  // Build Brevo URL-encoded body
  const brevoParams = new URLSearchParams();
  brevoParams.append('EMAIL', email);
  brevoParams.append('FIRSTNAME', firstName);
  brevoParams.append('LASTNAME', lastName);
  brevoParams.append('SMS', phone);
  brevoParams.append('email_address_check', '');
  brevoParams.append('locale', 'en');

  // Build HubSpot payload
  const hubspotPayload = {
    fields: [
      { objectTypeId: '0-1', name: 'firstname', value: firstName },
      { objectTypeId: '0-1', name: 'lastname', value: lastName },
      { objectTypeId: '0-1', name: 'email', value: email },
      { objectTypeId: '0-1', name: 'phone', value: phone }
    ],
    context: {
      pageUri: 'https://dxbpropertyexpert.com',
      pageName: 'Lead | Budget: ' + (budget || '?') + ' | Goal: ' + (goal || '?')
    }
  };

  // Fire all 4 integrations in parallel
  const promises = [
    fetch('https://api.hsforms.com/submissions/v3/integration/submit/' + HUBSPOT_PORTAL_ID + '/' + HUBSPOT_FORM_ID, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(hubspotPayload)
    }).then(r => ({ service: 'hubspot', ok: r.ok, status: r.status })).catch(e => ({ service: 'hubspot', ok: false, error: String(e) })),

    fetch(BREVO_FORM_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: brevoParams.toString()
    }).then(r => ({ service: 'brevo', ok: true, status: r.status })).catch(e => ({ service: 'brevo', ok: false, error: String(e) })),

    fetch('https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: telegramText })
    }).then(r => ({ service: 'telegram', ok: r.ok, status: r.status })).catch(e => ({ service: 'telegram', ok: false, error: String(e) })),

    fetch(FORMSPREE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        name: name, email: email, phone: phone, budget: budget, goal: goal,
        source: 'dxbpropertyexpert.com',
        timestamp: new Date().toISOString()
      })
    }).then(r => ({ service: 'formspree', ok: r.ok, status: r.status })).catch(e => ({ service: 'formspree', ok: false, error: String(e) }))
  ];

  const results = await Promise.allSettled(promises);
  const summary = results.map(r => r.status === 'fulfilled' ? r.value : { service: 'unknown', ok: false, error: String(r.reason) });

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({ ok: true, integrations: summary })
  };
};
