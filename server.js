// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

/**
 * ==========================
 * CONFIG
 * ==========================
 */
const AIRWALLEX_ENV = process.env.AIRWALLEX_ENV || 'production'; // 'demo' or 'production'
const AIRWALLEX_BASE =
  AIRWALLEX_ENV === 'production'
    ? 'https://api.airwallex.com'
    : 'https://api-demo.airwallex.com';

const AIRWALLEX_CLIENT_ID = process.env.AIRWALLEX_CLIENT_ID;
const AIRWALLEX_API_KEY = process.env.AIRWALLEX_API_KEY;

if (!AIRWALLEX_CLIENT_ID || !AIRWALLEX_API_KEY) {
  console.warn('⚠️ Missing Airwallex credentials in .env');
}

/**
 * ==========================
 * HELPER FUNCTIONS
 * ==========================
 */
async function safeReadResponse(res) {
  const txt = await res.text().catch(() => '');
  try {
    return JSON.parse(txt);
  } catch {
    return txt;
  }
}

async function getAirwallexToken() {
  const url = `${AIRWALLEX_BASE}/api/v1/authentication/login`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-client-id': AIRWALLEX_CLIENT_ID,
      'x-api-key': AIRWALLEX_API_KEY
    },
    body: JSON.stringify({})
  });

  if (!resp.ok) {
    const body = await safeReadResponse(resp);
    console.error('❌ Auth failed:', resp.status, body);
    throw new Error('Airwallex auth failed');
  }

  const data = await resp.json();
  return data.token || data.access_token || data.data?.token;
}

/**
 * ==========================
 * ROUTES
 * ==========================
 */

// ✅ Create Hosted Payment Page (HPP)
app.post('/api/create-hpp-session', async (req, res) => {
  try {
    const { amount, currency = 'USD', customer, plan, vin, orderId, return_url } = req.body;

    if (!amount || !customer?.email)
      return res.status(400).json({ error: 'Missing amount or customer email' });

    const token = await getAirwallexToken();

    const url = `${AIRWALLEX_BASE}/api/v1/pa/payment_links/create`;
    const body = {
      request_id: `req_${Date.now()}`,
      merchant_order_id: orderId || `order_${Date.now()}`,
      amount: Number(amount),
      currency: currency,
      customer: {
        email: customer.email,
        first_name: customer.firstName || '',
        last_name: customer.lastName || ''
      },
      metadata: { plan, vin },
      success_url: return_url || 'https://vincertification.com/success',
      cancel_url: return_url || 'https://vincertification.com/cancel',
      payment_method_types: ['card'], // 👈 required
      capture_method: 'AUTOMATIC'
    };

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!resp.ok) {
      const errBody = await safeReadResponse(resp);
      console.error('❌ Create HPP failed:', resp.status, errBody);
      return res.status(500).json({ error: 'Airwallex create HPP failed', details: errBody });
    }

    const data = await resp.json();
    console.log('✅ HPP created successfully:', data);

    res.json({
      payment_link_id: data.id,
      redirect_url: data.url,
      raw: data
    });
  } catch (err) {
    console.error('💥 Error /create-hpp-session:', err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Webhook (optional)
app.post('/api/webhook', express.json({ type: '*/*' }), (req, res) => {
  try {
    console.log('📩 Webhook received:', JSON.stringify(req.body).slice(0, 400));
    res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(400).send('err');
  }
});

// ✅ Health check
app.get('/', (req, res) => {
  res.send({ status: 'Airwallex HPP backend live', env: AIRWALLEX_ENV });
});

/**
 * ==========================
 * START SERVER
 * ==========================
 */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Airwallex HPP backend running on port ${PORT}`);
  console.log(`🌍 Environment: ${AIRWALLEX_ENV}`);
  console.log(`🔗 Base URL: ${AIRWALLEX_BASE}`);
});
