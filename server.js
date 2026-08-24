// server.js — SureFlow Local Relay (complete: phase 3 + cheque + pinpad + pole + lane reboot)
const express = require("express");
const os = require("os");
const path = require("path");
const { execSync, exec } = require("child_process");

// Core relay modules (from the original build)
const apiRouter = require("./api");
// sync.js exports start() — aliased here because the boot hook below calls
// startSync(). Importing the wrong name made the relay throw
// "startSync is not a function" the moment it began listening, which killed the
// sync worker and left every lane showing OFFLINE MODE.
const { start: startSync } = require("./sync");
const { requireRelayToken, tokenConfigured } = require("./auth");
const { printerTelemetry, recordHeartbeat, liveRegisters } = require("./telemetry");

// Peripheral + control modules (added since)
const checkReader = require("./checkReader");   // check-reader-build 5 (two-pass endorsement)
const pinpad = require("./pinpad");             // pinpad-build 1
const pole = require("./poledisplay");          // pole-build 1
const { queueReboot, claimReboot, listPending } = require("./laneReboot"); // lane-reboot-build 2

const app = express();
app.use(express.json({ limit: "1mb" }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,X-Relay-Token,Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const PRINTER_IPS = (process.env.PRINTER_IPS || "").split(",").map((s) => s.trim()).filter(Boolean);
const PORT = process.env.PORT || 3000;
const RELAY_DIR = __dirname;

function vmStats() {
  const total = os.totalmem(), free = os.freemem();
  let disk_pct = 0;
  try { disk_pct = parseInt(execSync("df --output=pcent / | tail -1").toString().trim()); } catch {}
  return {
    cpu_pct: Math.min(100, Math.round((os.loadavg()[0] / os.cpus().length) * 100)),
    ram_pct: Math.round(((total - free) / total) * 100),
    disk_pct,
    uptime_seconds: Math.round(os.uptime()),
  };
}

// ───────────────────────── OPEN ROUTES (store LAN) ─────────────────────────

// Live store telemetry for the Infrastructure Command Center. The build stamps are
// reported here so the portal can tell which relays are behind.
app.get("/status", async (req, res) => {
  const printers = await Promise.all(PRINTER_IPS.map((ip) => printerTelemetry(ip)));
  res.json({
    store_id: process.env.STORE_ID,
    phase: 3,
    secured: tokenConfigured(),
    check_reader: checkReader.BUILD,
    pinpad: pinpad.BUILD,
    pole: pole.BUILD,
    lane_reboot: "lane-reboot-build 2",
    vm_stats: vmStats(),
    printers,
    registers: liveRegisters(),
  });
});

// Terminals report their own device health every 60 seconds.
app.post("/api/heartbeat", (req, res) => {
  try { res.json(recordHeartbeat(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// Kiosk provisioning — hands the stored cloud session to a terminal and lands it
// directly on the POS login with its own register pre-selected.
app.get("/kiosk", (req, res) => {
  const token = process.env.KIOSK_ACCESS_TOKEN;
  if (!token) return res.status(503).json({ error: "KIOSK_ACCESS_TOKEN is not set" });
  const reg = String(req.query.register_id || "").replace(/[^\w-]/g, "");
  res.redirect("/pos/login?access_token=" + encodeURIComponent(token) +
    (reg ? "&register_id=" + encodeURIComponent(reg) : ""));
});

// Source address as seen by the relay.
// WARNING: for a lane on the isolated PXE VLAN this reports the CONTROLLER's address,
// because the controller NATs that segment. It is NOT the lane's IP and must never be
// used to identify or reach a lane — use the register_id from the kernel command line.
app.get("/api/whoami", (req, res) => {
  const raw = req.socket.remoteAddress || "";
  res.json({ ip: raw.replace(/^::ffff:/, ""), note: "may be the PXE controller, not the lane" });
});

// POS routes (catalog, offline sales, printing) stay open on the store LAN.
app.use("/api", apiRouter);

// ───────────────────────── CHEQUE STATION ─────────────────────────
// Blocking read: the printer waits for the operator to insert the cheque, so the POS
// calls this with a long client timeout while showing an "insert cheque" prompt.
app.post("/api/check/read", async (req, res) => {
  try { res.json({ ok: true, ...(await checkReader.readMicr(req.body.printer_ip)) }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// Pass 2 — print the endorsement legend on the BACK of the reinserted cheque, eject.
app.post("/api/check/frank", async (req, res) => {
  try { await checkReader.frankCheck(req.body || {}); res.json({ ok: true }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// Release a cheque without franking (declined tender / aborted read).
app.post("/api/check/eject", async (req, res) => {
  try { await checkReader.ejectCheck(req.body.printer_ip); res.json({ ok: true }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// ───────────────────────── PINPAD ─────────────────────────
// Screen updates: fire-and-forget, never allowed to hold up the lane.
for (const route of ["cart", "display", "clear", "cancel"]) {
  app.post("/api/pinpad/" + route, async (req, res) => {
    try { await pinpad[route](req.body || {}); res.json({ ok: true }); }
    catch (e) { res.status(502).json({ error: e.message }); }
  });
}

// Blocking customer interactions. The POS calls these with long client timeouts and
// shows its own "look at the pinpad" prompt while they run.
for (const route of ["signature", "input", "confirm", "rating"]) {
  app.post("/api/pinpad/" + route, async (req, res) => {
    try { res.json({ ok: true, ...(await pinpad[route](req.body || {})) }); }
    catch (e) { res.status(502).json({ error: e.message }); }
  });
}

// ───────────────────────── POLE DISPLAY ─────────────────────────
for (const route of ["show", "idle"]) {
  app.post("/api/pole/" + route, async (req, res) => {
    try { await pole[route](req.body || {}); res.json({ ok: true }); }
    catch (e) { res.status(502).json({ error: e.message }); }
  });
}

// ───────────────────────── LANE REBOOT (claim side) ─────────────────────────
// OPEN on purpose: the lane agent polling this has no relay token, and the route only
// ever returns that lane's own flag, which is consumed on read.
app.get("/lane/reboot-pending", (req, res) => {
  res.json(claimReboot(req.query && req.query.register_id));
});

// ───────────────────── PRIVILEGED ROUTES (relay token) ─────────────────────

// Queue a lane reboot. The relay CANNOT reach a lane, so this only records the
// request — the lane's own agent collects it on its next poll (~10s).
app.post("/lane/reboot", requireRelayToken, (req, res) => {
  try {
    const out = queueReboot(req.body && req.body.register_id, req.body && req.body.requested_by);
    console.log("[lane-reboot] queued " + out.register_id);
    res.json({ ...out, queued: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/lane/reboot-queue", requireRelayToken, (req, res) => {
  res.json({ pending: listPending() });
});

// Reboot the RELAY VM itself (not a lane).
app.post("/proxmox/reboot", requireRelayToken, (req, res) => {
  res.json({ ok: true, message: "Reboot scheduled" });
  setTimeout(() => exec("sudo /sbin/reboot"), 1000);
});

app.post("/ops/backup", requireRelayToken, (req, res) => {
  exec(RELAY_DIR + "/sureflow-backup.sh backup", (err, stdout, stderr) => {
    if (err) return res.status(500).json({ error: (stderr || err.message).trim() });
    res.json({ ok: true, output: stdout.trim() });
  });
});

app.post("/ops/self-update", requireRelayToken, (req, res) => {
  res.json({ ok: true, message: "Update started — the relay will restart" });
  exec(RELAY_DIR + "/sureflow-selfupdate.sh");
});

// ───────────────── STATIC POS + SPA CATCH-ALL (must stay last) ─────────────────
const POS_DIR = path.join(RELAY_DIR, "pos-dist");
app.use(express.static(POS_DIR));

// SPA fallback. sendFile's callback also fires on SUCCESS (err undefined), so the
// error branch must be guarded — replying unconditionally throws
// ERR_HTTP_HEADERS_SENT and kills the process on every page load.
app.use((req, res) => {
  res.sendFile(path.join(POS_DIR, "index.html"), (err) => {
    if (!err) return;
    if (res.headersSent) return res.destroy();
    res.status(404).json({ error: "POS build not deployed on this relay" });
  });
});

// Last-resort guards: a relay must never take the store's sales path down over a
// single bad request or a stray socket error.
app.use((err, req, res, next) => {
  console.error("[relay] request error:", err && err.message);
  if (res.headersSent) return res.destroy();
  res.status(500).json({ error: "Relay request failed" });
});
process.on("unhandledRejection", (e) => console.error("[relay] unhandled rejection:", e));
process.on("uncaughtException", (e) => console.error("[relay] uncaught exception:", e));

app.listen(PORT, () => {
  console.log("SureFlow relay (complete) for store " + process.env.STORE_ID + " on :" + PORT);
  console.log(checkReader.BUILD + " | " + pinpad.BUILD + " | " + pole.BUILD + " | lane-reboot-build 2");
  console.log("privileged routes " + (tokenConfigured() ? "secured with RELAY_ACCESS_TOKEN" : "OPEN — set RELAY_ACCESS_TOKEN"));
  startSync();
});
