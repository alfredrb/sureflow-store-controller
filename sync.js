// sync.js — talks to the cloud relaySync endpoint
const store = require("./db");

const CLOUD_URL = process.env.CLOUD_SYNC_URL;   // relaySync function endpoint
const STORE_ID  = process.env.STORE_ID;
const API_KEY   = process.env.CLOUD_API_KEY;    // per-store key from the Command Center

let online = false;
let lastSyncAt = null;
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

// Pull the catalog down and overwrite the local cache (cloud always wins).
async function pullCatalog() {
  const data = await callCloud({ action: "pull" });
  store.saveCatalog(data);
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
