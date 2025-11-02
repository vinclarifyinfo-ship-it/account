import express from "express";
import axios from "axios";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const AIRWALLEX_API_KEY = "YOUR_API_KEY";
const AIRWALLEX_BASE_URL = "https://api.airwallex.com/api/v1";

app.post("/create-hpp", async (req, res) => {
  try {
    const { amount, currency, name, email, return_url } = req.body;

    const response = await axios.post(
      `${AIRWALLEX_BASE_URL}/pa/payment_intents/create`,
      {
        request_id: `req_${Date.now()}`,
        amount: amount,
        currency: currency || "USD",
        merchant_order_id: `order_${Date.now()}`,
        payment_method_types: ["card"], // ✅ Correct usage
        customer: {
          email,
          name,
        },
        metadata: {
          source: "VIN Certification",
        },
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${AIRWALLEX_API_KEY}`,
        },
      }
    );

    // ✅ Now create Hosted Payment Page for that Payment Intent
    const hppResponse = await axios.post(
      `${AIRWALLEX_BASE_URL}/pa/hosted_payment_page/create`,
      {
        request_id: `hpp_${Date.now()}`,
        payment_intent_id: response.data.id,
        merchant_order_id: response.data.merchant_order_id,
        return_url: return_url || "https://vincertification.com/thankyou",
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${AIRWALLEX_API_KEY}`,
        },
      }
    );

    res.json({ url: hppResponse.data.url });
  } catch (error) {
    console.error("Create HPP failed:", error.response?.data || error.message);
    res.status(400).json({
      error: error.response?.data || error.message,
    });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
