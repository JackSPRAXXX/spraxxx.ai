// webhook.js (production-ready, idempotent)
// npm i express stripe nodemailer sqlite3 axios

const express  = require('express');
const stripe   = require('stripe')(process.env.STRIPE_SECRET || process.env.STRIPE_SECRET_KEY);
const axios    = require('axios');
const nodemailer = require('nodemailer');
const sqlite3  = require('sqlite3').verbose();

const app = express();

/* ---------- ENV (set these) ---------- */
const WEBHOOK_SECRET   = process.env.STRIPE_WEBHOOK_SECRET;
const PROVISION_URL    = process.env.PROVISION_URL || 'https://vps.spraxxx.tv/provision';
const SADBLACK_TOKEN   = process.env.SADBLACK_TOKEN || ''; // if your provisioner expects bearer
const MAIL_FROM        = process.env.EMAIL_FROM || 'welcome@spraxxx.tv';
const SMTP_HOST        = process.env.SMTP_HOST;
const SMTP_PORT        = Number(process.env.SMTP_PORT || 587);
const SMTP_USER        = process.env.SMTP_USER;
const SMTP_PASS        = process.env.SMTP_PASS;

/* ---------- Middlewares ---------- */
// IMPORTANT: Stripe needs raw body for signature verification **only on this route**
app.post('/webhook', express.raw({ type: 'application/json' }));
// DO NOT add express.json() before /webhook. For other routes it's fine:
app.use(express.json({ limit: '1mb' }));

/* ---------- DB ---------- */
const db = new sqlite3.Database('./fulfillments.db');
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS fulfillments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    checkout_session_id TEXT UNIQUE,
    verification_session_id TEXT UNIQUE,
    customer_email TEXT,
    product_id TEXT,
    promo_code TEXT,
    status TEXT,              -- paid | verified | fulfilled | needs_input | payment_not_paid | fulfillment_failed
    payload TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_fulfillments_email ON fulfillments(customer_email)`);
});

const upsert = (row) => new Promise((resolve, reject) => {
  db.run(
    `INSERT INTO fulfillments
      (checkout_session_id, verification_session_id, customer_email, product_id, promo_code, status, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(checkout_session_id) DO UPDATE SET
       verification_session_id = COALESCE(excluded.verification_session_id, verification_session_id),
       customer_email          = COALESCE(excluded.customer_email, customer_email),
       product_id              = COALESCE(excluded.product_id, product_id),
       promo_code              = COALESCE(excluded.promo_code, promo_code),
       status                  = excluded.status,
       payload                 = excluded.payload`,
    [
      row.checkout_session_id || null,
      row.verification_session_id || null,
      row.customer_email || null,
      row.product_id || null,
      row.promo_code || null,
      row.status,
      JSON.stringify(row.payload || {})
    ],
    (err) => (err ? reject(err) : resolve())
  );
});

/* ---------- Mailer ---------- */
const transporter = nodemailer.createTransport({
  host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465,
  auth: { user: SMTP_USER, pass: SMTP_PASS }
});
const sendMail = (to, subject, html) =>
  transporter.sendMail({ from: MAIL_FROM, to, subject, html });

/* ---------- Helper: provision after verified ---------- */
async function provisionAndWelcome({ email, verification_session_id, product_id, promo_code, checkout_session_id }) {
  // Call Sad-Black / provisioner
  const { data } = await axios.post(
    PROVISION_URL,
    {
      email,
      verification_session_id,
      product_id: product_id || 'builder-pass',
      promo_code: promo_code || null,
      checkout_session_id
    },
    {
      timeout: 20000,
      headers: {
        'Content-Type': 'application/json',
        ...(SADBLACK_TOKEN ? { Authorization: `Bearer ${SADBLACK_TOKEN}` } : {})
      }
    }
  );

  // Record as fulfilled
  await upsert({
    checkout_session_id,
    verification_session_id,
    customer_email: email,
    product_id,
    promo_code,
    status: 'fulfilled',
    payload: { provision: data, fulfilled_at: new Date().toISOString() }
  });

  // Email user
  const productURL = data?.product_url ? `<p>Access: <a href="${data.product_url}">${data.product_url}</a></p>` : '';
  const wgConf     = data?.wg_conf ? `<pre style="background:#111;color:#fff;padding:8px;border-radius:6px;white-space:pre-wrap">${data.wg_conf}</pre>` : '';
  const creds      = data?.creds   ? `<p>Credentials: <code>${escapeHTML(JSON.stringify(data.creds))}</code></p>` : '';

  await sendMail(
    email,
    'SPRAXXX Verification Complete — Your Access',
    `<p>Welcome to the Nation.</p>
     <p>Your identity has been verified and your profile is active.</p>
     ${productURL}${wgConf}${creds}
     <p>Questions? Reply to this email.</p>`
  );
}

/* ---------- Webhook ---------- */
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, WEBHOOK_SECRET);
  } catch (err) {
    console.error('✗ Webhook signature failed:', err.message);
    return res.status(400).send('Invalid signature');
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const s = event.data.object;
      const email    = s.customer_details?.email || s.customer_email || s.metadata?.user_email || null;
      const product  = s.metadata?.product_id || 'builder-pass';
      const promo    = s.metadata?.promo_code || null;
      const vsid     = s.metadata?.verification_session_id || null;

      await upsert({
        checkout_session_id: s.id,
        verification_session_id: vsid,
        customer_email: email,
        product_id: product,
        promo_code: promo,
        status: s.payment_status === 'paid' ? 'paid' : 'payment_not_paid',
        payload: s
      });

      // If you ONLY want to fulfill after identity verification, stop here.
      // Sad-Black will be invoked by the identity.verified handler below.
      return res.json({ received: true });
    }

    if (event.type === 'identity.verification_session.verified') {
      const v = event.data.object;
      // Make sure you set these metadata keys when you create the verification session
      const email   = v.metadata?.email || v.last_verification_report?.document?.email || null;
      const product = v.metadata?.product_id || 'builder-pass';
      const promo   = v.metadata?.promo_code || null;

      await upsert({
        checkout_session_id: null,
        verification_session_id: v.id,
        customer_email: email,
        product_id: product,
        promo_code: promo,
        status: 'verified',
        payload: v
      });

      // Idempotent fulfill (will overwrite/merge if checkout row already exists)
      await provisionAndWelcome({
        email, verification_session_id: v.id, product_id: product, promo_code: promo, checkout_session_id: null
      });

      return res.json({ received: true });
    }

    if (event.type === 'identity.verification_session.requires_input') {
      const v = event.data.object;
      await upsert({
        checkout_session_id: null,
        verification_session_id: v.id,
        customer_email: v.metadata?.email || null,
        product_id: v.metadata?.product_id || 'builder-pass',
        promo_code: v.metadata?.promo_code || null,
        status: 'needs_input',
        payload: v
      });
      return res.json({ received: true });
    }

    // Ignore others, but acknowledge
    return res.json({ received: true });
  } catch (err) {
    console.error('Webhook handler error:', err);
    // 500 so Stripe retries (useful for transient provisioner SMTP/VPS hiccups)
    return res.status(500).send('Server error');
  }
});

/* ---------- Health (for /status page) ---------- */
app.get('/api/health', (req, res) => {
  db.get(
    `SELECT
       SUM(CASE WHEN status='verified'  THEN 1 ELSE 0 END) AS verified,
       SUM(CASE WHEN status='fulfilled' THEN 1 ELSE 0 END) AS fulfilled,
       SUM(CASE WHEN created_at >= DATETIME('now','-1 day') THEN 1 ELSE 0 END) AS events_24h
     FROM fulfillments`,
    [],
    (err, row) => {
      if (err) return res.status(500).json({ ok: false });
      res.json({ ok: true, ...row });
    }
  );
});

/* ---------- Server ---------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SPRAXXX webhook up on :${PORT}`));

/* ---------- Utils ---------- */
function escapeHTML(s='') {
  return s.replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
