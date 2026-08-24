// api.js — endpoints the POS terminals call (mount into server.js)
const express = require("express");
const store = require("./db");
const sync = require("./sync");
const printer = require("./printer");

const router = express.Router();

// ---- printing (raw ESC/POS straight to the register's Epson on port 9100) ----

// Print a receipt. Body is the receipt payload from the POS; set open_drawer:true
// on cash sales to fire the drawer kick with the same command.
router.post("/print", async (req, res) => {
  try {
    await printer.printReceipt(req.body || {});
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Pop the cash drawer on its own (cash pickups, no-sales, till checkout).
router.post("/drawer", async (req, res) => {
  try {
    await printer.openDrawer((req.body || {}).printer_ip);
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Diagnostic test print used by the Infrastructure Command Center.
router.post("/print-test", async (req, res) => {
  try {
    await printer.testPrint((req.body || {}).printer_ip, (req.body || {}).station);
    res.json({ ok: true, printers: printer.printers });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Cached catalog: products, operators, registers, settings, discounts, function keys.
router.get("/catalog", (req, res) => {
  const cat = store.getCatalog();
  if (!cat) return res.status(503).json({ error: "Catalog not cached yet — relay has never reached the cloud." });
  // Reflect locally-sold units so cashiers see realistic stock while offline.
  const products = (cat.products || []).map((p) => ({
    ...p,
    stock_qty: Number(p.stock_qty || 0) - store.localStockDelta(p.sku),
  }));
  res.json({ ...cat, products });
});

// Terminals poll this to decide what tender/features to allow.
router.get("/connectivity", (req, res) => res.json(sync.connectivity()));

// Completed sale from a terminal. Cash/check only when offline.
router.post("/sales", (req, res) => {
  const sale = req.body || {};
  if (!sale.transaction_id) return res.status(400).json({ error: "transaction_id required" });
  const conn = sync.connectivity();
  if (!conn.online && !["cash", "check"].includes(sale.payment_method)) {
    return res.status(409).json({ error: "Only cash and check tender are permitted while offline." });
  }
  store.queueSale(sale);
  res.json({ ok: true, transaction_id: sale.transaction_id, queued: true, pending_count: store.pendingCount() });
});

// Unsynced sales, for the store's own reconciliation.
router.get("/pending", (req, res) => res.json({ sales: store.pendingSales(200), count: store.pendingCount() }));

// Force an immediate catalog pull + outbox push.
router.post("/sync", async (req, res) => res.json(await sync.syncOnce()));

module.exports = router;
