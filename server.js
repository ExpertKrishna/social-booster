require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const Order = require('./models/Order');

const {
  PORT = 3000, MONGO_URI, SMM_API_KEY, SMM_API_URL, UPI_ID,
  MERCHANT_NAME = 'SMM Panel', ADMIN_KEY, CORS_ORIGIN = '*',
  AUTO_APPROVE = 'false', SMM_PAYLOAD_FORMAT = 'json'
} = process.env;

for (const [k, v] of Object.entries({ MONGO_URI, SMM_API_KEY, SMM_API_URL, UPI_ID })) {
  if (!v) { console.error(`Missing required env var: ${k}`); process.exit(1); }
}

/* ------------------------------------------------------------------ *
 * CATALOG & PRICING  (edit this section)
 * rate = INR per 1000. serviceId / refillServiceId = IDs from YOUR
 * provider's service list (the numbers below are examples, replace them).
 * Prices are always calculated here on the server; the client is never trusted.
 * ------------------------------------------------------------------ */
const REFILL_MULTIPLIER = 1.35;
const SERVICES = {
  instagram: { label: 'Instagram', services: {
    followers: { label: 'Followers', serviceId: 1001, refillServiceId: 1002, rate: 90, min: 100, max: 100000 },
    likes:     { label: 'Likes',     serviceId: 1003, refillServiceId: 1004, rate: 40, min: 100, max: 50000 },
    views:     { label: 'Reel Views', serviceId: 1005, refillServiceId: 1005, rate: 15, min: 500, max: 1000000 }
  }},
  facebook: { label: 'Facebook', services: {
    followers: { label: 'Page Followers', serviceId: 2001, refillServiceId: 2002, rate: 85, min: 100, max: 100000 },
    likes:     { label: 'Post Likes',     serviceId: 2003, refillServiceId: 2004, rate: 45, min: 100, max: 50000 }
  }},
  telegram: { label: 'Telegram', services: {
    members: { label: 'Channel Members', serviceId: 3001, refillServiceId: 3002, rate: 70, min: 100, max: 100000 },
    views:   { label: 'Post Views',      serviceId: 3003, refillServiceId: 3003, rate: 10, min: 500, max: 1000000 }
  }},
  youtube: { label: 'YouTube', services: {
    views:       { label: 'Views',       serviceId: 4001, refillServiceId: 4002, rate: 120, min: 500, max: 500000 },
    subscribers: { label: 'Subscribers', serviceId: 4003, refillServiceId: 4004, rate: 450, min: 50, max: 20000 },
    likes:       { label: 'Likes',       serviceId: 4005, refillServiceId: 4006, rate: 60, min: 100, max: 50000 }
  }}
};

function calcPrice(rate, qty, plan) {
  const base = (qty / 1000) * rate * (plan === 'refill' ? REFILL_MULTIPLIER : 1);
  return Math.round(base * 100) / 100;
}

/* ------------------------------ App setup ------------------------------ */
const app = express();
app.set('trust proxy', 1); // correct client IPs behind Render/Vercel proxies
app.use(cors({ origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN.split(',').map(s => s.trim()) }));
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false }));
const strictLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please try again later.' } });

const genOrderId = () => 'SMM' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase();

/* ---------------------- SMM provider integration ---------------------- */
async function callProvider(params) {
  const payload = { key: SMM_API_KEY, ...params };
  const res = SMM_PAYLOAD_FORMAT === 'form'
    ? await axios.post(SMM_API_URL, new URLSearchParams(payload).toString(),
        { timeout: 20000, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })
    : await axios.post(SMM_API_URL, payload, { timeout: 20000, headers: { 'Content-Type': 'application/json' } });
  return res.data;
}

/** Sends a paid order to the provider. Atomic status flip prevents double-sending. */
async function fulfillOrder(orderId) {
  const order = await Order.findOneAndUpdate(
    { orderId, paymentUtr: { $ne: null }, status: { $in: ['pending', 'failed'] } },
    { status: 'processing', providerError: null },
    { new: true }
  );
  if (!order) throw new Error('Order not found, has no UTR, or was already sent to provider.');

  const svc = SERVICES[order.platform].services[order.service];
  const serviceId = order.packageType === 'refill' ? svc.refillServiceId : svc.serviceId;
  try {
    const data = await callProvider({ action: 'add', service: serviceId, link: order.profileLink, quantity: order.quantity });
    if (!data || !data.order) throw new Error((data && data.error) || 'Provider did not return an order id');
    order.providerOrderId = String(data.order);
    await order.save();
    return order;
  } catch (err) {
    order.status = 'failed';
    order.providerError = String(err.response?.data?.error || err.message).slice(0, 300);
    await order.save();
    throw err;
  }
}

/* ----------------------------- Public API ----------------------------- */
// Catalog for the frontend (provider service IDs are NOT exposed)
app.get('/api/config', (req, res) => {
  const catalog = {};
  for (const [p, pd] of Object.entries(SERVICES)) {
    catalog[p] = { label: pd.label, services: {} };
    for (const [s, sd] of Object.entries(pd.services)) {
      const { label, rate, min, max } = sd;
      catalog[p].services[s] = { label, rate, min, max };
    }
  }
  res.json({ refillMultiplier: REFILL_MULTIPLIER, catalog });
});

// Create order -> returns UPI payment details
app.post('/api/create-order', strictLimiter, async (req, res) => {
  try {
    const { platform, service, profileLink, packageType } = req.body || {};
    const quantity = Number(req.body?.quantity);
    const svc = SERVICES[platform]?.services?.[service];
    if (!svc) return res.status(400).json({ success: false, message: 'Invalid platform or service.' });
    if (!['standard', 'refill'].includes(packageType)) return res.status(400).json({ success: false, message: 'Invalid package type.' });
    if (!Number.isInteger(quantity) || quantity < svc.min || quantity > svc.max)
      return res.status(400).json({ success: false, message: `Quantity must be between ${svc.min} and ${svc.max}.` });
    const link = String(profileLink || '').trim();
    if (link.length < 3 || link.length > 300) return res.status(400).json({ success: false, message: 'Please enter a valid profile link or username.' });

    const totalPrice = calcPrice(svc.rate, quantity, packageType);
    const orderId = genOrderId();
    await Order.create({ orderId, platform, service, profileLink: link, packageType, quantity, totalPrice });

    const amount = totalPrice.toFixed(2);
    const upiLink = `upi://pay?pa=${encodeURIComponent(UPI_ID)}&pn=${encodeURIComponent(MERCHANT_NAME)}&am=${amount}&cu=INR&tn=${orderId}`;
    res.json({ success: true, orderId, amount, upiLink, merchantName: MERCHANT_NAME });
  } catch (err) {
    console.error('create-order:', err.message);
    res.status(500).json({ success: false, message: 'Could not create order.' });
  }
});

// Customer submits UTR. Fulfilment happens on admin approval (or AUTO_APPROVE=true).
app.post('/api/verify-payment', strictLimiter, async (req, res) => {
  try {
    const orderId = String(req.body?.orderId || '').trim();
    const utr = String(req.body?.utr || '').trim();
    if (!/^\d{12}$/.test(utr)) return res.status(400).json({ success: false, message: 'UTR must be exactly 12 digits.' });

    const order = await Order.findOneAndUpdate(
      { orderId, status: 'pending', paymentUtr: { $exists: false } },
      { paymentUtr: utr }, { new: true }
    );
    if (!order) return res.status(404).json({ success: false, message: 'Order not found or payment already submitted.' });

    if (AUTO_APPROVE === 'true') {
      try {
        await fulfillOrder(orderId);
        return res.json({ success: true, status: 'processing', message: 'Payment accepted. Your order is now processing!' });
      } catch (e) {
        return res.json({ success: true, status: 'failed', message: 'Payment received, but delivery could not start. Support will fix it shortly.' });
      }
    }
    res.json({ success: true, status: 'pending', message: 'UTR received! We are verifying your payment, delivery starts right after.' });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ success: false, message: 'This UTR has already been used.' });
    console.error('verify-payment:', err.message);
    res.status(500).json({ success: false, message: 'Verification failed. Please try again.' });
  }
});

// Order status (limited fields)
app.get('/api/order/:orderId', async (req, res) => {
  const o = await Order.findOne({ orderId: req.params.orderId })
    .select('orderId status platform service quantity totalPrice createdAt -_id');
  if (!o) return res.status(404).json({ success: false, message: 'Order not found.' });
  res.json({ success: true, order: o });
});

/* ------------------------------ Admin API ------------------------------ */
function adminAuth(req, res, next) {
  if (!ADMIN_KEY) return res.status(503).json({ success: false, message: 'ADMIN_KEY not configured.' });
  const a = Buffer.from(String(req.get('x-admin-key') || ''));
  const b = Buffer.from(ADMIN_KEY);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ success: false, message: 'Unauthorized.' });
  next();
}

// List orders, e.g. /api/admin/orders?status=pending  (check UTRs against your bank/UPI app)
app.get('/api/admin/orders', adminAuth, async (req, res) => {
  const filter = req.query.status ? { status: req.query.status } : {};
  res.json(await Order.find(filter).sort({ createdAt: -1 }).limit(100));
});

// Approve a verified payment -> triggers provider API
app.post('/api/admin/approve/:orderId', adminAuth, async (req, res) => {
  try {
    const order = await fulfillOrder(req.params.orderId);
    res.json({ success: true, providerOrderId: order.providerOrderId, status: order.status });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// Pull delivery status from provider and update order
app.post('/api/admin/sync/:orderId', adminAuth, async (req, res) => {
  try {
    const order = await Order.findOne({ orderId: req.params.orderId });
    if (!order || !order.providerOrderId) return res.status(404).json({ success: false, message: 'No provider order.' });
    const data = await callProvider({ action: 'status', order: order.providerOrderId });
    const s = String(data.status || '').toLowerCase();
    if (s === 'completed') order.status = 'completed';
    else if (['canceled', 'cancelled', 'refunded'].includes(s)) { order.status = 'failed'; order.providerError = `Provider status: ${data.status}`; }
    await order.save();
    res.json({ success: true, provider: data, status: order.status });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/* -------------------------------- Boot -------------------------------- */
mongoose.connect(MONGO_URI)
  .then(() => app.listen(PORT, () => console.log(`SMM panel running on port ${PORT}`)))
  .catch(err => { console.error('MongoDB connection failed:', err.message); process.exit(1); });
