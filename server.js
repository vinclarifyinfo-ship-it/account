// server.js (CommonJS)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json()); // use json for our endpoints

const AIRWALLEX_ENV = process.env.AIRWALLEX_ENV || 'demo'; // 'production' or 'demo'
const AIRWALLEX_BASE = AIRWALLEX_ENV === 'production'
  ? 'https://api.airwallex.com'
  : 'https://api-demo.airwallex.com';

const AIRWALLEX_CLIENT_ID = process.env.AIRWALLEX_CLIENT_ID;
const AIRWALLEX_API_KEY = process.env.AIRWALLEX_API_KEY;
const WEBHOOK_SECRET = process.env.AIRWALLEX_WEBHOOK_SECRET || '';

if (!AIRWALLEX_CLIENT_ID || !AIRWALLEX_API_KEY) {
  console.warn('⚠️ Warning: AIRWALLEX_CLIENT_ID or AIRWALLEX_API_KEY missing in .env');
}

// simple in-memory store (replace with DB in prod)
const paymentIntents = [];
const payments = [];

// helper: safe read
async function safeReadResponse(res) {
  const txt = await res.text().catch(() => '');
  try { return JSON.parse(txt); } catch { return txt; }
}

// helper: get token
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
    console.error('Auth failed:', resp.status, body);
    throw new Error('Airwallex auth failed');
  }
  const data = await resp.json();
  const token = data.token || data.access_token || data.data?.token;
  if (!token) throw new Error('Token missing');
  return token;
}

/**
 * Create Hosted Payment Page (HPP) session / payment intent with redirect
 * Request body: { amount, currency, customer: { email, firstName, lastName }, plan, vin, orderId, return_url }
 */
app.post('/api/create-hpp-session', async (req, res) => {
  try {
    const { amount, currency = 'USD', customer, plan, vin, orderId, return_url } = req.body;
    if (!amount || !customer?.email) return res.status(400).json({ error: 'Missing amount or customer email' });

    // convert dollars -> cents (Airwallex expects smallest currency unit)
    const amountInCents = Math.round(Number(amount) * 100);

    // get token
    const token = await getAirwallexToken();

    const url = `${AIRWALLEX_BASE}/api/v1/pa/payment_intents/create`;
    const body = {
      amount: amountInCents,
      currency,
      merchant_order_id: orderId || `order_${Date.now()}`,
      customer: {
        email: customer.email,
        first_name: customer.firstName || '',
        last_name: customer.lastName || ''
      },
      metadata: { plan, vin, order_id: orderId },
      request_id: `req_${Date.now()}_${Math.random().toString(36).slice(2,9)}`,
      payment_method: { type: 'card' },
      next_action: {
        type: 'redirect',
        // Airwallex will redirect customer to this return_url after payment (success/cancel)
        return_url: return_url || (process.env.HPP_RETURN_URL || 'https://your-site.com/thankyou')
      }
    };

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!resp.ok) {
      const errBody = await safeReadResponse(resp);
      console.error('Create HPP failed:', resp.status, errBody);
      return res.status(500).json({ error: 'Airwallex create HPP failed', details: errBody });
    }

    const intent = await resp.json();
    // store minimal locally
    paymentIntents.push({
      id: intent.id,
      amount: amountInCents,
      currency,
      customer,
      status: intent.status || 'requires_payment_method',
      created_at: new Date().toISOString(),
      raw: intent
    });

    // The hosted page redirect URL is typically in intent.next_action.redirect_url
    const redirectUrl = intent.next_action?.redirect_url || intent.next_action?.redirect?.url || null;

    if (!redirectUrl) {
      console.warn('No redirect_url returned from Airwallex intent:', intent);
    }

    res.json({ intentId: intent.id, redirect_url: redirectUrl, raw: intent });
  } catch (err) {
    console.error('Error /create-hpp-session:', err);
    res.status(500).json({ error: err.message || 'failed' });
  }
});

/**
 * Optional: webhook endpoint to receive Airwallex events
 * Use express.raw body to verify signature if you want. Here we accept JSON but verify if secret provided.
 */
app.post('/api/webhook', express.json({ type: '*/*' }), (req, res) => {
  try {
    // If you provided AIRWALLEX_WEBHOOK_SECRET in dashboard, verify signature (recommended).
    // For simplicity, this example just logs the payload.
    const payload = req.body;
    console.log('Webhook received:', payload?.type || 'unknown', JSON.stringify(payload).slice(0,300));

    // example: handle payment success
    if (payload?.type === 'payment_intent.succeeded' || payload?.type === 'payment_intent.captured') {
      const pi = payload?.data;
      // TODO: find local order and mark paid
      console.log('Payment succeeded for', pi?.id);
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(400).send('err');
  }
});

// health-check
app.get('/', (req,res) => res.send({ status: 'Airwallex HPP backend live' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`💰 Airwallex HPP backend running on port ${PORT}`);
  console.log('Environment:', AIRWALLEX_ENV, 'Base:', AIRWALLEX_BASE);
});
