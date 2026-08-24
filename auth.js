// auth.js — SureFlow Local Relay (Phase 3)
// Token gate for privileged relay routes (reboot, sync, printing diagnostics,
// backup, self-update). POS routes used by the registers stay open on the LAN so a
// terminal never needs a secret to ring a sale.
const TOKEN = process.env.RELAY_ACCESS_TOKEN || "";

function readToken(req) {
  const header = req.headers["x-relay-token"];
  if (header) return String(header);
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7);
  return req.query?.relay_token || "";
}

// Express middleware — mount on the routes that must be protected.
function requireRelayToken(req, res, next) {
  if (!TOKEN) {
    console.warn("[auth] RELAY_ACCESS_TOKEN is not set — privileged routes are OPEN");
    return next();
  }
  if (readToken(req) === TOKEN) return next();
  return res.status(401).json({ error: "Invalid or missing relay token" });
}

module.exports = { requireRelayToken, tokenConfigured: () => !!TOKEN };
