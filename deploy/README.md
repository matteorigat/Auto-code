# Deployment

To deploy `opencode-bridge-telegram` in production:

## Prerequisites

1. Node.js v20+
2. Docker (for Quality Gate tests)
3. Telegram Bot Token
4. Notion API Token and Database/Page IDs

## Steps

1. Clone the repository to the production server.
2. Run `npm install --production`.
3. Copy `.env.example` to `.env` and fill in the required environment variables.
4. Run `npm start` to start the bot.
5. Alternatively, use PM2 for process management: `pm2 start npm --name "opencode-bridge" -- start`

## Security

Ensure that `DASHBOARD_TOKEN` is set if you are exposing the dashboard to the public internet, and only allow the loop to run within safe sandboxes.
