// webhook.js
// npm i express stripe nodemailer sqlite3 axios
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET);
const bodyParser = require('body-parser');
const crypto = require('crypto');
const axios = require('axios');
const nodemailer = require('nodemailer');
const sqlite3 = require('sqlite3').verbose();

const app = express();

// IMPORTANT: Stripe requires the raw body to verify signature
app.use('/webhook', express.raw({ type: 'application/json' }));

// Simple sqlite for demo persistence (idempotency)
const db = new sqlite3.Database('./fulfillments.db');
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS fulfillments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    checkout_session_id TEXT UNIQUE,
    verification_session_id TEXT,
    customer_email TEXT,
    product_id TEXT,
    promo_code TEXT,
    status TEXT,
    payload TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

// Nodemailer transport (example using SMTP)
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// Replace with your provisioning endpoint
const PROVISION_URL = process.env.PROVISION_URL || 'https://vps.spraxxx.tv/provision';

// Webhook handler
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('⚠️  Webhook signature verification failed.', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle the event types we care about
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    // Idempotency: check if we've already processed this checkout session
    db.get('SELECT * FROM fulfillments WHERE checkout_session_id = ?', [session.id], async (err, row) => {
      if (err) {
        console.error('db error', err);
        return res.status(500).end();
      }
      if (row) {
        console.log('Already processed', session.id);
        return res.json({ received: true });
      }

      // Only proceed if payment succeeded
      if (session.payment_status !== 'paid') {
        console.log('Payment not completed for', session.id, session.payment_status);
        // Save a record with status pending for tracking
        db.run(
          `INSERT INTO fulfillments (checkout_session_id, verification_session_id, customer_email, product_id, promo_code, status, payload) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [session.id, session.metadata?.verification_session_id || null, session.customer_details?.email || session.customer_email || null, session.metadata?.product_id || null, session.metadata?.promo_code || null, 'payment_not_paid', JSON.stringify(session)],
        );
        return res.json({ received: true });
      }

      // All good: fulfill the product
      try {
        const verificationSessionId = session.metadata?.verification_session_id;
        const productId = session.metadata?.product_id || 'prod_SPRA50';
        const promoCode = session.metadata?.promo_code || null;
        const customerEmail = session.customer_details?.email || session.metadata?.user_email || session.customer_email;

        // 1) Call provisioning endpoint on your VPS to create the product.
        // Send whatever metadata you need; provisioning should be idempotent if passed same verification_session_id or email.
        const provisionResp = await axios.post(PROVISION_URL, {
          checkout_session_id: session.id,
          verification_session_id: verificationSessionId,
          product_id: productId,
          promo_code: promoCode,
          customer_email: customerEmail,
          metadata: session.metadata || {},
        }, {
          timeout: 15000,
          headers: { 'Content-Type': 'application/json' },
        });

        // Example expected body: { success: true, product_url: "...", wg_conf: "...", creds: {...} }
        const provisionData = provisionResp.data;

        // 2) Store fulfillment record
        db.run(
          `INSERT INTO fulfillments (checkout_session_id, verification_session_id, customer_email, product_id, promo_code, status, payload) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [session.id, verificationSessionId, customerEmail, productId, promoCode, 'fulfilled', JSON.stringify(provisionData)],
          function (dbErr) {
            if (dbErr) console.error('DB insert error', dbErr);
            else console.log('Fulfillment saved', session.id);
          }
        );

        // 3) Send an email to the customer with the product info
        const mailHtml = `
          <p>Hey — thanks for joining the SPRAXXX Nation!</p>
          <p>Your purchase for <strong>${productId}</strong> is confirmed.</p>
          ${provisionData.product_url ? `<p>Access your product here: <a href="${provisionData.product_url}">${provisionData.product_url}</a></p>` : ''}
          ${provisionData.wg_conf ? `<pre style="background:#111;color:#fff;padding:8px;border-radius:6px;">${provisionData.wg_conf}</pre>` : ''}
          ${provisionData.creds ? `<p>Credentials: <code>${JSON.stringify(provisionData.creds)}</code></p>` : ''}
          <p>If anything's off, reply to this email — team@spraxxx.tv</p>
        `;
        await transporter.sendMail({
          from: process.env.EMAIL_FROM || 'welcome@spraxxx.tv',
          to: customerEmail,
          subject: 'Your SPRAXXX product — access & instructions',
          html: mailHtml,
        });

        // 4) Optionally: mark the promo code used by calling Stripe API or your DB logic
        // (If promo is a Stripe promotion code, you can leave it — Stripe enforces redemption limit.)
        // If you maintained a promo table, mark promo as used here.

        console.log('Fulfilled checkout session', session.id);
        return res.json({ received: true });
      } catch (fulfillErr) {
        console.error('Fulfillment error', fulfillErr);
        // Save failed state for manual review
        db.run(
          `INSERT INTO fulfillments (checkout_session_id, verification_session_id, customer_email, product_id, promo_code, status, payload) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [session.id, session.metadata?.verification_session_id || null, session.customer_details?.email || session.customer_email || null, session.metadata?.product_id || null, session.metadata?.promo_code || null, 'fulfillment_failed', JSON.stringify({ error: String(fulfillErr) })],
        );
        // Respond 500 so Stripe retries the webhook (it will retry several times)
        return res.status(500).end();
      }
    });
  } else {
    // For other event types we don't care about
    console.log('Unhandled event type', event.type);
    return res.json({ received: true });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Webhook server listening on ${PORT}`);
});
