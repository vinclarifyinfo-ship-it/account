const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Store payments in memory (in production, use database)
let payments = [];
let paymentIntents = [];

// Airwallex API Configuration
const AIRWALLEX_CONFIG = {
    BASE_URL: process.env.AIRWALLEX_ENV === 'production' 
        ? 'https://api.airwallex.com' 
        : 'https://api-demo.airwallex.com',
    API_KEY: process.env.AIRWALLEX_API_KEY,
    CLIENT_ID: process.env.AIRWALLEX_CLIENT_ID
};

// Health check
app.get('/', (req, res) => {
  res.json({ 
    message: 'TrueCarvin Payment Receiver API - LIVE',
    status: 'Running',
    environment: process.env.AIRWALLEX_ENV || 'demo',
    timestamp: new Date().toISOString()
  });
});

// Create payment intent endpoint - REAL AIRWALLEX INTEGRATION
app.post('/api/create-payment-intent', async (req, res) => {
    try {
        const { amount, currency, plan, vin, orderId, customer } = req.body;

        // Validate required fields
        if (!amount || !customer || !customer.email) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // Create payment intent with Airwallex
        const paymentIntent = await createAirwallexPaymentIntent({
            amount: Math.round(amount), // Ensure integer
            currency: currency || 'USD',
            customer: {
                email: customer.email,
                first_name: customer.firstName,
                last_name: customer.lastName
            },
            metadata: {
                plan: plan,
                vin: vin,
                order_id: orderId
            }
        });

        // Store payment intent locally
        const localPaymentIntent = {
            id: paymentIntent.id,
            client_secret: paymentIntent.client_secret,
            amount: amount,
            currency: currency || 'USD',
            status: paymentIntent.status,
            plan: plan,
            vin: vin,
            orderId: orderId,
            customer: customer,
            created_at: new Date().toISOString()
        };

        paymentIntents.push(localPaymentIntent);

        console.log('💰 REAL Payment Intent Created:', {
            orderId: orderId,
            amount: amount,
            plan: plan,
            vin: vin,
            customer: customer.email,
            paymentIntentId: paymentIntent.id,
            status: paymentIntent.status
        });

        res.json(localPaymentIntent);

    } catch (error) {
        console.error('Error creating payment intent:', error);
        res.status(500).json({ 
            error: 'Failed to create payment intent',
            details: error.message 
        });
    }
});

// Confirm payment endpoint - REAL AIRWALLEX PAYMENT PROCESSING
app.post('/api/confirm-payment', async (req, res) => {
    try {
        const { paymentIntentId, paymentMethod } = req.body;

        console.log('🔐 REAL Payment Confirmation Request:', {
            paymentIntentId: paymentIntentId,
            cardLast4: paymentMethod.card.number.slice(-4),
            customer: paymentMethod.billing.email,
            timestamp: new Date().toISOString()
        });

        // Validate card details
        const validationError = validateCardDetails(paymentMethod.card);
        if (validationError) {
            return res.status(400).json({ error: validationError });
        }

        // Confirm payment with Airwallex
        const paymentResult = await confirmAirwallexPayment(paymentIntentId, paymentMethod);

        if (paymentResult.status === 'SUCCEEDED' || paymentResult.status === 'REQUIRES_CAPTURE') {
            // Store successful payment
            const paymentRecord = {
                id: paymentResult.id,
                payment_intent_id: paymentIntentId,
                status: paymentResult.status.toLowerCase(),
                amount: paymentResult.amount,
                currency: paymentResult.currency,
                plan: paymentMethod.metadata?.plan,
                vin: paymentMethod.metadata?.vin,
                order_id: paymentMethod.metadata?.order_id,
                customer_email: paymentMethod.billing.email,
                card_last4: paymentMethod.card.number.slice(-4),
                payment_method: paymentResult.payment_method?.type,
                created_at: new Date().toISOString()
            };

            payments.push(paymentRecord);

            console.log('✅ REAL Payment Successful:', {
                paymentId: paymentResult.id,
                paymentIntentId: paymentIntentId,
                amount: paymentResult.amount,
                customer: paymentMethod.billing.email,
                status: paymentResult.status,
                timestamp: new Date().toISOString()
            });

            res.json({
                id: paymentResult.id,
                status: 'succeeded',
                amount: paymentResult.amount,
                currency: paymentResult.currency,
                payment_method: 'card',
                card_last4: paymentMethod.card.number.slice(-4),
                timestamp: new Date().toISOString()
            });
        } else {
            console.log('❌ Payment Failed:', paymentResult);
            res.status(400).json({ 
                error: 'Payment processing failed',
                status: paymentResult.status,
                decline_code: paymentResult.last_payment_error?.code
            });
        }

    } catch (error) {
        console.error('Error confirming payment:', error);
        res.status(500).json({ 
            error: 'Failed to confirm payment',
            details: error.message 
        });
    }
});

// ======================= AIRWALLEX API FUNCTIONS =======================

// Create payment intent with Airwallex
async function createAirwallexPaymentIntent(paymentData) {
    const response = await fetch(`${AIRWALLEX_CONFIG.BASE_URL}/api/v1/pa/payment_intents/create`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${AIRWALLEX_CONFIG.API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            amount: paymentData.amount,
            currency: paymentData.currency,
            merchant_order_id: `order_${Date.now()}`,
            customer: paymentData.customer,
            metadata: paymentData.metadata,
            request_id: `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
        })
    });

    if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Failed to create payment intent with Airwallex');
    }

    return await response.json();
}

// Confirm payment with Airwallex
async function confirmAirwallexPayment(paymentIntentId, paymentMethod) {
    const response = await fetch(`${AIRWALLEX_CONFIG.BASE_URL}/api/v1/pa/payment_intents/${paymentIntentId}/confirm`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${AIRWALLEX_CONFIG.API_KEY}`,
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
            metadata: paymentMethod.metadata,
            request_id: `confirm_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
        })
    });

    if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Failed to confirm payment with Airwallex');
    }

    return await response.json();
}

// Validate card details
function validateCardDetails(card) {
    const { number, exp_month, exp_year, cvc } = card;

    // Check card number
    const cleanNumber = number.replace(/\s/g, '');
    if (!cleanNumber || cleanNumber.length < 15 || cleanNumber.length > 19) {
        return 'Invalid card number';
    }

    // Check expiry
    const currentDate = new Date();
    const currentYear = currentDate.getFullYear();
    const currentMonth = currentDate.getMonth() + 1;

    if (exp_month < 1 || exp_month > 12) {
        return 'Invalid expiry month (01-12)';
    }

    if (exp_year < currentYear || (exp_year === currentYear && exp_month < currentMonth)) {
        return 'Card has expired';
    }

    // Check CVV
    if (!cvc || cvc.length < 3 || cvc.length > 4) {
        return 'Invalid CVV (3-4 digits required)';
    }

    return null; // No error
}

// Payment webhook endpoint
app.post('/api/webhook/airwallex', (req, res) => {
    try {
        const webhookData = req.body;
        
        console.log('🔔 Airwallex Webhook Received:', {
            type: webhookData.type,
            id: webhookData.id,
            timestamp: new Date().toISOString()
        });

        // Handle different webhook events
        switch (webhookData.type) {
            case 'payment_intent.succeeded':
                handleSuccessfulPayment(webhookData.data);
                break;
            case 'payment_intent.failed':
                handleFailedPayment(webhookData.data);
                break;
            case 'payment_intent.canceled':
                handleCanceledPayment(webhookData.data);
                break;
            default:
                console.log('Unknown webhook type:', webhookData.type);
        }

        res.status(200).json({ received: true });
        
    } catch (error) {
        console.error('Webhook error:', error);
        res.status(400).json({ error: 'Webhook processing failed' });
    }
});

// Other endpoints (same as before)
app.get('/api/payment/:paymentId', (req, res) => {
    const paymentId = req.params.paymentId;
    const payment = payments.find(p => p.id === paymentId);
    if (!payment) return res.status(404).json({ error: 'Payment not found' });
    res.json(payment);
});

app.get('/api/payment/order/:orderId', (req, res) => {
    const orderId = req.params.orderId;
    const payment = payments.find(p => p.order_id === orderId);
    if (!payment) return res.status(404).json({ error: 'Payment not found for this order' });
    res.json(payment);
});

app.get('/api/payments', (req, res) => {
    res.json({ total: payments.length, payments: payments });
});

app.get('/api/payment-intents', (req, res) => {
    res.json({ total: paymentIntents.length, payment_intents: paymentIntents });
});

function handleSuccessfulPayment(paymentData) {
    const paymentRecord = {
        id: paymentData.id,
        status: 'succeeded',
        amount: paymentData.amount,
        currency: paymentData.currency,
        created_at: new Date().toISOString(),
        metadata: paymentData.metadata || {}
    };
    payments.push(paymentRecord);
    console.log('✅ Webhook Payment Successful:', { id: paymentData.id, amount: paymentData.amount });
}

function handleFailedPayment(paymentData) {
    console.log('❌ Webhook Payment Failed:', { 
        id: paymentData.id, 
        error: paymentData.last_payment_error 
    });
}

function handleCanceledPayment(paymentData) {
    console.log('⚠️ Webhook Payment Canceled:', { id: paymentData.id });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`💰 REAL Payment Receiver running on port ${PORT}`);
    console.log(`🌐 Environment: ${process.env.AIRWALLEX_ENV || 'demo'}`);
    console.log(`🔗 Health check: http://localhost:${PORT}/`);
});