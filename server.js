const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
require('dotenv').config();

const app = express();

// --- Middleware ---
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// --- Airwallex Config ---
const AIRWALLEX_CONFIG = {
  apiKey: process.env.AIRWALLEX_API_KEY,
  clientId: process.env.AIRWALLEX_CLIENT_ID,
  apiBaseUrl:
    process.env.AIRWALLEX_ENV === 'production'
      ? 'https://api.airwallex.com'
      : 'https://api-demo.airwallex.com',
};

// --- Get Access Token ---
async function getAirwallexToken() {
  try {
    const response = await axios.post(
      `${AIRWALLEX_CONFIG.apiBaseUrl}/api/v1/authentication/login`,
      {
        client_id: AIRWALLEX_CONFIG.clientId,
        api_key: AIRWALLEX_CONFIG.apiKey,
      }
    );
    return response.data.token;
  } catch (error) {
    console.error('❌ Error getting Airwallex token:', error.response?.data || error.message);
    throw new Error('Failed to authenticate with Airwallex');
  }
}

// --- Create Payment Intent ---
app.post('/api/create-payment-intent', async (req, res) => {
  try {
    const { amount, currency = 'USD', orderId, customerInfo } = req.body;

    if (!amount || !orderId) {
      return res.status(400).json({ error: 'Amount and orderId are required' });
    }

    const token = await getAirwallexToken();

    const payload = {
      request_id: `req_${orderId}_${Date.now()}`,
      amount: parseFloat(amount).toFixed(2),
      currency: currency.toUpperCase(),
      merchant_order_id: orderId,
      order: {
        type: 'vhr_report',
        products: [
          {
            name: 'Vehicle History Report',
            desc: 'Comprehensive vehicle history report',
            quantity: 1,
            unit_price: parseFloat(amount).toFixed(2),
          },
        ],
      },
      customer: {
        email: customerInfo?.email || '',
        first_name: customerInfo?.firstName || '',
        last_name: customerInfo?.lastName || '',
      },
    };

    const response = await axios.post(
      `${AIRWALLEX_CONFIG.apiBaseUrl}/api/v1/pa/payment_intents/create`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );

    res.json({
      client_secret: response.data.client_secret,
      payment_intent_id: response.data.id,
      status: response.data.status,
    });
  } catch (error) {
    console.error('❌ Error creating payment intent:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Failed to create payment intent',
      details: error.response?.data || error.message,
    });
  }
});

// --- Confirm Payment ---
app.post('/api/confirm-payment', async (req, res) => {
  try {
    const { paymentIntentId, card, paymentMethod } = req.body;

    if (!paymentIntentId) {
      return res.status(400).json({ error: 'Payment Intent ID is required' });
    }

    const token = await getAirwallexToken();

    const confirmData = {
      payment_method: paymentMethod || {
        type: 'card',
        card: {
          number: card?.number,
          expiry_month: card?.expiry_month,
          expiry_year: card?.expiry_year,
          cvc: card?.cvc,
          name: card?.name,
        },
      },
      return_url: `${process.env.FRONTEND_URL}/payment-success`,
    };

    const response = await axios.post(
      `${AIRWALLEX_CONFIG.apiBaseUrl}/api/v1/pa/payment_intents/${paymentIntentId}/confirm`,
      confirmData,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );

    res.json({
      status: response.data.status,
      next_action: response.data.next_action,
      payment_intent_id: response.data.id,
    });
  } catch (error) {
    console.error('❌ Error confirming payment:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Payment confirmation failed',
      details: error.response?.data || error.message,
    });
  }
});

// --- Get Payment Status ---
app.get('/api/payment-status/:paymentIntentId', async (req, res) => {
  try {
    const { paymentIntentId } = req.params;
    const token = await getAirwallexToken();

    const response = await axios.get(
      `${AIRWALLEX_CONFIG.apiBaseUrl}/api/v1/pa/payment_intents/${paymentIntentId}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    res.json({
      status: response.data.status,
      amount: response.data.amount,
      currency: response.data.currency,
      created_at: response.data.created_at,
      updated_at: response.data.updated_at,
    });
  } catch (error) {
    console.error('❌ Error getting payment status:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Failed to get payment status',
      details: error.response?.data || error.message,
    });
  }
});

// --- Webhook Endpoint ---
app.post('/api/webhooks/payment', async (req, res) => {
  try {
    const event = req.body;
    console.log('📦 Webhook received:', event.type);

    switch (event.type) {
      case 'payment_intent.succeeded':
        console.log(`✅ Payment success for ${event.data.id}`);
        break;
      case 'payment_intent.failed':
        console.log(`❌ Payment failed for ${event.data.id}`);
        break;
      case 'payment_intent.canceled':
        console.log(`⚠️ Payment canceled for ${event.data.id}`);
        break;
      default:
        console.log(`Unhandled event: ${event.type}`);
    }

    res.json({ received: true });
  } catch (error) {
    console.error('❌ Error processing webhook:', error.message);
    res.status(500).json({ error: 'Webhook error' });
  }
});

// --- Health Check ---
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    service: 'VinProof Payment API',
    environment: process.env.AIRWALLEX_ENV || 'demo',
    timestamp: new Date().toISOString(),
  });
});

// --- Global Error & 404 ---
app.use((req, res) => res.status(404).json({ error: 'Endpoint not found' }));
app.use((err, req, res, next) => {
  console.error('Unhandled Error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// --- Start Server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
