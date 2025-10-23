// server.js (with HPP fallback)
const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

let payments = [];
let paymentIntents = [];

// Airwallex Configuration
const AIRWALLEX_CONFIG = {
    BASE_URL: process.env.AIRWALLEX_ENV === 'production'
        ? 'https://api.airwallex.com'
        : 'https://api-demo.airwallex.com',
    API_KEY: process.env.AIRWALLEX_API_KEY,
    CLIENT_ID: process.env.AIRWALLEX_CLIENT_ID
};

console.log('🔎 Airwallex config:', {
    BASE_URL: AIRWALLEX_CONFIG.BASE_URL,
    CLIENT_ID_SNIPPET: AIRWALLEX_CONFIG.CLIENT_ID ? `${AIRWALLEX_CONFIG.CLIENT_ID.slice(0,6)}...${AIRWALLEX_CONFIG.CLIENT_ID.slice(-4)}` : null,
    USING_REAL_KEYS: !!(AIRWALLEX_CONFIG.API_KEY && AIRWALLEX_CONFIG.CLIENT_ID)
});

// Helper to read response safely
async function safeReadResponse(response) {
    const text = await response.text().catch(() => '');
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

// Get Airwallex Authentication Token
async function getAirwallexToken() {
    try {
        const url = `${AIRWALLEX_CONFIG.BASE_URL}/api/v1/authentication/login`;
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-client-id': AIRWALLEX_CONFIG.CLIENT_ID,
                'x-api-key': AIRWALLEX_CONFIG.API_KEY
            },
            body: JSON.stringify({})
        });

        if (!response.ok) {
            const body = await safeReadResponse(response);
            console.error('❌ Airwallex auth failed response:', {
                status: response.status,
                body
            });
            throw new Error(`Authentication failed: ${response.status} - ${typeof body === 'string' ? body : JSON.stringify(body)}`);
        }

        const data = await response.json();
        const token = data && (data.token || data.access_token || data.data && data.data.token);
        if (!token) {
            console.error('❌ Airwallex auth succeeded but token missing:', data);
            throw new Error('Authentication succeeded but token missing in response');
        }

        console.log('✅ Airwallex token generated');
        return token;
    } catch (error) {
        console.error('Airwallex authentication error:', error.message || error);
        throw error;
    }
}

// Create payment intent
app.post('/api/create-payment-intent', async (req, res) => {
    try {
        const { amount, currency, plan, vin, orderId, customer } = req.body;

        console.log('💰 Payment Intent Request:', {
            amount, currency, plan, vin, orderId, customer: customer && customer.email
        });

        if (!amount || !customer || !customer.email) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // Simulation if missing credentials
        if (!AIRWALLEX_CONFIG.API_KEY || !AIRWALLEX_CONFIG.CLIENT_ID) {
            console.log('⚠️ Airwallex credentials not configured - using simulation mode');
            return createSimulatedPaymentIntent(req, res);
        }

        try {
            const token = await getAirwallexToken();
            const paymentIntent = await createAirwallexPaymentIntent(amount, currency, customer, plan, vin, orderId, token);

            const localPaymentIntent = {
                id: paymentIntent.id,
                client_secret: paymentIntent.client_secret,
                amount,
                currency: currency || 'USD',
                status: paymentIntent.status,
                plan,
                vin,
                orderId,
                customer,
                created_at: new Date().toISOString(),
                simulation: false
            };
            paymentIntents.push(localPaymentIntent);

            console.log('💰 REAL Payment Intent Created:', {
                paymentIntentId: paymentIntent.id,
                amount,
                customer: customer.email
            });

            res.json(localPaymentIntent);
        } catch (airwallexError) {
            console.error('Airwallex API Error (create intent):', airwallexError.message || airwallexError);

            // 3️⃣ Hosted Payment Page Fallback
            try {
                const token = await getAirwallexToken();
                const hppUrl = `${AIRWALLEX_CONFIG.BASE_URL}/api/v1/pa/payment_intents/create`;
                const hppResponse = await fetch(hppUrl, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        amount: Math.round(amount),
                        currency: currency || 'USD',
                        merchant_order_id: orderId || `order_${Date.now()}`,
                        customer: {
                            email: customer.email,
                            first_name: customer.firstName,
                            last_name: customer.lastName
                        },
                        metadata: { plan, vin, order_id: orderId },
                        request_id: `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                        payment_method: { type: 'card' },
                        next_action: {
                            type: 'redirect',
                            return_url: 'https://vinclarify.info/thankyou'
                        }
                    })
                });

                const hppData = await safeReadResponse(hppResponse);
                if (hppData.next_action && hppData.next_action.redirect_url) {
                    console.log('🌐 Hosted Payment Page Redirect URL:', hppData.next_action.redirect_url);
                    return res.json({ redirect_url: hppData.next_action.redirect_url });
                }
            } catch (hppError) {
                console.error('Hosted Payment Page fallback failed:', hppError);
            }

            // Still fallback to simulation if all else fails
            return createSimulatedPaymentIntent(req, res);
        }
    } catch (error) {
        console.error('Error creating payment intent:', error);
        res.status(500).json({ error: 'Failed to create payment intent', details: error.message });
    }
});

// Create Airwallex Payment Intent
async function createAirwallexPaymentIntent(amount, currency, customer, plan, vin, orderId, token) {
    const url = `${AIRWALLEX_CONFIG.BASE_URL}/api/v1/pa/payment_intents/create`;
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            amount: Math.round(amount),
            currency: currency || 'USD',
            merchant_order_id: orderId || `order_${Date.now()}`,
            customer: {
                email: customer.email,
                first_name: customer.firstName,
                last_name: customer.lastName
            },
            metadata: { plan, vin, order_id: orderId },
            request_id: `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
        })
    });

    if (!response.ok) {
        const errBody = await safeReadResponse(response);
        console.error('❌ createAirwallexPaymentIntent failed:', { status: response.status, body: errBody });
        throw new Error(errBody && (errBody.message || JSON.stringify(errBody)) || `Airwallex API error: ${response.status}`);
    }

    return await response.json();
}

// Confirm payment
app.post('/api/confirm-payment', async (req, res) => {
    try {
        const { paymentIntentId, paymentMethod } = req.body;

        if (!paymentIntentId || !paymentMethod) {
            return res.status(400).json({ error: 'Missing paymentIntentId or paymentMethod' });
        }

        console.log('🔐 Payment Confirmation Request:', {
            paymentIntentId,
            cardLast4: paymentMethod.card && paymentMethod.card.number ? paymentMethod.card.number.slice(-4) : null,
            customer: paymentMethod.billing && paymentMethod.billing.email ? paymentMethod.billing.email : null
        });

        const paymentIntent = paymentIntents.find(pi => pi.id === paymentIntentId);
        if (!paymentIntent) return res.status(404).json({ error: 'Payment intent not found' });

        const validationError = validateCardDetails(paymentMethod.card);
        if (validationError) return res.status(400).json({ error: validationError });

        if (!AIRWALLEX_CONFIG.API_KEY || !AIRWALLEX_CONFIG.CLIENT_ID) {
            console.log('🔐 SIMULATION Payment Processing');
            return processSimulatedPayment(paymentIntent, paymentMethod, res);
        }

        const token = await getAirwallexToken();
        const paymentResult = await confirmAirwallexPayment(paymentIntentId, paymentMethod, token);
        const status = (paymentResult.status || paymentResult.payment_status || '').toUpperCase();

        if (status === 'SUCCEEDED' || status === 'SUCCESS' || status === 'CAPTURED') {
            const paymentRecord = {
                id: paymentResult.id || `pay_${Date.now()}`,
                payment_intent_id: paymentIntentId,
                status: 'succeeded',
                amount: paymentIntent.amount,
                currency: paymentIntent.currency,
                plan: paymentIntent.plan,
                vin: paymentIntent.vin,
                order_id: paymentIntent.orderId,
                customer_email: paymentIntent.customer.email,
                card_last4: paymentMethod.card.number.slice(-4),
                simulation: false,
                created_at: new Date().toISOString()
            };
            payments.push(paymentRecord);
            console.log('✅ REAL Payment Successful:', { paymentId: paymentRecord.id, amount: paymentIntent.amount, customer: paymentIntent.customer.email });

            return res.json({
                id: paymentRecord.id,
                status: 'succeeded',
                amount: paymentIntent.amount,
                currency: paymentIntent.currency,
                payment_method: 'card',
                card_last4: paymentMethod.card.number.slice(-4),
                timestamp: new Date().toISOString()
            });
        } else {
            console.log('❌ Payment Failed/Not Succeeded:', paymentResult);
            return res.status(400).json({ error: 'Payment processing failed', status: paymentResult.status || paymentResult });
        }
    } catch (error) {
        console.error('Error confirming payment:', error);
        res.status(500).json({ error: 'Failed to confirm payment', details: error.message });
    }
});

// Confirm Airwallex Payment
async function confirmAirwallexPayment(paymentIntentId, paymentMethod, token) {
    const url = `${AIRWALLEX_CONFIG.BASE_URL}/api/v1/pa/payment_intents/${paymentIntentId}/confirm`;
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            payment_method: {
                type: 'card',
                card: {
                    number: paymentMethod.card.number.replace(/\s/g, ''),
                    expiry_month: String(paymentMethod.card.exp_month).padStart(2, '0'),
                    expiry_year: String(paymentMethod.card.exp_year),
                    cvc: paymentMethod.card.cvc,
                    name: `${paymentMethod.billing.first_name} ${paymentMethod.billing.last_name}`
                }
            },
            billing: {
                first_name: paymentMethod.billing.first_name,
                last_name: paymentMethod.billing.last_name,
                email: paymentMethod.billing.email
            },
            metadata: paymentMethod.metadata || {},
            request_id: `confirm_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
        })
    });

    if (!response.ok) {
        const errBody = await safeReadResponse(response);
        console.error('❌ confirmAirwallexPayment failed:', { status: response.status, body: errBody });
        throw new Error(errBody && (errBody.message || JSON.stringify(errBody)) || `Airwallex confirmation error: ${response.status}`);
    }

    return await response.json();
}

// --- Simulation mode handlers ---
async function createSimulatedPaymentIntent(req, res) {
    const { amount, currency, plan, vin, orderId, customer } = req.body;
    const paymentIntent = {
        id: 'pi_sim_' + Math.random().toString(36).substr(2, 9),
        client_secret: 'pi_sim_' + Math.random().toString(36).substr(2, 9) + '_secret',
        amount, currency: currency || 'USD', status: 'requires_payment_method'
    };
    const localPaymentIntent = { ...paymentIntent, plan, vin, orderId, customer, created_at: new Date().toISOString(), simulation: true };
    paymentIntents.push(localPaymentIntent);
    res.json(localPaymentIntent);
}

async function processSimulatedPayment(paymentIntent, paymentMethod, res) {
    const paymentResult = {
        id: 'pay_sim_' + Math.random().toString(36).substr(2, 9),
        status: 'succeeded',
        amount: paymentIntent.amount,
        currency: paymentIntent.currency,
        payment_method: 'card',
        card_last4: paymentMethod.card.number.slice(-4),
        timestamp: new Date().toISOString(),
        simulation: true
    };
    const paymentRecord = {
        id: paymentResult.id,
        payment_intent_id: paymentIntent.id,
        status: 'succeeded',
        amount: paymentIntent.amount,
        currency: paymentIntent.currency,
        plan: paymentIntent.plan,
        vin: paymentIntent.vin,
        order_id: paymentIntent.orderId,
        customer_email: paymentIntent.customer.email,
        card_last4: paymentMethod.card.number.slice(-4),
        simulation: true,
        created_at: new Date().toISOString()
    };
    payments.push(paymentRecord);
    res.json(paymentResult);
}

function validateCardDetails(card) {
    const { number, exp_month, exp_year, cvc } = card;
    const cleanNumber = number.replace(/\s/g, '');
    if (!cleanNumber || cleanNumber.length < 15 || cleanNumber.length > 19) return 'Invalid card number';
    const now = new Date(), y = now.getFullYear(), m = now.getMonth() + 1;
    if (exp_month < 1 || exp_month > 12) return 'Invalid expiry month';
    if (exp_year < y || (exp_year === y && exp_month < m)) return 'Card expired';
    if (!cvc || cvc.length < 3 || cvc.length > 4) return 'Invalid CVV';
    return null;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`💰 Payment Receiver running on port ${PORT}`);
    console.log(`🌐 Environment: ${process.env.AIRWALLEX_ENV || 'demo'}`);
    if (!process.env.AIRWALLEX_API_KEY || !process.env.AIRWALLEX_CLIENT_ID) {
        console.log('⚠️ SIMULATION MODE: credentials missing');
    } else console.log('✅ REAL PAYMENT MODE: Airwallex credentials configured');
});
