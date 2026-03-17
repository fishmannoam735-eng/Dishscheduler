# 🍽️ DishScheduler Server

A cloud server that runs 24/7 to schedule and keep alive your Home Connect dishwasher.

## What it does
- **Runs scheduled programs** via cron jobs (even when your phone is off)
- **Keeps the dishwasher awake** with hourly power-on pings
- **Auto-refreshes OAuth tokens** so you stay connected
- **Wake-up before start** — sends PowerState.On then waits 5 seconds before starting a program
- **REST API** for your phone app to manage schedules

## Deploy to Render (Free)

### Step 1: Push to GitHub
1. Create a new GitHub repo called `dishscheduler-server`
2. Push this folder to it

### Step 2: Deploy on Render
1. Go to [render.com](https://render.com) — sign up free with GitHub
2. Click **"New +"** → **"Web Service"**
3. Connect your `dishscheduler-server` repo
4. Settings:
   - **Runtime:** Node
   - **Build command:** `npm install`
   - **Start command:** `node server.js`
   - **Plan:** Free
5. Add these **Environment Variables**:
   - `HC_CLIENT_ID` = your client ID
   - `HC_CLIENT_SECRET` = your client secret
   - `HC_APPLIANCE_ID` = `484060541408005542`
   - `HC_KEEP_ALIVE` = `true`
6. Click **Deploy**

### Step 3: Send your OAuth token to the server
After the server is running, you need to give it your OAuth token once.
Your frontend app does this automatically when you tap "Authorize."

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Health check / status |
| GET | `/api/state` | Full server state |
| POST | `/api/config` | Update config |
| POST | `/api/token` | Set OAuth token |
| POST | `/api/token/refresh` | Refresh token |
| GET | `/api/appliances` | List appliances |
| GET | `/api/status` | Dishwasher status |
| GET | `/api/schedules` | List schedules |
| POST | `/api/schedules` | Create/update schedule |
| DELETE | `/api/schedules/:id` | Delete schedule |
| POST | `/api/schedules/:id/toggle` | Toggle on/off |
| POST | `/api/schedules/:id/run` | Run now |
| POST | `/api/keepalive` | Toggle keep-alive |
| POST | `/api/poweron` | Manual power on |
| GET | `/api/logs` | View logs |

## Rate Limits
- Home Connect allows 1000 API calls per day
- Keep-alive uses ~24 calls/day (1 per hour)
- Token refresh uses ~1 call/day
- Each program start uses ~2 calls (wake + start)
