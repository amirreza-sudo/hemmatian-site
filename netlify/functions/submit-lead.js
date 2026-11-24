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
    source        = 'hero-form',
    reservation   = null,   // launch reservation details (Palm Central Frond D, 2026-11-24)
    idFile        = null,   // legacy single document { name, type, data(base64) }
    idFiles       = null    // [{ label, name, type, data(base64) }] — passport + ID card (required by the launch form)
  } = data;

  if (!name || !email || !phone) {
    return { statusCode: 400, body: 'Missing required fields' };
  }

  const firstName = name.split(' ')[0];
  const lastName  = name.split(' ').slice(1).join(' ') || '';

  // Brevo list routing:
  //   list 3 = Full 5-email sequence (buyers, owners, hero form)
  //   list 6 = Agent welcome only (1 email)
  // ⚠️  Update list IDs if you change them in Brevo
  const brevoListId = (emailSequence === 'agent-welcome-only') ? 6 : 3;

  await Promise.allSettled([
    addToHubSpot({ firstName, lastName, email, phone, budget, goal, role, source }),
    addToBrevo({ firstName, email, phone, budget, goal, role, source, listId: brevoListId }),
    reservation
      ? sendReservationTelegram({ name, email, phone, reservation, idFiles: Array.isArray(idFiles) ? idFiles : (idFile ? [Object.assign({ label: 'ID copy' }, idFile)] : []) })
      : sendTelegram({ name, email, phone, budget, goal, role, source }),
    sendFormspree({ name, email, phone, budget, goal, role, source, reservation })
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
  // Normalize phone to international format for Brevo
  let smsPhone = phone ? phone.replace(/[^0-9+]/g, "") : "";
  if (smsPhone && !smsPhone.startsWith("+")) {
    if (smsPhone.startsWith("00")) smsPhone = "+" + smsPhone.slice(2);
    else if (smsPhone.startsWith("971")) smsPhone = "+" + smsPhone;
    else smsPhone = "+971" + smsPhone;
  }
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
        SMS:         smsPhone,
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

  const roleEmoji = { buyer: '🏠', owner: '🔑', seller: '🔑', agent: '🤝' }[role] || '👤';
  const sourceLabel = source === 'hero-form' ? 'Hero Form (Consultation)'
    : source === 'CONSULTATION' ? 'Consultation Form'
    : source === 'price-checker-signup' ? 'Price Checker Sign-Up'
    : source === 'PRICE_CHECK_REGISTER' ? 'Price Checker Registration'
    : source === 'PRICE_CHECK' ? 'Price Checker Result'
    : source === 'website-buy-search' ? 'Buy — Secondary Market Search'
    : source === 'website-sell-listing' ? 'Sell — Property Listing'
    : source.startsWith('launch-') ? 'Launch EOI — ' + source.replace('launch-','').replace(/-/g,' ')
    : source;

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
async function sendFormspree({ name, email, phone, budget, goal, role, source, reservation }) {
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
      ...(reservation ? flattenReservation(reservation) : {}),
      _subject: reservation
        ? `🏝️ RESERVATION ${reservation.ref || ''}: ${name} — ${reservation.unit || ''} (${reservation.project || 'launch'})`
        : `🔔 New ${(role||'buyer').toUpperCase()} Lead: ${name} — ${budget || 'budget n/a'}`
    })
  });

  if (!res.ok) {
    const body = await res.text();
    console.error('Formspree error:', res.status, body);
  } else {
    console.log('Formspree: email sent OK');
  }
}

// ── Launch reservation (added 2026-11-24 for Palm Central Frond D) ──────────
// Sends a detailed reservation card to Telegram, then the passport/ID copy (if any)
// as a document in the same chat. Reservation money is cash / manager's cheque only,
// delivered in person in Dubai — this message tells AmirReza when, where and by whom.
const R_LABELS = {
  method:   { cash: 'Cash', cheque: "Manager's cheque payable to Nakheel" },
  by:       { self: 'Client in person (in Dubai)', exchange: 'Exchange house (sarraf)', rep: 'Representative' },
  location: { nakheel: 'Nakheel Sales Centre', office: "AmirReza's office", exchange: "Exchange house's office in Dubai", other: 'Other location' },
  time:     { morning: 'Morning (9–12)', afternoon: 'Afternoon (12–5 PM)', evening: 'Evening (5–9 PM)' }
};
function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
function flattenReservation(r) {
  return {
    reservation_ref: r.ref, reservation_project: r.project, reservation_unit: r.unit,
    reservation_starting_price: r.startingPrice, reservation_plan: r.plan, reservation_amount: r.amount,
    reservation_method: R_LABELS.method[r.method] || r.method,
    reservation_delivered_by: (R_LABELS.by[r.deliveredBy] || r.deliveredBy) + (r.deliveredByDetails ? ' — ' + r.deliveredByDetails : ''),
    reservation_location: (R_LABELS.location[r.location] || r.location) + (r.locationDetails ? ' — ' + r.locationDetails : ''),
    reservation_date: r.date, reservation_time: R_LABELS.time[r.time] || r.time,
    nationality: r.nationality, residence: r.residence, notes: r.notes,
    id_attached: r.idAttached ? 'passport + ID card (sent to Telegram)' : 'no', plan_accepted: r.planAccepted ? 'yes' : '', site_language: r.lang
  };
}
async function sendReservationTelegram({ name, email, phone, reservation: r, idFiles = [] }) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.error('Telegram: missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
    return;
  }
  const f = flattenReservation(r);
  const cleanPhone = String(phone || '').replace(/\D/g, '');
  const text =
    `🏝️ <b>NEW RESERVATION — ${escHtml(r.project || 'Launch')}</b>\n` +
    `🔖 <b>Ref:</b> ${escHtml(r.ref)}\n\n` +
    `🏠 <b>Unit:</b> ${escHtml(r.unit)} — from ${escHtml(r.startingPrice)} (${escHtml(r.plan)})\n` +
    `💵 <b>Reservation:</b> ${escHtml(r.amount)} — ${escHtml(f.reservation_method)}\n` +
    `🚶 <b>Delivered by:</b> ${escHtml(f.reservation_delivered_by)}\n` +
    (r.location ? `📍 <b>Where:</b> ${escHtml(f.reservation_location)}\n` : `📍 <b>Where:</b> to be arranged by phone\n`) +
    `📅 <b>Preferred day:</b> ${escHtml(r.date)} · ${escHtml(f.reservation_time)}\n` +
    (r.planAccepted ? `✅ <b>Payment plan:</b> reviewed & accepted by client\n` : '') + `\n` +
    `👤 <b>Name:</b> ${escHtml(name)}\n` +
    `📧 <b>Email:</b> ${escHtml(email)}\n` +
    `📱 <b>WhatsApp:</b> ${escHtml(phone)}\n` +
    `🌍 <b>Nationality / residence:</b> ${escHtml(r.nationality)} / ${escHtml(r.residence)}\n` +
    `🪪 <b>Documents:</b> ${idFiles.length ? idFiles.map(d => escHtml(d.label || 'ID')).join(' + ') + ' — attached below' : 'not provided'}\n` +
    (r.notes ? `📝 <b>Notes:</b> ${escHtml(r.notes)}\n` : '') +
    `🗣 <b>Site language:</b> ${escHtml((r.lang || 'en').toUpperCase())}\n\n` +
    `<a href="https://wa.me/${cleanPhone}">💬 Open WhatsApp</a>`;

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true })
  });
  if (!res.ok) console.error('Telegram reservation error:', res.status, await res.text());
  else console.log('Telegram: reservation sent OK');

  // Documents (passport, ID card) — each sent as its own Telegram document. The browser resizes
  // photos before upload so the whole request stays under Netlify's 6 MB body limit.
  for (const doc of (idFiles || []).slice(0, 4)) {
    if (!doc || !doc.data || doc.data.length > 4400000) continue;
    try {
      const buf  = Buffer.from(doc.data, 'base64');
      const form = new FormData();
      form.append('chat_id', String(chatId));
      form.append('caption', `🪪 ${doc.label || 'ID'} — ${r.ref || ''} — ${name || ''}`.slice(0, 1000));
      const safeName = String(doc.name || 'document').replace(/[^\w.\- ]+/g, '_').slice(0, 80) || 'document';
      form.append('document', new Blob([buf], { type: doc.type || 'application/octet-stream' }), safeName);
      const dres = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: 'POST', body: form });
      if (!dres.ok) console.error('Telegram document error:', dres.status, await dres.text());
      else console.log('Telegram: document sent OK —', doc.label);
    } catch (e) {
      console.error('Telegram document exception:', e && e.message);
    }
  }
}
