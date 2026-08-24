// db.js — local SQLite store for catalog cache + offline sale outbox
const Database = require("better-sqlite3");
const db = new Database(process.env.DB_PATH || "/opt/sureflow-relay/relay.db");

db.pragma("journal_mode = WAL");

db.exec("CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, payload TEXT NOT NULL, cached_at TEXT NOT NULL)");
db.exec("CREATE TABLE IF NOT EXISTS pending_sales (transaction_id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL, synced INTEGER NOT NULL DEFAULT 0, synced_at TEXT, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT)");
db.exec("CREATE TABLE IF NOT EXISTS local_stock (sku TEXT PRIMARY KEY, delta INTEGER NOT NULL DEFAULT 0)");

module.exports = {
  // ---- catalog cache ----
  saveCatalog(payload) {
    db.prepare("INSERT INTO cache (key,payload,cached_at) VALUES ('catalog',?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload, cached_at=excluded.cached_at")
      .run(JSON.stringify(payload), payload.cached_at || new Date().toISOString());
  },
  getCatalog() {
    const row = db.prepare("SELECT payload, cached_at FROM cache WHERE key='catalog'").get();
    if (!row) return null;
    const parsed = JSON.parse(row.payload);
    parsed.cached_at = row.cached_at;
    return parsed;
  },

  // ---- offline sale outbox ----
  queueSale(sale) {
    db.prepare("INSERT OR IGNORE INTO pending_sales (transaction_id,payload,created_at) VALUES (?,?,?)")
      .run(sale.transaction_id, JSON.stringify(sale), new Date().toISOString());
    const bump = db.prepare("INSERT INTO local_stock (sku,delta) VALUES (?,?) ON CONFLICT(sku) DO UPDATE SET delta = delta + excluded.delta");
    for (const it of sale.items || []) if (it.sku) bump.run(it.sku, Number(it.qty || 0));
  },
  pendingSales(limit = 50) {
    return db.prepare("SELECT transaction_id,payload,attempts,last_error,created_at FROM pending_sales WHERE synced=0 ORDER BY created_at LIMIT ?")
      .all(limit).map((r) => ({ ...r, sale: JSON.parse(r.payload) }));
  },
  pendingCount() {
    return db.prepare("SELECT COUNT(*) c FROM pending_sales WHERE synced=0").get().c;
  },
  markSynced(ids) {
    const stmt = db.prepare("UPDATE pending_sales SET synced=1, synced_at=? WHERE transaction_id=?");
    const now = new Date().toISOString();
    for (const id of ids) stmt.run(now, id);
  },
  markFailed(id, error) {
    db.prepare("UPDATE pending_sales SET attempts = attempts + 1, last_error = ? WHERE transaction_id = ?").run(String(error).slice(0, 500), id);
  },
  localStockDelta(sku) {
    const row = db.prepare("SELECT delta FROM local_stock WHERE sku=?").get(sku);
    return row ? row.delta : 0;
  },
};
