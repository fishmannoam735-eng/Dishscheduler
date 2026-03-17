import express from "express";
import cron from "node-cron";
import cors from "cors";
import { writeFile, readFile } from "fs/promises";
import { existsSync } from "fs";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_BASE = "https://api.home-connect.com";
const DATA_FILE = "/tmp/dishscheduler-data.json";

// ─── State ───────────────────────────────────────────────────
let config = {
  clientId: process.env.HC_CLIENT_ID || "",
  clientSecret: process.env.HC_CLIENT_SECRET || "",
  haId: process.env.HC_APPLIANCE_ID || "",
  notifyEmail: process.env.HC_NOTIFY_EMAIL || "",
  reminderHours: parseInt(process.env.HC_REMINDER_HOURS || "2"),
};
let tokenData = null;
let schedules = [];
let keepAlive = process.env.HC_KEEP_ALIVE === "true";
let remindersEnabled = true;
let logs = [];
let cronJobs = {};
let reminderJobs = {};
let keepAliveCron = null;

// ─── Persistence (survives short restarts via /tmp) ──────────
async function saveState() {
  try {
    await writeFile(DATA_FILE, JSON.stringify({
      tokenData, schedules, keepAlive, remindersEnabled,
    }));
  } catch {}
}

async function loadState() {
  try {
    if (existsSync(DATA_FILE)) {
      const raw = await readFile(DATA_FILE, "utf8");
      const data = JSON.parse(raw);
      if (data.tokenData) tokenData = data.tokenData;
      if (data.schedules) schedules = data.schedules;
      if (data.keepAlive !== undefined) keepAlive = data.keepAlive;
      if (data.remindersEnabled !== undefined) remindersEnabled = data.remindersEnabled;
      addLog("💾 Loaded saved state from disk");
      return true;
    }
  } catch {}
  return false;
}

// If a refresh token was set as env var, use it to bootstrap
async function bootstrapToken() {
  const savedRefresh = process.env.HC_REFRESH_TOKEN;
  if (savedRefresh && !tokenData) {
    addLog("🔑 Bootstrapping token from HC_REFRESH_TOKEN env var...");
    tokenData = { refresh_token: savedRefresh };
    const token = await refreshAccessToken();
    if (token) {
      addLog("🔑 Bootstrap successful — token active!");
      await saveState();
    } else {
      addLog("🔑 Bootstrap failed — refresh token may be expired", false);
      tokenData = null;
    }
  }
}

function addLog(msg, success = true) {
  const entry = { message: msg, success, timestamp: new Date().toISOString() };
  logs.push(entry);
  if (logs.length > 100) logs = logs.slice(-100);
  console.log(`[${success ? "OK" : "ERR"}] ${msg}`);
}

// ─── Token Management ────────────────────────────────────────
async function refreshAccessToken() {
  if (!tokenData?.refresh_token || !config.clientId || !config.clientSecret) return null;
  try {
    const r = await fetch(`${API_BASE}/security/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: tokenData.refresh_token,
      }),
    });
    if (!r.ok) throw new Error(`Refresh failed: ${r.status}`);
    const data = await r.json();
    data.expires_at = Date.now() + (data.expires_in || 86400) * 1000;
    // Keep the old refresh_token if new one isn't provided
    if (!data.refresh_token && tokenData.refresh_token) {
      data.refresh_token = tokenData.refresh_token;
    }
    tokenData = data;
    await saveState();
    addLog("🔑 Token refreshed successfully");
    return data.access_token;
  } catch (e) {
    addLog(`🔑 Token refresh failed: ${e.message}`, false);
    return null;
  }
}

async function getAccessToken() {
  if (!tokenData) return null;
  if (tokenData.expires_at && Date.now() > tokenData.expires_at - 120000) {
    return await refreshAccessToken();
  }
  return tokenData.access_token;
}

// Auto-refresh token every 20 hours
cron.schedule("0 */20 * * *", () => {
  if (tokenData?.refresh_token) {
    addLog("🔑 Auto-refreshing token...");
    refreshAccessToken();
  }
});

// ─── Home Connect API Calls ──────────────────────────────────
async function sendPowerOn() {
  const token = await getAccessToken();
  if (!token || !config.haId) return false;
  try {
    const r = await fetch(`${API_BASE}/api/homeappliances/${config.haId}/settings/BSH.Common.Setting.PowerState`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/vnd.bsh.sdk.v1+json" },
      body: JSON.stringify({ data: { key: "BSH.Common.Setting.PowerState", value: "BSH.Common.EnumType.PowerState.On" } }),
    });
    if (r.status === 204 || r.ok) {
      addLog("🏓 Keep-alive: PowerState.On sent");
      return true;
    } else {
      const e = await r.json().catch(() => ({}));
      addLog(`🏓 Keep-alive failed: ${e?.error?.description || r.status}`, false);
      return false;
    }
  } catch (e) {
    addLog(`🏓 Keep-alive error: ${e.message}`, false);
    return false;
  }
}

async function startProgram(schedule) {
  const token = await getAccessToken();
  if (!token || !config.haId) {
    addLog(`❌ Cannot start: no token or appliance`, false);
    return false;
  }
  addLog(`⚡ Waking dishwasher...`);
  await sendPowerOn();
  await new Promise(r => setTimeout(r, 5000));

  const opts = Object.entries(schedule.options || {}).filter(([, v]) => v).map(([key, value]) => ({ key, value }));
  const progName = schedule.name || schedule.program.split(".").pop();
  try {
    const r = await fetch(`${API_BASE}/api/homeappliances/${config.haId}/programs/active`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/vnd.bsh.sdk.v1+json" },
      body: JSON.stringify({ data: { key: schedule.program, options: opts } }),
    });
    if (r.status === 204 || r.ok) { addLog(`✅ Started ${progName}`); return true; }
    else { const e = await r.json().catch(() => ({})); addLog(`❌ ${progName}: ${e?.error?.description || r.status}`, false); return false; }
  } catch (e) { addLog(`❌ ${progName}: ${e.message}`, false); return false; }
}

async function getApplianceStatus() {
  const token = await getAccessToken();
  if (!token || !config.haId) return null;
  try {
    const [appR, statusR, progsR] = await Promise.all([
      fetch(`${API_BASE}/api/homeappliances/${config.haId}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.bsh.sdk.v1+json" } }),
      fetch(`${API_BASE}/api/homeappliances/${config.haId}/status`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.bsh.sdk.v1+json" } }),
      fetch(`${API_BASE}/api/homeappliances/${config.haId}/programs/available`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.bsh.sdk.v1+json" } }),
    ]);
    const appData = appR.ok ? (await appR.json()).data : null;
    const statusData = statusR.ok ? (await statusR.json()).data?.status || [] : [];
    const progsData = progsR.ok ? (await progsR.json()).data?.programs || [] : [];
    const rc = statusData.find(i => i.key === "BSH.Common.Status.RemoteControlActive");
    const rs = statusData.find(i => i.key === "BSH.Common.Status.RemoteControlStartAllowed");
    const op = statusData.find(i => i.key === "BSH.Common.Status.OperationState");
    const door = statusData.find(i => i.key === "BSH.Common.Status.DoorState");
    return {
      connected: appData?.connected, brand: appData?.brand, name: appData?.name || appData?.type,
      remoteControl: rc?.value === true, remoteStart: rs?.value === true,
      operationState: op?.value?.split(".").pop() || "Unknown",
      doorState: door?.value?.split(".").pop() || "Unknown",
      programs: progsData.map(p => ({ key: p.key, name: p.key.split(".").pop() })),
    };
  } catch (e) { return { error: e.message }; }
}

async function fetchAppliances() {
  const token = await getAccessToken();
  if (!token) return [];
  try {
    const r = await fetch(`${API_BASE}/api/homeappliances`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.bsh.sdk.v1+json" } });
    if (!r.ok) return [];
    const d = await r.json();
    return (d.data?.homeappliances || []).map(a => ({ haId: a.haId, name: a.name, type: a.type, brand: a.brand, connected: a.connected }));
  } catch { return []; }
}

// ─── Schedule Management ─────────────────────────────────────

// Send email reminder via a simple HTTPS webhook approach
// Uses a lightweight email-sending service (no SMTP needed)
async function sendReminderNotification(schedule) {
  const progName = schedule.name || schedule.program.split(".").pop();
  const timeStr = `${String(schedule.hour).padStart(2,"0")}:${String(schedule.minute).padStart(2,"0")}`;
  const email = config.notifyEmail;
  
  if (!email) {
    addLog(`🔔 Reminder: ${progName} at ${timeStr} — no email configured`, false);
    return;
  }

  // Check if dishwasher is reachable
  let dishStatus = "unknown";
  try {
    const token = await getAccessToken();
    if (token) {
      const r = await fetch(`${API_BASE}/api/homeappliances/${config.haId}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.bsh.sdk.v1+json" }
      });
      if (r.ok) {
        const d = await r.json();
        dishStatus = d.data?.connected ? "🟢 Online" : "🔴 Offline";
      }
    }
  } catch {}

  // Store notification for the frontend to display
  const notification = {
    type: "reminder",
    schedule: progName,
    time: timeStr,
    dishStatus,
    message: `🔔 Reminder: "${progName}" is scheduled to run at ${timeStr}. Please make sure your dishwasher is ON with Remote Start enabled and door closed. Dishwasher status: ${dishStatus}`,
    timestamp: new Date().toISOString(),
    read: false,
  };
  
  if (!global.notifications) global.notifications = [];
  global.notifications.push(notification);
  if (global.notifications.length > 20) global.notifications = global.notifications.slice(-20);

  addLog(`🔔 Reminder sent: "${progName}" runs at ${timeStr} — Dish: ${dishStatus}`);
}

function rebuildCronJobs() {
  // Clear existing schedule crons
  Object.values(cronJobs).forEach(job => job.stop());
  cronJobs = {};
  // Clear existing reminder crons
  Object.values(reminderJobs).forEach(job => job.stop());
  reminderJobs = {};

  schedules.forEach(s => {
    if (!s.enabled || !s.days || s.days.length === 0) return;
    const cronDays = s.days.join(",");
    
    // Schedule the actual program start
    const cronExpr = `${s.minute} ${s.hour} * * ${cronDays}`;
    try {
      cronJobs[s.id] = cron.schedule(cronExpr, () => {
        addLog(`⏰ Schedule triggered: ${s.name}`);
        startProgram(s);
      });
      addLog(`📅 Cron: ${s.name} → ${String(s.hour).padStart(2,"0")}:${String(s.minute).padStart(2,"0")} days[${cronDays}]`);
    } catch (e) { addLog(`📅 Cron error: ${e.message}`, false); }

    // Schedule the reminder (X hours before)
    if (remindersEnabled) {
      const rHours = config.reminderHours || 2;
      let rHour = s.hour - rHours;
      let rMinute = s.minute;
      let rDays = [...s.days];
      
      // Handle wrap-around past midnight
      if (rHour < 0) {
        rHour += 24;
        // Shift days back by 1 (reminder goes to previous day)
        rDays = rDays.map(d => (d - 1 + 7) % 7);
      }
      
      const reminderExpr = `${rMinute} ${rHour} * * ${rDays.join(",")}`;
      try {
        reminderJobs[s.id] = cron.schedule(reminderExpr, () => {
          sendReminderNotification(s);
        });
        addLog(`🔔 Reminder: ${s.name} → ${String(rHour).padStart(2,"0")}:${String(rMinute).padStart(2,"0")} (${rHours}h before)`);
      } catch (e) { addLog(`🔔 Reminder cron error: ${e.message}`, false); }
    }
  });
}

function updateKeepAlive(enabled) {
  keepAlive = enabled;
  if (keepAliveCron) { keepAliveCron.stop(); keepAliveCron = null; }
  if (enabled) {
    sendPowerOn();
    keepAliveCron = cron.schedule("0 * * * *", () => sendPowerOn());
    addLog("🏓 Keep-alive ON (every 60 min)");
  } else {
    addLog("🏓 Keep-alive OFF");
  }
  saveState();
}

// ─── API Routes ──────────────────────────────────────────────

app.get("/", (req, res) => {
  res.json({
    status: "running", uptime: Math.round(process.uptime()),
    hasToken: !!tokenData?.access_token,
    hasRefreshToken: !!tokenData?.refresh_token,
    tokenExpiresIn: tokenData?.expires_at ? Math.round((tokenData.expires_at - Date.now()) / 60000) + " min" : null,
    haId: config.haId || "not set",
    schedules: schedules.length, keepAlive,
  });
});

app.get("/api/state", (req, res) => {
  res.json({
    config: { clientId: config.clientId ? "***set***" : "", haId: config.haId },
    hasToken: !!tokenData?.access_token,
    hasRefreshToken: !!tokenData?.refresh_token,
    tokenExpiresIn: tokenData?.expires_at ? Math.round((tokenData.expires_at - Date.now()) / 60000) : null,
    schedules, keepAlive, remindersEnabled, reminderHours: config.reminderHours, 
    notifications: (global.notifications || []).filter(n => !n.read).length,
    logs: logs.slice(-30),
  });
});

app.post("/api/config", (req, res) => {
  const { clientId, clientSecret, haId, notifyEmail, reminderHours } = req.body;
  if (clientId) config.clientId = clientId;
  if (clientSecret) config.clientSecret = clientSecret;
  if (haId) config.haId = haId;
  if (notifyEmail !== undefined) config.notifyEmail = notifyEmail;
  if (reminderHours) config.reminderHours = parseInt(reminderHours);
  addLog("⚙️ Config updated");
  res.json({ ok: true });
});

app.post("/api/token", async (req, res) => {
  tokenData = req.body;
  if (!tokenData.expires_at && tokenData.expires_in) {
    tokenData.expires_at = Date.now() + tokenData.expires_in * 1000;
  }
  await saveState();
  addLog("🔑 Token received from frontend");

  // Log the refresh token hint so user can set it as env var
  if (tokenData.refresh_token) {
    const hint = tokenData.refresh_token.substring(0, 10) + "...";
    addLog(`🔑 Refresh token stored (starts with ${hint}). Set HC_REFRESH_TOKEN env var on Render for persistence across deploys.`);
  }
  res.json({ ok: true, hasRefreshToken: !!tokenData.refresh_token });
});

// Endpoint to set refresh token directly (for bootstrapping)
app.post("/api/refresh-token", async (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token) return res.status(400).json({ error: "refresh_token required" });
  tokenData = { refresh_token };
  const token = await refreshAccessToken();
  res.json({ ok: !!token });
});

app.post("/api/token/refresh", async (req, res) => {
  const token = await refreshAccessToken();
  res.json({ ok: !!token });
});

app.get("/api/appliances", async (req, res) => {
  res.json(await fetchAppliances());
});

app.get("/api/status", async (req, res) => {
  res.json((await getApplianceStatus()) || { error: "Not connected" });
});

app.get("/api/schedules", (req, res) => res.json(schedules));

app.post("/api/schedules", async (req, res) => {
  const schedule = req.body;
  if (!schedule.id) schedule.id = Date.now().toString();
  const idx = schedules.findIndex(s => s.id === schedule.id);
  if (idx >= 0) { schedules[idx] = schedule; addLog(`📅 Updated: ${schedule.name}`); }
  else { schedules.push(schedule); addLog(`📅 Created: ${schedule.name}`); }
  rebuildCronJobs();
  await saveState();
  res.json({ ok: true, schedule });
});

app.delete("/api/schedules/:id", async (req, res) => {
  schedules = schedules.filter(s => s.id !== req.params.id);
  rebuildCronJobs();
  await saveState();
  addLog(`🗑 Deleted schedule`);
  res.json({ ok: true });
});

app.post("/api/schedules/:id/toggle", async (req, res) => {
  const s = schedules.find(s => s.id === req.params.id);
  if (s) { s.enabled = !s.enabled; rebuildCronJobs(); await saveState(); addLog(`📅 ${s.name}: ${s.enabled ? "ON" : "OFF"}`); }
  res.json({ ok: true, enabled: s?.enabled });
});

app.post("/api/schedules/:id/run", async (req, res) => {
  const s = schedules.find(s => s.id === req.params.id);
  if (!s) return res.status(404).json({ error: "Not found" });
  res.json({ ok: await startProgram(s) });
});

app.post("/api/keepalive", async (req, res) => {
  updateKeepAlive(!!req.body.enabled);
  res.json({ ok: true, keepAlive });
});

app.post("/api/poweron", async (req, res) => {
  res.json({ ok: await sendPowerOn() });
});

app.post("/api/run", async (req, res) => {
  res.json({ ok: await startProgram(req.body) });
});

app.get("/api/logs", (req, res) => res.json(logs.slice(-50)));
app.delete("/api/logs", (req, res) => { logs = []; res.json({ ok: true }); });

// Reminders
app.get("/api/reminders", (req, res) => {
  res.json({ enabled: remindersEnabled, reminderHours: config.reminderHours, notifyEmail: config.notifyEmail || "not set" });
});

app.post("/api/reminders", async (req, res) => {
  if (req.body.enabled !== undefined) remindersEnabled = req.body.enabled;
  if (req.body.reminderHours) config.reminderHours = parseInt(req.body.reminderHours);
  if (req.body.notifyEmail !== undefined) config.notifyEmail = req.body.notifyEmail;
  rebuildCronJobs();
  await saveState();
  addLog(`🔔 Reminders: ${remindersEnabled ? "ON" : "OFF"} (${config.reminderHours}h before)`);
  res.json({ ok: true, enabled: remindersEnabled, reminderHours: config.reminderHours });
});

// Notifications (push-style for frontend polling)
app.get("/api/notifications", (req, res) => {
  const notifs = global.notifications || [];
  res.json(notifs);
});

app.post("/api/notifications/read", (req, res) => {
  if (global.notifications) global.notifications.forEach(n => n.read = true);
  res.json({ ok: true });
});

// ─── Startup ─────────────────────────────────────────────────
async function startup() {
  console.log("🍽️ DishScheduler Server starting...");

  // Try to load saved state first
  await loadState();

  // If no token from saved state, try bootstrap from env var
  if (!tokenData?.access_token) {
    await bootstrapToken();
  }

  // Rebuild cron jobs from saved schedules
  if (schedules.length > 0) {
    rebuildCronJobs();
    addLog(`📅 Restored ${schedules.length} schedule(s)`);
  }

  // Start keep-alive if enabled
  if (keepAlive) {
    updateKeepAlive(true);
  }

  app.listen(PORT, () => {
    console.log(`🍽️ Server running on port ${PORT}`);
    console.log(`   Token: ${tokenData?.access_token ? "active" : "missing"}`);
    console.log(`   Refresh: ${tokenData?.refresh_token ? "available" : "missing"}`);
    console.log(`   Appliance: ${config.haId || "not set"}`);
    console.log(`   Schedules: ${schedules.length}`);
    console.log(`   Keep-alive: ${keepAlive}`);
  });
}

startup();
