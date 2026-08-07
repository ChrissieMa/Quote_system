# LKS Quote + Invoice + Receipt System

This is a complete, independent Quote, Invoice, and Receipt system built for LKS Display Box. It uses Node.js, TypeScript, Express, and Airtable as the primary data store.

## Prerequisites
- Node.js (v18 or higher recommended)
- An Airtable account with the necessary tables (`Quotes`, `Customers`, `Order_2026`, `Order Items`)

## Installation

1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd lks-quote-system
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

## Environment Setup

1. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```

2. Fill in the required environment variables in `.env`:
   - `AIRTABLE_API_KEY`: Your Airtable Personal Access Token (or API Key).
   - `AIRTABLE_BASE_ID`: The ID of your Airtable Base.
   - Other variables like `COMPANY_NAME`, `PUBLIC_BASE_URL`, etc.
   - `ADMIN_PASSWORD` and a server-side session signing secret are required for owner login. Set a separate `SESSION_SECRET` in Railway. During migration only, the app can derive a separated signing key in memory from the existing `QUOTE_PILOT_CONFIRMATION_SECRET`; if neither secret exists, owner access fails closed.
   - `PUBLIC_TOKEN_TTL_DAYS`: validity period for new v2 customer document links (default and maximum: 3650 days).

## Development

Run the development server with hot-reloading (via ts-node):
```bash
npm run dev
```
The server will start on `http://localhost:3000` (or the port specified in `.env`).

## Build for Production

Compile TypeScript to JavaScript:
```bash
npm run build
```
This will generate the compiled files in the `dist/` directory.

## Start Production Server

Start the compiled application:
```bash
npm run start
```

## Railway Deployment

This project is ready to be deployed on Railway.

1. Connect your GitHub repository to Railway.
2. Railway will automatically detect the `package.json` and build the project using `npm run build` and start it using `npm run start`.
3. Go to the "Variables" tab in your Railway project settings and add all the environment variables from your `.env` file.
4. Update `PUBLIC_BASE_URL` in the Railway variables to match your Railway deployment URL (e.g., `https://your-app-name.up.railway.app`).

## Features
- **Owner Login**: `/quotes`, quote creation, inquiry creation, customer search, invoice conversion, payment actions, costs, and finance pages require a signed secure session. Login is rate-limited and supports logout.
- **Private-by-default responses**: the complete Quote subdomain sends `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet` and `Cache-Control: private, no-store`.
- **Secret document links**: Quote, Invoice, Receipt, and Customer Information pages accept only expiring v2 256-bit tokens. Legacy 32-character tokens are rejected.
- **Quote Creation**: Signed-in internal users can generate quotes with items, discounts, and terms.
- **Public Quote Page**: Customers can view quotes and submit their details to confirm the order.
- **Invoice Generation**: Convert confirmed quotes into official orders (invoices) in Airtable.
- **Public Invoice Page**: Customers can view their invoices.
- **Receipt Generation**: Mark invoices as paid to generate receipts.
- **Public Receipt Page**: Customers can view their payment receipts.
