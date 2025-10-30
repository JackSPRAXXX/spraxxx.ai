// --- config
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WH = process.env.STRIPE_WEBHOOK_SECRET;
const SADBLACK_URL = process.env.SADBLACK_URL || 'https://sadblack.spraxxx.net/api/profiles/create';
const SADBLACK_TOKEN = process.env.SADBLACK_TOKEN; // bearer

const stripe = require('stripe')(STRIPE_KEY);
const express = require('express');
const nodemailer = require('nodemailer');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();

const app = express();

// Stripe needs raw body:
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WH);
  } catch (err) {
    console.error('✗ Bad signature:', err.message);
    return res.status(400).send('Invalid signature');
  }

  // Open DB (or reuse your existing connection)
  const db = new sqlite3.Database('./fulfillment.db');

  const upsert = (row) =>
    new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO fulfillments 
         (checkout_session_id, verification_session_id, customer_email, product_id, promo_code, status, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(checkout_session_id) DO UPDATE SET 
           verification_session_id=excluded.verification_session_id,
           customer_email=excluded.customer_email,
           product_id=excluded.product_id,
           promo_code=excluded.promo_code,
           status=excluded.status,
           payload=excluded.payload`,
        [
          row.checkout_session_id || null,
          row.verification_session_id || null,
          row.customer_email || null,
          row.product_id || null,
          row.promo_code || null,
          row.status,
          JSON.stringify(row.payload || {}),
        ],
        (err) => (err ? reject(err) : resolve())
      );
    });

  const mailer = nodemailer.createTransport({
    host: process.env.MAIL_HOST, port: 465, secure: true,
    auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS },
  });

  const notify = (to, subject, html) =>
    mailer.sendMail({ from: '"SPRAXXX Nation" <verify@spraxxx.com>', to, subject, html });

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const s = event.data.object;
        await upsert({
          checkout_session_id: s.id,
          customer_email: s.customer_details?.email,
          product_id: s.metadata?.product_id || 'builder-pass',
          promo_code: s.total_details?.breakdown?.discounts?.[0]?.discount?.id || null,
          status: 'paid',
          payload: s,
        });
        break;
      }

      case 'identity.verification_session.verified': {
        const v = event.data.object;
        const email = v?.metadata?.email; // set this in your Stripe verification session metadata
        await upsert({
          checkout_session_id: null,
          verification_session_id: v.id,
          customer_email: email,
          product_id: v?.metadata?.product_id || 'builder-pass',
          promo_code: null,
          status: 'verified',
          payload: v,
        });

        // Relay to Sad-Black (create/enable profile)
        if (email) {
          await axios.post(
            SADBLACK_URL,
            {
              email,
              verification_session_id: v.id,
              product_id: v?.metadata?.product_id || 'builder-pass',
              // add anything Sad-Black needs to mint keys / alias
            },
            { headers: { Authorization: `Bearer ${SADBLACK_TOKEN}` } }
          );

          // Finalize record
          await upsert({
            checkout_session_id: null,
            verification_session_id: v.id,
            customer_email: email,
            product_id: v?.metadata?.product_id || 'builder-pass',
            promo_code: null,
            status: 'fulfilled',
            payload: { fulfilled_at: new Date().toISOString() },
          });

          // Welcome email
          await notify(
            email,
            'SPRAXXX Verification Complete',
            `<p>Welcome to the Nation.</p>
             <p>Your identity is verified and your SPRAXXX profile is now active.</p>
             <p>Next steps will arrive shortly from our Greeter desk.</p>`
          );
        }
        break;
      }

      case 'identity.verification_session.requires_input': {
        const v = event.data.object;
        await upsert({
          checkout_session_id: null,
          verification_session_id: v.id,
          customer_email: v?.metadata?.email || null,
          product_id: v?.metadata?.product_id || 'builder-pass',
          promo_code: null,
          status: 'needs_input',
          payload: v,
        });
        break;
      }

      default:
        // ignore others but 200 OK so Stripe stops retrying
        break;
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook handler error:', err);
    res.status(500).send('Server error');
  } finally {
    db.close();
  }
});
