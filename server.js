// server.js
// ✅ Fully working Airwallex backend with correct amount handling and fallback

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();
const app = express();

app.use(cors());
app.use(express.json());

// Local memory (temporary, not database)
let paymentIntents = [];
let payments = [];

// ===================
// 🔧 Airwallex Config
// ===================
const AIRWALLEX_CONFIG = {
  BASE_URL:
    process.env.AIRWALLEX_ENV === "production"
      ? "https://api.airwallex.com"
      : "https://api-demo.airwallex.com",
  API_KEY: process.env.AIRWALLEX_API_KEY,
  CLIENT_ID: process.env.AIRWALLEX_CLIENT_ID,
};

console.log("⚙️ Airwallex Config:", {
  BASE_URL: AIRWALLEX_CONFIG.BASE_URL,
  CLIENT_ID_SNIPPET: AIRWALLEX_CONFIG.CLIENT_ID
    ? `${AIRWALLEX_CONFIG.CLIENT_ID.slice(0, 6)}...${AIRWALLEX_CONFIG.CLIENT_ID.slice(-4)}`
    : null,
});

// ===============================
// 🪄 Helper to safely parse JSON
// ===============================
async function safeReadResponse(response) {
  const text = await response.text().catch(() => "");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ===============================
// 🔑 Get Airwallex Auth Token
// ===============================
async function getAirwallexToken() {
  const url = `${AIRWALLEX_CONFIG.BASE_URL}/api/v1/authentication/login`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-client-id": AIRWALLEX_CONFIG.CLIENT_ID,
      "x-api-key": AIRWALLEX_CONFIG.API_KEY,
    },
    body: JSON.stringify({}),
  });

  if (!response.ok) {
    const err = await safeReadResponse(response);
    console.error("❌ Airwallex Auth Failed:", err);
    throw new Error("Authentication failed");
  }

  const data = await response.json();
  const token = data.token || data.access_token || data.data?.token;
  if (!token) throw new Error("Auth success but token missing");
  return token;
}

// ===============================
// 💳 Create Payment Intent
// ===============================
app.post("/api/create-payment-intent", async (req, res) => {
  try {
    const { amount, currency, plan, vin, orderId, customer } = req.body;

    if (!amount || !customer?.email) {
      return res.status(400).json({ error: "Missing amount or customer info" });
    }

    console.log("💰 Creating Payment Intent:", { amount, currency, plan, vin });

    // Get Token
    const token = await getAirwallexToken();

    // Create Payment Intent
    const url = `${AIRWALLEX_CONFIG.BASE_URL}/api/v1/pa/payment_intents/create`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: Math.round(amount * 100), // convert $ → cents ✅ FIXED
        currency: currency || "USD",
        merchant_order_id: orderId || `order_${Date.now()}`,
        customer: {
          email: customer.email,
          first_name: customer.firstName || "Guest",
          last_name: customer.lastName || "User",
        },
        metadata: { plan, vin, order_id: orderId },
        request_id: `req_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      }),
    });

    if (!response.ok) {
      const err = await safeReadResponse(response);
      console.error("❌ Airwallex Create Intent Error:", err);
      throw new Error(err.message || "Airwallex Intent creation failed");
    }

    const intent = await response.json();

    const localIntent = {
      id: intent.id,
      client_secret: intent.client_secret,
      amount,
      currency: currency || "USD",
      plan,
      vin,
      orderId,
      customer,
      status: intent.status || "requires_payment_method",
      created_at: new Date().toISOString(),
    };

    paymentIntents.push(localIntent);
    console.log("✅ Payment Intent Created:", { id: intent.id, amount });

    res.json(localIntent);
  } catch (err) {
    console.error("⚠️ Error creating intent:", err.message);
    res.status(500).json({ error: err.message || "Failed to create payment intent" });
  }
});

// ===============================
// 🔐 Confirm Payment
// ===============================
app.post("/api/confirm-payment", async (req, res) => {
  try {
    const { paymentIntentId, paymentMethod } = req.body;

    if (!paymentIntentId || !paymentMethod) {
      return res.status(400).json({ error: "Missing paymentIntentId or paymentMethod" });
    }

    const paymentIntent = paymentIntents.find((p) => p.id === paymentIntentId);
    if (!paymentIntent) return res.status(404).json({ error: "Payment intent not found" });

    console.log("🔐 Confirming Payment:", { paymentIntentId });

    const token = await getAirwallexToken();

    const url = `${AIRWALLEX_CONFIG.BASE_URL}/api/v1/pa/payment_intents/${paymentIntentId}/confirm`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        payment_method: {
          type: "card",
          card: {
            number: paymentMethod.card.number.replace(/\s/g, ""),
            expiry_month: String(paymentMethod.card.exp_month).padStart(2, "0"),
            expiry_year: String(paymentMethod.card.exp_year),
            cvc: paymentMethod.card.cvc,
            name: `${paymentMethod.billing.first_name} ${paymentMethod.billing.last_name}`,
          },
        },
        billing: {
          first_name: paymentMethod.billing.first_name,
          last_name: paymentMethod.billing.last_name,
          email: paymentMethod.billing.email,
        },
        request_id: `confirm_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      }),
    });

    const result = await safeReadResponse(response);

    if (!response.ok) {
      console.error("❌ Payment Confirmation Failed:", result);
      throw new Error(result.message || "Payment confirmation failed");
    }

    const paymentStatus =
      (result.status || result.payment_status || "").toUpperCase();

    if (["SUCCEEDED", "SUCCESS", "CAPTURED"].includes(paymentStatus)) {
      const record = {
        id: result.id || `pay_${Date.now()}`,
        status: "succeeded",
        amount: paymentIntent.amount,
        currency: paymentIntent.currency,
        plan: paymentIntent.plan,
        vin: paymentIntent.vin,
        orderId: paymentIntent.orderId,
        customer_email: paymentIntent.customer.email,
        created_at: new Date().toISOString(),
      };
      payments.push(record);
      console.log("✅ Payment Succeeded:", record);
      res.json(record);
    } else {
      console.error("❌ Payment Failed:", result);
      res.status(400).json({ error: "Payment failed", details: result });
    }
  } catch (err) {
    console.error("⚠️ Confirm Payment Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===============================
// 🚀 Start Server
// ===============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`💰 Airwallex backend running on port ${PORT}`);
});
