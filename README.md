# Lumen API

Node/Express backend for Lumen. Connects to Neon PostgreSQL and serves data to the Vercel frontend.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/health | Health check |
| GET | /api/dashboard | Main overview data |
| GET | /api/accounts | All accounts + net worth |
| GET | /api/accounts/:id | Single account |
| GET | /api/transactions | Transaction feed |
| POST | /api/transactions | Add a transaction |
| GET | /api/budgets | Budgets with current spend |
| GET | /api/calendar | Recurring bills and schedule |
| GET | /api/analytics | Charts and insights data |

## Local Development

```
npm install
copy .env.example .env
# fill in .env with your values
npm run dev
```

## Project Structure

```
src/
├── index.js          # Express server entry point
├── db/
│   ├── pool.js       # PostgreSQL connection
│   └── schema.sql    # Run this once in Neon to create tables
├── middleware/
│   └── errorHandler.js
└── routes/
    ├── dashboard.js
    ├── accounts.js
    ├── transactions.js
    ├── budgets.js
    ├── calendar.js
    └── analytics.js
```
