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

// Get Airwallex Authentication Token
async function getAirwallexToken() {
    try {
        const response = await fetch(`${AIRWALLEX_CONFIG.BASE_URL}/api/v1/authentication/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                client_id: AIRWALLEX_CONFIG.CLIENT_ID,
                api_key: AIRWALLEX_CONFIG.API_KEY
            })
        });

        if (!response.ok) {
            throw new Error(`Authentication failed: ${response.status}`);
        }

        const data = await response.json();
        return data.token;
    } catch (error) {
        console.error('Airwallex authentication error:', error);
        throw error;
    }
}

// Create payment intent with proper authentication
app.post('/api/create-payment-intent', async (req, res) => {
    try {
        const { amount, currency, plan, vin, orderId, customer } = req.body;

        console.log('💰 Payment Intent Request:', {
            amount: amount,
            currency: currency,
            plan: plan,
            vin: vin,
            orderId: orderId,
            customer: customer.email
        });

        // Validate required fields
        if (!amount || !customer || !customer.email) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // Check if Airwallex credentials are configured
        if (!AIRWALLEX_CONFIG.API_KEY || !AIRWALLEX_CONFIG.CLIENT_ID) {
            console.log('⚠️ Airwallex credentials not configured - using simulation mode');
            return createSimulatedPaymentIntent(req, res);
        }

        // REAL AIRWALLEX INTEGRATION
        try {
            const token = await getAirwallexToken();
            
            const paymentIntent = await createAirwallexPaymentIntent(amount, currency, customer, plan, vin, orderId, token);

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
                created_at: new Date().toISOString(),
                simulation: false
            };

            paymentIntents.push(localPaymentIntent);

            console.log('💰 REAL Payment Intent Created:', {
                paymentIntentId: paymentIntent.id,
                amount: amount,
                customer: customer.email
            });

            res.json(localPaymentIntent);

        } catch (airwallexError) {
            console.error('Airwallex API Error:', airwallexError);
            // Fallback to simulation mode
            return createSimulatedPaymentIntent(req, res);
        }

    } catch (error) {
        console.error('Error creating payment intent:', error);
        res.status(500).json({ 
            error: 'Failed to create payment intent',
            details: error.message 
        });
    }
});

// Create Airwallex Payment Intent
async function createAirwallexPaymentIntent(amount, currency, customer, plan, vin, orderId, token) {
    const response = await fetch(`${AIRWALLEX_CONFIG.BASE_URL}/api/v1/pa/payment_intents/create`, {
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
            metadata: {
                plan: plan,
                vin: vin,
                order_id: orderId
            },
            request_id: `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
        })
    });

    if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || `Airwallex API error: ${response.status}`);
    }

    return await response.json();
}

// Confirm payment with Airwallex
app.post('/api/confirm-payment', async (req, res) => {
    try {
        const { paymentIntentId, paymentMethod } = req.body;

        console.log('🔐 Payment Confirmation Request:', {
            paymentIntentId: paymentIntentId,
            cardLast4: paymentMethod.card.number.slice(-4),
            customer: paymentMethod.billing.email
        });

        // Find the payment intent
        const paymentIntent = paymentIntents.find(pi => pi.id === paymentIntentId);
        if (!paymentIntent) {
            return res.status(404).json({ error: 'Payment intent not found' });
        }

        // Validate card details
        const validationError = validateCardDetails(paymentMethod.card);
        if (validationError) {
            return res.status(400).json({ error: validationError });
        }

        // Check if we have Airwallex credentials
        if (!AIRWALLEX_CONFIG.API_KEY || !AIRWALLEX_CONFIG.CLIENT_ID) {
            console.log('🔐 SIMULATION Payment Processing');
            return processSimulatedPayment(paymentIntent, paymentMethod, res);
        }

        // REAL AIRWALLEX PAYMENT PROCESSING
        try {
            const token = await getAirwallexToken();
            const paymentResult = await confirmAirwallexPayment(paymentIntentId, paymentMethod, token);

            if (paymentResult.status === 'SUCCEEDED') {
                // Store successful payment
                const paymentRecord = {
                    id: paymentResult.id,
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

                console.log('✅ REAL Payment Successful:', {
                    paymentId: paymentResult.id,
                    amount: paymentIntent.amount,
                    customer: paymentIntent.customer.email
                });

                return res.json({
                    id: paymentResult.id,
                    status: 'succeeded',
                    amount: paymentIntent.amount,
                    currency: paymentIntent.currency,
                    payment_method: 'card',
                    card_last4: paymentMethod.card.number.slice(-4),
                    timestamp: new Date().toISOString()
                });
            } else {
                console.log('❌ Payment Failed:', paymentResult);
                return res.status(400).json({ 
                    error: 'Payment processing failed',
                    status: paymentResult.status
                });
            }
        } catch (airwallexError) {
            console.error('Airwallex Payment Error:', airwallexError);
            return res.status(500).json({ 
                error: 'Payment gateway error',
                details: airwallexError.message 
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

// Confirm Airwallex Payment
async function confirmAirwallexPayment(paymentIntentId, paymentMethod, token) {
    const response = await fetch(`${AIRWALLEX_CONFIG.BASE_URL}/api/v1/pa/payment_intents/${paymentIntentId}/confirm`, {
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
            metadata: paymentMethod.metadata,
            request_id: `confirm_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
        })
    });

    if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || `Airwallex confirmation error: ${response.status}`);
    }

    return await response.json();
}

// Simulation functions (same as before)
async function createSimulatedPaymentIntent(req, res) {
    const { amount, currency, plan, vin, orderId, customer } = req.body;
    
    const paymentIntent = {
        id: 'pi_sim_' + Math.random().toString(36).substr(2, 9),
        client_secret: 'pi_sim_' + Math.random().toString(36).substr(2, 9) + '_secret',
        amount: amount,
        currency: currency || 'USD',
        status: 'requires_payment_method'
    };

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
        created_at: new Date().toISOString(),
        simulation: true
    };

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

// Rest of the code remains same...
function validateCardDetails(card) {
    // Same validation function as before
    const { number, exp_month, exp_year, cvc } = card;
    const cleanNumber = number.replace(/\s/g, '');
    
    if (!cleanNumber || cleanNumber.length < 15 || cleanNumber.length > 19) {
        return 'Invalid card number';
    }

    const currentDate = new Date();
    const currentYear = currentDate.getFullYear();
    const currentMonth = currentDate.getMonth() + 1;

    if (exp_month < 1 || exp_month > 12) return 'Invalid expiry month';
    if (exp_year < currentYear || (exp_year === currentYear && exp_month < currentMonth)) return 'Card expired';
    if (!cvc || cvc.length < 3 || cvc.length > 4) return 'Invalid CVV';

    return null;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`💰 Payment Receiver running on port ${PORT}`);
    console.log(`🌐 Environment: ${process.env.AIRWALLEX_ENV || 'demo'}`);
    
    if (!process.env.AIRWALLEX_API_KEY || !process.env.AIRWALLEX_CLIENT_ID) {
        console.log('⚠️  SIMULATION MODE: Airwallex credentials not found');
        console.log('💡 Add AIRWALLEX_API_KEY and AIRWALLEX_CLIENT_ID to environment variables for real payments');
    } else {
        console.log('✅ REAL PAYMENT MODE: Airwallex credentials configured');
    }
});