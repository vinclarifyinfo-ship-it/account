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
            return res.status(400).json({ error: 'Missing required fields: amount and customer email are required' });
        }

        // Check if Airwallex API keys are configured
        if (!process.env.AIRWALLEX_API_KEY) {
            console.log('⚠️ Airwallex API key not configured - using simulation mode');
            
            // SIMULATION MODE - For testing without API keys
            const paymentIntent = {
                id: 'pi_sim_' + Math.random().toString(36).substr(2, 9),
                client_secret: 'pi_sim_' + Math.random().toString(36).substr(2, 9) + '_secret',
                amount: amount,
                currency: currency || 'USD',
                status: 'requires_payment_method'
            };

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
                simulation: true
            };

            paymentIntents.push(localPaymentIntent);

            console.log('💰 SIMULATION Payment Intent Created:', {
                paymentIntentId: paymentIntent.id,
                amount: amount,
                customer: customer.email
            });

            return res.json(localPaymentIntent);
        }

        // REAL AIRWALLEX INTEGRATION
        try {
            const paymentIntent = await createAirwallexPaymentIntent({
                amount: Math.round(amount),
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
                created_at: new Date().toISOString(),
                simulation: false
            };

            paymentIntents.push(localPaymentIntent);

            console.log('💰 REAL Payment Intent Created:', {
                paymentIntentId: paymentIntent.id,
                amount: amount,
                customer: customer.email,
                status: paymentIntent.status
            });

            res.json(localPaymentIntent);

        } catch (airwallexError) {
            console.error('Airwallex API Error:', airwallexError);
            throw new Error('Airwallex service unavailable: ' + airwallexError.message);
        }

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

        console.log('🔐 Payment Confirmation Request:', {
            paymentIntentId: paymentIntentId,
            cardLast4: paymentMethod.card.number.slice(-4),
            customer: paymentMethod.billing.email,
            timestamp: new Date().toISOString()
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

        // Check if we're in simulation mode
        if (paymentIntent.simulation) {
            console.log('🔐 SIMULATION Payment Processing');
            
            // SIMULATION MODE - Always succeed for testing
            const paymentResult = await processSimulatedPayment(paymentIntent, paymentMethod);
            
            if (paymentResult.status === 'succeeded') {
                // Store successful payment
                const paymentRecord = {
                    id: 'pay_sim_' + Math.random().toString(36).substr(2, 9),
                    payment_intent_id: paymentIntentId,
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

                console.log('✅ SIMULATION Payment Successful:', {
                    paymentId: paymentRecord.id,
                    amount: paymentIntent.amount,
                    customer: paymentIntent.customer.email
                });

                return res.json(paymentResult);
            }
        }

        // REAL AIRWALLEX PAYMENT PROCESSING
        if (process.env.AIRWALLEX_API_KEY) {
            try {
                const paymentResult = await confirmAirwallexPayment(paymentIntentId, paymentMethod);

                if (paymentResult.status === 'SUCCEEDED' || paymentResult.status === 'REQUIRES_CAPTURE') {
                    // Store successful payment
                    const paymentRecord = {
                        id: paymentResult.id,
                        payment_intent_id: paymentIntentId,
                        status: paymentResult.status.toLowerCase(),
                        amount: paymentResult.amount,
                        currency: paymentResult.currency,
                        plan: paymentIntent.plan,
                        vin: paymentIntent.vin,
                        order_id: paymentIntent.orderId,
                        customer_email: paymentIntent.customer.email,
                        card_last4: paymentMethod.card.number.slice(-4),
                        payment_method: paymentResult.payment_method?.type,
                        simulation: false,
                        created_at: new Date().toISOString()
                    };

                    payments.push(paymentRecord);

                    console.log('✅ REAL Payment Successful:', {
                        paymentId: paymentResult.id,
                        amount: paymentResult.amount,
                        customer: paymentIntent.customer.email,
                        status: paymentResult.status
                    });

                    return res.json({
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
                    return res.status(400).json({ 
                        error: 'Payment processing failed',
                        status: paymentResult.status,
                        decline_code: paymentResult.last_payment_error?.code
                    });
                }
            } catch (airwallexError) {
                console.error('Airwallex Payment Error:', airwallexError);
                return res.status(500).json({ 
                    error: 'Payment gateway error',
                    details: airwallexError.message 
                });
            }
        } else {
            return res.status(500).json({ error: 'Payment gateway not configured' });
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
    const AIRWALLEX_CONFIG = {
        BASE_URL: process.env.AIRWALLEX_ENV === 'production' 
            ? 'https://api.airwallex.com' 
            : 'https://api-demo.airwallex.com',
        API_KEY: process.env.AIRWALLEX_API_KEY
    };

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
        throw new Error(errorData.message || `Airwallex API error: ${response.status}`);
    }

    return await response.json();
}

// Confirm payment with Airwallex
async function confirmAirwallexPayment(paymentIntentId, paymentMethod) {
    const AIRWALLEX_CONFIG = {
        BASE_URL: process.env.AIRWALLEX_ENV === 'production' 
            ? 'https://api.airwallex.com' 
            : 'https://api-demo.airwallex.com',
        API_KEY: process.env.AIRWALLEX_API_KEY
    };

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
        throw new Error(errorData.message || `Airwallex confirmation error: ${response.status}`);
    }

    return await response.json();
}

// Simulated payment processing (for testing without API keys)
async function processSimulatedPayment(paymentIntent, paymentMethod) {
    return new Promise((resolve) => {
        // Simulate payment processing delay
        setTimeout(() => {
            resolve({
                id: 'pay_sim_' + Math.random().toString(36).substr(2, 9),
                status: 'succeeded',
                amount: paymentIntent.amount,
                currency: paymentIntent.currency,
                payment_method: 'card',
                card_last4: paymentMethod.card.number.slice(-4),
                timestamp: new Date().toISOString(),
                simulation: true
            });
        }, 2000);
    });
}

// Validate card details
function validateCardDetails(card) {
    const { number, exp_month, exp_year, cvc } = card;

    // Check card number
    const cleanNumber = number.replace(/\s/g, '');
    if (!cleanNumber || cleanNumber.length < 15 || cleanNumber.length > 19) {
        return 'Invalid card number (must be 15-19 digits)';
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

// Other endpoints remain the same...
app.post('/api/webhook/airwallex', (req, res) => {
    try {
        const webhookData = req.body;
        console.log('🔔 Airwallex Webhook Received:', webhookData.type);
        res.status(200).json({ received: true });
    } catch (error) {
        console.error('Webhook error:', error);
        res.status(400).json({ error: 'Webhook processing failed' });
    }
});

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`💰 Payment Receiver running on port ${PORT}`);
    console.log(`🌐 Environment: ${process.env.AIRWALLEX_ENV || 'demo'}`);
    console.log(`🔗 Health check: http://localhost:${PORT}/`);
    console.log(`💳 Create payment intent: http://localhost:${PORT}/api/create-payment-intent`);
    console.log(`✅ Confirm payment: http://localhost:${PORT}/api/confirm-payment`);
    
    if (!process.env.AIRWALLEX_API_KEY) {
        console.log('⚠️  SIMULATION MODE: No Airwallex API key found');
        console.log('💡 Add AIRWALLEX_API_KEY to environment variables for real payments');
    } else {
        console.log('✅ REAL PAYMENT MODE: Airwallex API key configured');
    }
});