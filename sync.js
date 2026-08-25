// sync.js — talks to the cloud relaySync endpoint
const store = require("./db");

const CLOUD_URL = process.env.CLOUD_SYNC_URL;   // relaySync function endpoint
const STORE_ID  = process.env.STORE_ID;
const API_KEY   = process.env.CLOUD_API_KEY;    // per-store key from the Command Center

let online = false;
let lastSyncAt = null;
let pendingCommands = [];
let consecutiveFailures = 0;
let lastError = null;

// A missing env var used to fail silently every tick and look like "sync never runs",
// so the config is validated once at startup and reported through /connectivity.
const missingConfig = ["CLOUD_SYNC_URL", "STORE_ID", "CLOUD_API_KEY"].filter((k) => !process.env[k]);

async function callCloud(payload) {
  const res = await fetch(CLOUD_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ store_id: STORE_ID, api_key: API_KEY, ...payload }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
  return data;
}

// ---- pushed status + queued commands (the cloud cannot reach into this LAN) ----
// The portal is in the cloud and this relay usually sits on a private store network, so
// nothing can open a connection inward. Instead the relay reports its own health UP on
// each pass and collects any operation an admin queued, running it here on the box.
const PORT = process.env.PORT || 3000;
const RELAY_TOKEN = process.env.RELAY_ACCESS_TOKEN || "";

async function localCall(path, method, body, timeoutMs) {
  const res = await fetch("http://127.0.0.1:" + PORT + path, {
    method: method || "GET",
    headers: Object.assign(
      { "Content-Type": "application/json" },
      RELAY_TOKEN ? { "X-Relay-Token": RELAY_TOKEN } : {}
    ),
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs || 15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
  return data;
}

// The relay's own /status, exactly as the portal used to poll it. Reusing the route
// means the pushed payload and the polled one can never drift apart.
async function collectStatus() {
  try {
    return await localCall("/status", "GET", null, 8000);
  } catch (e) {
    console.error("[sync] could not read local /status:", e.message);
    return null;
  }
}

const COMMAND_ROUTES = {
  reboot_vm:   { path: "/proxmox/reboot",  timeout: 10000 },
  backup:      { path: "/ops/backup",      timeout: 180000 },
  self_update: { path: "/ops/self-update", timeout: 180000 },
  lane_reboot: { path: "/lane/reboot",     timeout: 15000 },
  test_print:  { path: "/api/print-test",  timeout: 45000 },
};

async function runCommand(cmd) {
  // force_sync IS this pass — by the time the command is in hand the catalog has been
  // pulled and the outbox pushed, so there is nothing further to do.
  if (cmd.command_type === "force_sync") return "Sync pass completed on the relay.";

  const route = COMMAND_ROUTES[cmd.command_type];
  if (!route) throw new Error("Unknown command type: " + cmd.command_type);

  const body = Object.assign({}, cmd.payload || {}, cmd.register_id ? { register_id: cmd.register_id } : {});
  const out = await localCall(route.path, "POST", body, route.timeout);
  return out.output || out.message || "ok";
}

// A claimed command is always answered — completed or failed. Silence would leave it
// stuck as 'claimed' in the portal with no way to tell what happened.
// reboot_vm is acked as soon as the route accepts it, because the box goes down a
// second later and there would be no process left to report from.
async function drainCommands(list) {
  for (const cmd of list || []) {
    if (!cmd || !cmd.command_id) continue;
    try {
      const detail = await runCommand(cmd);
      await callCloud({
        action: "command_result",
        command_id: cmd.command_id,
        result: "completed",
        detail: String(detail).slice(0, 900),
      });
      console.log("[sync] ran queued command " + cmd.command_type);
    } catch (e) {
      await callCloud({
        action: "command_result",
        command_id: cmd.command_id,
        result: "failed",
        detail: e.message,
      }).catch(() => {});
      console.error("[sync] queued command " + cmd.command_type + " failed:", e.message);
    }
  }
}

// Pull the catalog down and overwrite the local cache (cloud always wins). The same
// call carries this store's status telemetry up and brings queued commands back.
async function pullCatalog() {
  const status = await collectStatus();
  const data = await callCloud(status ? { action: "pull", status: status } : { action: "pull" });
  store.saveCatalog(data);
  pendingCommands = data.pending_commands || [];
  return data.records_pulled || 0;
}

// Push queued offline sales up, oldest first. Idempotent on transaction_id.
async function pushSales() {
  const rows = store.pendingSales(50);
  if (rows.length === 0) return 0;
  const data = await callCloud({ action: "push", sales: rows.map((r) => r.sale) });
  const done = [...(data.accepted || []), ...(data.duplicates || [])];
  store.markSynced(done);
  for (const f of data.failures || []) store.markFailed(f.transaction_id, f.error);
  return done.length;
}

async function syncOnce(opts) {
  if (missingConfig.length) {
    lastError = "Relay .env is missing: " + missingConfig.join(", ");
    online = false;
    return { ok: false, error: lastError };
  }
  try {
    if (!(opts && opts.pushOnly)) await pullCatalog();
    await pushSales();
    // Commands run only after the catalog and outbox are settled, so an operation that
    // reboots the box can never strand a queued sale.
    if (pendingCommands.length) {
      const batch = pendingCommands;
      pendingCommands = [];
      await drainCommands(batch);
    }
    online = true;
    consecutiveFailures = 0;
    lastError = null;
    lastSyncAt = new Date().toISOString();
    return { ok: true, last_sync_at: lastSyncAt };
  } catch (e) {
    consecutiveFailures++;
    if (consecutiveFailures >= 2) online = false;  // two strikes = offline mode
    lastError = e.message;
    console.error("[sync] failed:", e.message);
    return { ok: false, error: e.message };
  }
}

function connectivity() {
  const cat = store.getCatalog();
  const ageMs = cat ? Date.now() - new Date(cat.cached_at).getTime() : null;
  return {
    online,
    last_sync_at: lastSyncAt,
    last_error: lastError,
    config_ok: missingConfig.length === 0,
    missing_config: missingConfig,
    pending_count: store.pendingCount(),
    catalog_cached_at: cat ? cat.cached_at : null,
    catalog_stale: ageMs === null ? true : ageMs > 24 * 60 * 60 * 1000, // 24h stale limit
  };
}

// Catalog pull every 5 minutes, outbox push attempt every 30 seconds.
// The 30s tick is push-only: pulling the whole catalog twice a minute hammered the
// cloud endpoint and a pull failure kept queued sales from ever being pushed.
function start() {
  if (missingConfig.length) {
    console.error("[sync] NOT STARTED — missing .env values: " + missingConfig.join(", "));
    return;
  }
  console.log("[sync] worker started for store " + STORE_ID + " -> " + CLOUD_URL);
  syncOnce();
  setInterval(() => syncOnce(), 5 * 60 * 1000);
  setInterval(() => syncOnce({ pushOnly: true }), 30 * 1000);
}

module.exports = { start, syncOnce, connectivity };
