// laneReboot.js — SureFlow Local Relay
// Pending-reboot queue for the diskless lanes. lane-reboot-build 2
//
// In-memory on purpose: a queued reboot must NOT survive a relay restart, or a lane
// could pick up a stale command hours later and reboot in the middle of a sale.
const pending = new Map();   // register_id -> { requested_at, requested_by }
const TTL_MS = 2 * 60 * 1000; // a reboot not collected within 2 minutes is abandoned

// Seen-lane register. Every agent poll stamps its register_id here, which is the ONLY
// way the relay learns a lane is alive — it cannot probe the PXE VLAN inbound, and the
// source IP on a lane request is the controller's, not the lane's. In memory on purpose:
// after a relay restart "seen" should mean "has polled since the relay came up", not a
// stale claim about a lane that may have been switched off hours ago.
const seen = new Map();      // register_id -> { last_seen, polls }

function normalizeRegister(value) {
  return String(value || "").trim().toUpperCase();
}

function queueReboot(registerId, requestedBy) {
  const id = normalizeRegister(registerId);
  if (!id) throw new Error("register_id is required");
  pending.set(id, { requested_at: Date.now(), requested_by: requestedBy || "unknown" });
  return { ok: true, register_id: id };
}

// Called by the lane agent. Consumes the command so it only ever fires once.
function claimReboot(registerId) {
  const id = normalizeRegister(registerId);
  if (id) {
    // The poll itself is the heartbeat, so no extra call from the lane is needed.
    const prev = seen.get(id);
    seen.set(id, { last_seen: Date.now(), polls: (prev?.polls || 0) + 1 });
  }
  const entry = pending.get(id);
  if (!entry) return { reboot: false };
  pending.delete(id);
  if (Date.now() - entry.requested_at > TTL_MS) {
    return { reboot: false, expired: true };
  }
  return { reboot: true, requested_by: entry.requested_by };
}

function listPending() {
  const now = Date.now();
  return [...pending.entries()]
    .filter(([, v]) => now - v.requested_at <= TTL_MS)
    .map(([register_id, v]) => ({ register_id, ...v }));
}

// Every lane that has ever polled since the relay started, newest first, with how long
// ago it last checked in. A lane that has stopped polling is either powered off, still
// booting, or running a root without the agent.
function listSeen() {
  const now = Date.now();
  return [...seen.entries()]
    .map(([register_id, v]) => ({
      register_id,
      last_seen: new Date(v.last_seen).toISOString(),
      seconds_ago: Math.round((now - v.last_seen) / 1000),
      polls: v.polls,
      reboot_pending: pending.has(register_id),
    }))
    .sort((a, b) => a.seconds_ago - b.seconds_ago);
}

module.exports = { queueReboot, claimReboot, listPending, listSeen };
