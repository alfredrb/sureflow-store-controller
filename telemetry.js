// telemetry.js — SureFlow Local Relay (Phase 3)
// Real printer supply levels over SNMP + in-memory register heartbeat registry.
const net = require("net");

let snmp = null;
try { snmp = require("net-snmp"); } catch { /* SNMP optional — falls back to reachability only */ }

const COMMUNITY = process.env.SNMP_COMMUNITY || "public";
const HEARTBEAT_TTL_MS = 120000; // a register is "live" for 2 minutes after its last beat

// Thermal receipt printers have no metered consumable, so Epson TMNet leaves the
// Printer-MIB supply table (1.3.6.1.2.1.43.11) empty — it only ever answers
// noSuchName there. Paper state comes from the ESC/POS real-time status command
// instead, on the same port 9100 we already print to. SNMP is used only for the
// model name, and only over v1 (TMNet does not answer v2c reliably).
const OID_MODEL = "1.3.6.1.2.1.43.5.1.1.16.1";

function snmpModel(ip) {
  return new Promise((resolve) => {
    if (!snmp) return resolve(null);
    const session = snmp.createSession(ip, COMMUNITY, { timeout: 2000, retries: 0, version: snmp.Version1 });
    session.get([OID_MODEL], (err, varbinds) => {
      session.close();
      if (err || !varbinds || snmp.isVarbindError(varbinds[0])) return resolve(null);
      resolve(String(varbinds[0].value));
    });
  });
}

// ESC/POS real-time status: DLE EOT 4 asks the paper roll sensor. The printer
// answers with one status byte — bit 3 = paper out, bit 2 = paper near-end.
const DLE_EOT_PAPER = Buffer.from([0x10, 0x04, 0x04]);

function escposPaperStatus(ip, port = 9100, timeout = 2000) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (v) => { if (!done) { done = true; sock.destroy(); resolve(v); } };
    sock.setTimeout(timeout);
    sock.once("connect", () => sock.write(DLE_EOT_PAPER));
    sock.once("data", (buf) => {
      const b = buf[buf.length - 1];
      if (b & 0x08) return finish("out");
      if (b & 0x04) return finish("low");
      finish("ok");
    });
    sock.once("error", () => finish("unknown"));
    sock.once("timeout", () => finish("unknown"));
    sock.connect(port, ip);
  });
}

// TCP probe on 9100 (ESC/POS raw print port)
function probePort(ip, port = 9100, timeout = 1500) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(timeout);
    sock.once("connect", () => { sock.destroy(); resolve(true); });
    sock.once("error", () => resolve(false));
    sock.once("timeout", () => { sock.destroy(); resolve(false); });
    sock.connect(port, ip);
  });
}

// A thermal roll has no measurable remaining capacity — the sensor is a three-state
// signal. These indicative numbers keep the existing gauge UI meaningful.
const PCT_FOR_STATUS = { ok: 100, low: 15, out: 0 };

// Full telemetry for one printer: reachability + real paper state over ESC/POS.
async function printerTelemetry(ip) {
  const reachable = await probePort(ip);
  let paper_status = "unknown";
  let model = null;
  if (reachable) {
    [paper_status, model] = await Promise.all([escposPaperStatus(ip), snmpModel(ip)]);
  }
  return {
    ip,
    model: model || "Epson TM-H6000",
    reachable,
    paper_pct: PCT_FOR_STATUS[paper_status] ?? null,
    paper_status,
    snmp: !!snmp,
    last_used: lastUsed[ip] || null,
  };
}

// Printers record their own last-used time when a receipt is sent through printer.js.
const lastUsed = {};
function markPrinterUsed(ip) { if (ip) lastUsed[ip] = new Date().toISOString(); }

// ---- Register heartbeats ----
// Terminals POST /api/heartbeat every 60s with their own device health. The relay
// keeps the latest beat per register and expires it after HEARTBEAT_TTL_MS.
const beats = new Map();

function recordHeartbeat(body = {}) {
  const id = String(body.register_id || "").trim();
  if (!id) throw new Error("register_id is required");
  beats.set(id, {
    register_id: id,
    name: body.name || id,
    operator_name: body.operator_name || null,
    printer_status: body.printer_status || "unknown",
    scanner_status: body.scanner_status || "unknown",
    cash_drawer_status: body.cash_drawer_status || "unknown",
    printer_ip: body.printer_ip || null,
    app_version: body.app_version || null,
    offline_mode: !!body.offline_mode,
    last_beat: new Date().toISOString(),
  });
  return { ok: true, register_id: id };
}

function liveRegisters() {
  const now = Date.now();
  return [...beats.values()].map((b) => ({
    ...b,
    online: now - new Date(b.last_beat).getTime() < HEARTBEAT_TTL_MS,
  }));
}

module.exports = { printerTelemetry, probePort, markPrinterUsed, recordHeartbeat, liveRegisters };
