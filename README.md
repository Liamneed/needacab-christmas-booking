# Derriford Staff Taxi Booking (Christmas Period)

A minimal Node/Express + MongoDB app that collects Derriford Hospital staff taxi bookings:
- Google Places Autocomplete (confirmed addresses only)
- Zone lookup via Autocab API
- Stores each booking in MongoDB
- Simple admin reports (grouped by Zone and by Shift).

## Quick Start

1) **Create .env**
   Copy `.env.example` to `.env` and fill values:
   - `MONGODB_URI=mongodb://127.0.0.1:27017/needacab`
   - `AUTOCAB_SUBSCRIPTION_KEY=...` (keep private)
   - `PORT=4000`

2) **Install & Run**
```bash
npm install
npm run dev
```
API runs on `http://localhost:4000`

3) **Open the booking form**
- Open `public/index.html` directly in a browser for local testing
  - Replace `YOUR_GOOGLE_MAPS_API_KEY` with your key
  - Ensure CORS allows `http://localhost` defaults (already enabled on server)

4) **Admin Reports**
- Open `public/admin.html`
- Click "Refresh" to see Grouped Reports (by Zone, by Shift)

### Endpoints

- `GET /api/zone?lat=...&lng=...` – Proxies Autocab Zone API
- `POST /api/bookings` – Saves booking (requires Google `placeId` for pickup & destination)
- `GET /api/reports/by-zone` – Grouped counts by pickup zone
- `GET /api/reports/by-shift` – Grouped counts by shift type/time

> Note: Keep your Autocab key in `.env`. Do not expose it on the client.
