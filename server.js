import express from "express";
import cron from "node-cron";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_BASE = "https://api.home-connect.com";

// ─── In-memory state (persists as long as server is running) ─
let config = {
  clientId: process.env.HC_CLIENT_ID || "",
  clientSecret: process.env.HC_CLIENT_SECRET || "",
  haId: process.env.HC_APPLIANCE_ID || "",
};
let tokenData = null;
let schedules = [];
let keepAlive = false;
let logs = [];
let cronJobs = {};
let keepAliveCron = null;

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
    tokenData = data;
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

// Auto-refresh token every 20 hours (tokens typically last 24h)
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
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/vnd.bsh.sdk.v1+json",
      },
      body: JSON.stringify({
        data: { key: "BSH.Common.Setting.PowerState", value: "BSH.Common.EnumType.PowerState.On" },
      }),
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
    addLog(`❌ Cannot start program: no token or appliance`, false);
    return false;
  }

  // Wake up first
  addLog(`⚡ Waking dishwasher before starting program...`);
  await sendPowerOn();
  await new Promise((r) => setTimeout(r, 5000));

  const opts = Object.entries(schedule.options || {})
    .filter(([, v]) => v)
    .map(([key, value]) => ({ key, value }));

  const progName = schedule.name || schedule.program.split(".").pop();

  try {
    const r = await fetch(`${API_BASE}/api/homeappliances/${config.haId}/programs/active`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/vnd.bsh.sdk.v1+json",
      },
      body: JSON.stringify({ data: { key: schedule.program, options: opts } }),
    });

    if (r.status === 204 || r.ok) {
      addLog(`✅ Started ${progName}`);
      return true;
    } else {
      const e = await r.json().catch(() => ({}));
      const msg = e?.error?.description || `HTTP ${r.status}`;
      addLog(`❌ Failed ${progName}: ${msg}`, false);
      return false;
    }
  } catch (e) {
    addLog(`❌ ${progName}: ${e.message}`, false);
    return false;
  }
}

async function getApplianceStatus() {
  const token = await getAccessToken();
  if (!token || !config.haId) return null;

  try {
    const [appR, statusR, progsR] = await Promise.all([
      fetch(`${API_BASE}/api/homeappliances/${config.haId}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.bsh.sdk.v1+json" },
      }),
      fetch(`${API_BASE}/api/homeappliances/${config.haId}/status`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.bsh.sdk.v1+json" },
      }),
      fetch(`${API_BASE}/api/homeappliances/${config.haId}/programs/available`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.bsh.sdk.v1+json" },
      }),
    ]);

    const appData = appR.ok ? (await appR.json()).data : null;
    const statusData = statusR.ok ? (await statusR.json()).data?.status || [] : [];
    const progsData = progsR.ok ? (await progsR.json()).data?.programs || [] : [];

    const rc = statusData.find((i) => i.key === "BSH.Common.Status.RemoteControlActive");
    const rs = statusData.find((i) => i.key === "BSH.Common.Status.RemoteControlStartAllowed");
    const op = statusData.find((i) => i.key === "BSH.Common.Status.OperationState");
    const door = statusData.find((i) => i.key === "BSH.Common.Status.DoorState");

    return {
      connected: appData?.connected,
      brand: appData?.brand,
      name: appData?.name || appData?.type,
      remoteControl: rc?.value === true,
      remoteStart: rs?.value === true,
      operationState: op?.value?.split(".").pop() || "Unknown",
      doorState: door?.value?.split(".").pop() || "Unknown",
      programs: progsData.map((p) => ({ key: p.key, name: p.key.split(".").pop() })),
    };
  } catch (e) {
    return { error: e.message };
  }
}

async function fetchAppliances() {
  const token = await getAccessToken();
  if (!token) return [];
  try {
    const r = await fetch(`${API_BASE}/api/homeappliances`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.bsh.sdk.v1+json" },
    });
    if (!r.ok) return [];
    const d = await r.json();
    return (d.data?.homeappliances || []).map((a) => ({
      haId: a.haId, name: a.name, type: a.type, brand: a.brand, connected: a.connected,
    }));
  } catch { return []; }
}

// ─── Schedule Management ─────────────────────────────────────
function rebuildCronJobs() {
  // Clear existing cron jobs
  Object.values(cronJobs).forEach((job) => job.stop());
  cronJobs = {};

  schedules.forEach((s) => {
    if (!s.enabled || !s.days || s.days.length === 0) return;

    // Convert days array [0=Sun..6=Sat] to cron format (0=Sun..6=Sat)
    const cronDays = s.days.join(",");
    const cronExpr = `${s.minute} ${s.hour} * * ${cronDays}`;

    try {
      cronJobs[s.id] = cron.schedule(cronExpr, () => {
        addLog(`⏰ Schedule triggered: ${s.name}`);
        startProgram(s);
      });
      addLog(`📅 Cron set: ${s.name} at ${String(s.hour).padStart(2, "0")}:${String(s.minute).padStart(2, "0")} on days [${cronDays}]`);
    } catch (e) {
      addLog(`📅 Cron error for ${s.name}: ${e.message}`, false);
    }
  });
}

function setKeepAlive(enabled) {
  keepAlive = enabled;
  if (keepAliveCron) {
    keepAliveCron.stop();
    keepAliveCron = null;
  }
  if (enabled) {
    // Send immediately
    sendPowerOn();
    // Then every hour
    keepAliveCron = cron.schedule("0 * * * *", () => {
      sendPowerOn();
    });
    addLog("🏓 Keep-alive enabled (every 60 min)");
  } else {
    addLog("🏓 Keep-alive disabled");
  }
}

// ─── API Routes ──────────────────────────────────────────────

// Health check
app.get("/", (req, res) => {
  res.json({
    status: "running",
    uptime: Math.round(process.uptime()),
    hasToken: !!tokenData,
    haId: config.haId || "not set",
    schedules: schedules.length,
    keepAlive,
  });
});

// Get full state
app.get("/api/state", (req, res) => {
  res.json({
    config: { clientId: config.clientId ? "***set***" : "", haId: config.haId },
    hasToken: !!tokenData,
    tokenExpiresIn: tokenData?.expires_at ? Math.round((tokenData.expires_at - Date.now()) / 60000) : null,
    schedules,
    keepAlive,
    logs: logs.slice(-30),
  });
});

// Set config
app.post("/api/config", (req, res) => {
  const { clientId, clientSecret, haId } = req.body;
  if (clientId) config.clientId = clientId;
  if (clientSecret) config.clientSecret = clientSecret;
  if (haId) config.haId = haId;
  addLog("⚙️ Config updated");
  res.json({ ok: true });
});

// Set token (from frontend after OAuth)
app.post("/api/token", (req, res) => {
  tokenData = req.body;
  if (!tokenData.expires_at && tokenData.expires_in) {
    tokenData.expires_at = Date.now() + tokenData.expires_in * 1000;
  }
  addLog("🔑 Token received from frontend");
  res.json({ ok: true });
});

// Refresh token manually
app.post("/api/token/refresh", async (req, res) => {
  const token = await refreshAccessToken();
  res.json({ ok: !!token });
});

// Get appliances
app.get("/api/appliances", async (req, res) => {
  const list = await fetchAppliances();
  res.json(list);
});

// Get appliance status
app.get("/api/status", async (req, res) => {
  const status = await getApplianceStatus();
  res.json(status || { error: "Not connected" });
});

// Schedules CRUD
app.get("/api/schedules", (req, res) => {
  res.json(schedules);
});

app.post("/api/schedules", (req, res) => {
  const schedule = req.body;
  if (!schedule.id) schedule.id = Date.now().toString();
  const idx = schedules.findIndex((s) => s.id === schedule.id);
  if (idx >= 0) {
    schedules[idx] = schedule;
    addLog(`📅 Updated schedule: ${schedule.name}`);
  } else {
    schedules.push(schedule);
    addLog(`📅 Created schedule: ${schedule.name}`);
  }
  rebuildCronJobs();
  res.json({ ok: true, schedule });
});

app.delete("/api/schedules/:id", (req, res) => {
  const { id } = req.params;
  schedules = schedules.filter((s) => s.id !== id);
  rebuildCronJobs();
  addLog(`🗑 Deleted schedule ${id}`);
  res.json({ ok: true });
});

app.post("/api/schedules/:id/toggle", (req, res) => {
  const s = schedules.find((s) => s.id === req.params.id);
  if (s) {
    s.enabled = !s.enabled;
    rebuildCronJobs();
    addLog(`📅 ${s.name}: ${s.enabled ? "enabled" : "disabled"}`);
  }
  res.json({ ok: true, enabled: s?.enabled });
});

app.post("/api/schedules/:id/run", async (req, res) => {
  const s = schedules.find((s) => s.id === req.params.id);
  if (!s) return res.status(404).json({ error: "Schedule not found" });
  const ok = await startProgram(s);
  res.json({ ok });
});

// Keep-alive
app.post("/api/keepalive", (req, res) => {
  const { enabled } = req.body;
  setKeepAlive(!!enabled);
  res.json({ ok: true, keepAlive });
});

// Manual power on
app.post("/api/poweron", async (req, res) => {
  const ok = await sendPowerOn();
  res.json({ ok });
});

// Run a program directly
app.post("/api/run", async (req, res) => {
  const ok = await startProgram(req.body);
  res.json({ ok });
});

// Logs
app.get("/api/logs", (req, res) => {
  res.json(logs.slice(-50));
});

// Clear logs
app.delete("/api/logs", (req, res) => {
  logs = [];
  res.json({ ok: true });
});

// ─── Start Server ────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🍽️ DishScheduler Server running on port ${PORT}`);
  console.log(`   Config: clientId=${config.clientId ? "set" : "missing"}, haId=${config.haId || "missing"}`);

  // Auto-start keep-alive if env var set
  if (process.env.HC_KEEP_ALIVE === "true") {
    setKeepAlive(true);
  }
});
