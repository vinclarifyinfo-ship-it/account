// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch'); // Ensure node-fetch installed
const app = express();

app.use(cors());
app.use(express.json());

// ----------------------------
// CONFIGURATION
// ----------------------------
const AIRWALLEX_ENV = process.env.AIRWALLEX_ENV || 'demo'; // 'production' or 'demo'
const AIRWALLEX_BASE =
  AIRWALLEX_ENV === 'production'
    ? 'https://api.airwallex.com'
    : 'https://api-demo.airwallex.com';

const AIRWALLEX_API_KEY =
  process.env.AIRWALLEX_API_KEY ||
  '3a87b90852bfe38eaba7c024e49e6ae83cefacd8fab6615fba5581a2f8299eab5795c7e0a3c78dcee5029c0dec03d524';

if (!AIRWALLEX_API_KEY) {
  console.warn('⚠️ Missing Airwallex API Key in .env file!');
}

// ----------------------------
// HELPER FUNCTIONS
// ----------------------------
async function parseResponse(resp) {
  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch (err) {
    console.error('⚠️ Airwallex returned non-JSON (HTML) response:', text.slice(0, 200));
    return null;
  }
}

// ----------------------------
// MAIN ENDPOINT
// ----------------------------
app.post('/api/create-hpp-session', async (req, res) => {
  try {
    const {
      amount,
      currency = 'USD',
      customer,
      plan,
      vin,
      orderId,
      return_url,
    } = req.body;

    if (!amount || !customer?.email) {
      return res
        .status(400)
        .json({ error: 'Missing amount or customer email in request' });
    }

    const amountInCents = Math.round(Number(amount) * 100);

    const requestBody = {
      amount: amountInCents,
      currency,
      merchant_order_id: orderId || `order_${Date.now()}`,
      customer: {
        email: customer.email,
        first_name: customer.firstName || '',
        last_name: customer.lastName || '',
      },
      metadata: { plan, vin, order_id: orderId },
      request_id: `req_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      payment_method: { type: 'card' },
      next_action: {
        type: 'redirect',
        return_url:
          return_url || process.env.HPP_RETURN_URL || 'https://your-site.com/thankyou',
      },
    };

    console.log('➡️ Creating HPP session with:', requestBody);

    const url = `${AIRWALLEX_BASE}/api/v1/pa/payment_intents/create`;

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${AIRWALLEX_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    const data = await parseResponse(resp);

    if (!resp.ok || !data) {
      console.error('❌ Airwallex Create HPP Failed:', resp.status, data);
      return res.status(500).json({
        error: 'Airwallex create HPP failed',
        status: resp.status,
        details: data || 'Non-JSON response received',
      });
    }

    console.log('✅ Payment Intent Created:', data);

    const redirectUrl =
      data?.next_action?.redirect_url ||
      data?.next_action?.redirect?.url ||
      null;

    if (!redirectUrl) {
      console.warn('⚠️ No redirect URL in Airwallex response:', data);
      return res.status(500).json({
        error: 'No redirect URL received from Airwallex',
        raw: data,
      });
    }

    res.json({
      intentId: data.id,
      redirect_url: redirectUrl,
      raw: data,
    });
  } catch (err) {
    console.error('🔥 Error in /create-hpp-session:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

// ----------------------------
// WEBHOOK (optional)
// ----------------------------
app.post('/api/webhook', express.json({ type: '*/*' }), (req, res) => {
  try {
    const payload = req.body;
    console.log('📦 Webhook received:', payload?.type || 'unknown');

    if (
      payload?.type === 'payment_intent.succeeded' ||
      payload?.type === 'payment_intent.captured'
    ) {
      console.log('✅ Payment succeeded for', payload?.data?.id);
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(400).send('Webhook error');
  }
});

// ----------------------------
// HEALTH CHECK
// ----------------------------
app.get('/', (req, res) => {
  res.send({ status: '✅ Airwallex HPP backend live' });
});

// ----------------------------
// START SERVER
// ----------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`Environment: ${AIRWALLEX_ENV}`);
  console.log(`API Base: ${AIRWALLEX_BASE}`);
});
