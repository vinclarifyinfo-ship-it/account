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

// Health check
app.get('/', (req, res) => {
  res.json({ 
    message: 'TrueCarvin Payment Receiver API',
    status: 'Running',
    timestamp: new Date().toISOString()
  });
});

// Payment webhook endpoint - Airwallex will send payment events here
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

    // Always return 200 to acknowledge receipt
    res.status(200).json({ received: true });
    
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(400).json({ error: 'Webhook processing failed' });
  }
});

// Simple payment status check
app.get('/api/payment/:paymentId', (req, res) => {
  const paymentId = req.params.paymentId;
  const payment = payments.find(p => p.id === paymentId);
  
  if (!payment) {
    return res.status(404).json({ error: 'Payment not found' });
  }
  
  res.json(payment);
});

// Create payment intent endpoint
app.post('/api/create-payment-intent', async (req, res) => {
    try {
        const { amount, currency, plan, vin, orderId, customer } = req.body;

        // In a real implementation, you would call Airwallex API here
        // For now, we'll simulate creating a payment intent
        const paymentIntent = {
            id: 'pi_' + Math.random().toString(36).substr(2, 9),
            client_secret: 'pi_' + Math.random().toString(36).substr(2, 9) + '_secret',
            amount: amount,
            currency: currency,
            status: 'requires_payment_method'
        };

        console.log('💰 Payment Intent Created:', {
            orderId: orderId,
            amount: amount,
            plan: plan,
            vin: vin,
            customer: customer.email
        });

        res.json(paymentIntent);

    } catch (error) {
        console.error('Error creating payment intent:', error);
        res.status(500).json({ error: 'Failed to create payment intent' });
    }
});

// Confirm payment endpoint
app.post('/api/confirm-payment', async (req, res) => {
    try {
        const { paymentIntentId, paymentMethod } = req.body;

        // In a real implementation, you would confirm the payment with Airwallex API
        // For now, we'll simulate a successful payment
        const confirmedPayment = {
            id: paymentIntentId,
            status: 'succeeded',
            amount: 10000, // $100.00 in cents
            currency: 'USD'
        };

        console.log('✅ Payment Confirmed:', {
            paymentIntentId: paymentIntentId,
            status: 'succeeded'
        });

        res.json(confirmedPayment);

    } catch (error) {
        console.error('Error confirming payment:', error);
        res.status(500).json({ error: 'Failed to confirm payment' });
    }
});

// Handle successful payments
function handleSuccessfulPayment(paymentData) {
  const paymentRecord = {
    id: paymentData.id,
    status: 'succeeded',
    amount: paymentData.amount,
    currency: paymentData.currency,
    customer_id: paymentData.customer_id,
    created_at: new Date().toISOString(),
    metadata: paymentData.metadata || {}
  };

  payments.push(paymentRecord);
  
  console.log('✅ Payment Successful:', {
    id: paymentData.id,
    amount: paymentData.amount,
    currency: paymentData.currency,
    timestamp: new Date().toISOString()
  });

  // Here you can add any post-payment logic
  // But as requested, we're not doing anything else
}

// Handle failed payments
function handleFailedPayment(paymentData) {
  console.log('❌ Payment Failed:', {
    id: paymentData.id,
    error: paymentData.last_payment_error,
    timestamp: new Date().toISOString()
  });
}

// Handle canceled payments
function handleCanceledPayment(paymentData) {
  console.log('⚠️ Payment Canceled:', {
    id: paymentData.id,
    timestamp: new Date().toISOString()
  });
}

// Get all payments (for monitoring)
app.get('/api/payments', (req, res) => {
  res.json({
    total: payments.length,
    payments: payments
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`💰 Payment Receiver running on port ${PORT}`);
  console.log(`🌐 Health check: http://localhost:${PORT}/`);
  console.log(`🔔 Webhook endpoint: http://localhost:${PORT}/api/webhook/airwallex`);
  console.log(`💳 Create payment intent: http://localhost:${PORT}/api/create-payment-intent`);
  console.log(`✅ Confirm payment: http://localhost:${PORT}/api/confirm-payment`);
});