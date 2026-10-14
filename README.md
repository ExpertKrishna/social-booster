# SMM Panel: Free-Tier Deployment Guide

Stack: Node.js + Express, vanilla JS frontend, MongoDB Atlas (M0 free), Render (backend + frontend), optional Vercel (frontend only).

```
smm-panel/
├── server.js
├── models/Order.js
├── public/index.html
├── package.json
├── .env.example
└── .gitignore
```

## 0. Important: how payment verification works

Plain UPI QR payments have **no webhook**, so the server cannot confirm money actually arrived. A UTR is just a 12-digit number the customer types, and anyone can type a fake one.

For that reason the default flow is:

1. Customer pays and submits the UTR. The server validates the format, blocks reused UTRs, and stores it (order stays `pending`).
2. You check the UTR and amount in your UPI/bank app.
3. You approve it, and **only then** the server calls the SMM provider API.

```bash
# list orders waiting for review
curl -H "x-admin-key: YOUR_ADMIN_KEY" "https://YOUR-APP.onrender.com/api/admin/orders?status=pending"

# approve a verified payment (this triggers the provider API)
curl -X POST -H "x-admin-key: YOUR_ADMIN_KEY" "https://YOUR-APP.onrender.com/api/admin/approve/ORDER_ID"

# refresh delivery status from provider (marks order completed)
curl -X POST -H "x-admin-key: YOUR_ADMIN_KEY" "https://YOUR-APP.onrender.com/api/admin/sync/ORDER_ID"
```

Setting `AUTO_APPROVE=true` sends orders to the provider the instant a UTR is submitted, with no payment check. Fake UTRs would then cost you real money at the provider. Use it only for testing, or after you add a payment gateway with webhooks (Razorpay, Cashfree, etc.).

## 1. Set up MongoDB Atlas (free tier)

1. Sign up at https://www.mongodb.com/cloud/atlas and create a project.
2. **Create a cluster** → choose the **M0 (Free)** tier → pick the region closest to you (e.g. Mumbai) → Create.
3. **Database Access** → Add New Database User → username + password (password auth) → role "Read and write to any database". Avoid special characters in the password, or URL-encode them.
4. **Network Access** → Add IP Address → **Allow access from anywhere (0.0.0.0/0)**. Render's free tier has no fixed IP, so this is required.
5. **Database** → Connect → Drivers → copy the connection string:
   `mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority`
6. Insert your database name before the `?`, e.g. `.../smmpanel?retryWrites=...`. This is your `MONGO_URI`.

## 2. Run locally

```bash
npm install
cp .env.example .env     # then fill in every value
npm run dev              # open http://localhost:3000
```

## 3. Connect your SMM provider

1. Create an account with a wholesale SMM provider and add funds.
2. Open the provider's **API** page and copy the **API URL** and **API key** → `SMM_API_URL`, `SMM_API_KEY`.
3. Open the provider's **Services** list and note the service ID for each product you sell.
4. In `server.js`, edit the `SERVICES` object: set `serviceId` (Standard) and `refillServiceId` (Refill/Guarantee) from your provider's list, and set `rate` (your selling price per 1000 in ₹), `min` and `max`. **The IDs in the file are examples and must be replaced**, or orders will fail or buy the wrong service.
5. Payload sent: `{ "key", "action": "add", "service", "link", "quantity" }`. If your provider rejects JSON, set `SMM_PAYLOAD_FORMAT=form` (the standard v2 format most panels use).
6. Test with the smallest quantity first and check the order in the provider's dashboard.

## 4. Deploy on Render (backend + frontend, recommended)

1. Push the project to a GitHub repo (`.env` is git-ignored, never commit it).
2. https://render.com → New → **Web Service** → connect the repo.
3. Settings: Runtime **Node**, Build Command `npm install`, Start Command `npm start`, Instance Type **Free**.
4. Add Environment Variables: `MONGO_URI`, `SMM_API_URL`, `SMM_API_KEY`, `SMM_PAYLOAD_FORMAT`, `UPI_ID`, `MERCHANT_NAME`, `ADMIN_KEY`, `AUTO_APPROVE=false`, `CORS_ORIGIN=*`. (Render sets `PORT` itself.)
5. Deploy. Your site is live at `https://YOUR-APP.onrender.com`.

Free Render services sleep after about 15 minutes idle, so the first visit can take 30–60 seconds. A free uptime pinger hitting `/api/config` every 10 minutes keeps it awake.

## 5. Optional: frontend on Vercel

Skip this if you use Render for everything. To host only the frontend on Vercel:

1. Make a separate repo/folder containing only `public/index.html`.
2. In that file, set `const API_BASE = 'https://YOUR-APP.onrender.com';`.
3. On https://vercel.com → Add New Project → import the repo → Framework "Other" → Deploy.
4. In Render, set `CORS_ORIGIN=https://your-project.vercel.app` and redeploy.

## 6. Go-live checklist

- Test with a ₹1-level order (lower a `min` temporarily) and confirm the QR opens correctly in GPay/PhonePe/Paytm.
- Use a long random `ADMIN_KEY`.
- Confirm `UPI_ID` is correct, since customers pay to it directly.
- Keep your provider balance topped up, or approvals will end as `failed` (you can retry them with the approve endpoint).
