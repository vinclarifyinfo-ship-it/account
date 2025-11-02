import express from "express";
import axios from "axios";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

// ✅ Replace this with your live Airwallex API Key
const AIRWALLEX_API_KEY = "3a87b90852bfe38eaba7c024e49e6ae83cefacd8fab6615fba5581a2f8299eab5795c7e0a3c78dcee5029c0dec03d524";

// ✅ Airwallex Base URL
const AIRWALLEX_BASE_URL = "https://api.airwallex.com/api/v1";

app.post("/create-hpp", async (req, res) => {
  try {
    const { amount, currency = "USD", name, email, return_url } = req.body;

    if (!amount || !name || !email) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // 1️⃣ Create Payment Intent
    const paymentIntentResponse = await axios.post(
      `${AIRWALLEX_BASE_URL}/pa/payment_intents/create`,
      {
        request_id: `req_${Date.now()}`,
        amount,
        currency,
        merchant_order_id: `order_${Date.now()}`,
        payment_method_types: ["card"],
        customer: { name, email },
        metadata: { source: "VIN Certification" },
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${AIRWALLEX_API_KEY}`,
        },
      }
    );

    // ✅ Log response for debugging
    console.log("Payment Intent Response:", paymentIntentResponse.data);

    // 2️⃣ Create Hosted Payment Page (HPP)
    const hppResponse = await axios.post(
      `${AIRWALLEX_BASE_URL}/pa/hosted_payment_page/create`,
      {
        request_id: `hpp_${Date.now()}`,
        payment_intent_id: paymentIntentResponse.data.id,
        merchant_order_id: paymentIntentResponse.data.merchant_order_id,
        return_url: return_url || "https://vincertification.com/thankyou",
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${AIRWALLEX_API_KEY}`,
        },
      }
    );

    console.log("HPP Response:", hppResponse.data);

    res.json({ url: hppResponse.data.url });
  } catch (error) {
    // ✅ Better error logging
    if (error.response) {
      console.error("Airwallex API Error:", {
        status: error.response.status,
        headers: error.response.headers,
        data: error.response.data,
      });
      return res.status(error.response.status).json({ error: error.response.data });
    } else {
      console.error("Unexpected Error:", error.message);
      return res.status(500).json({ error: error.message });
    }
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
