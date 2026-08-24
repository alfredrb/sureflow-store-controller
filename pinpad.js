// pinpad.js — Ingenico customer-facing pinpad (signature, prompts, entry, rating)
const net = require("net");

const BUILD = "pinpad-build 1";
const DEFAULT_PORT = Number(process.env.PINPAD_PORT || 12000);

const STX = "\x02", ETX = "\x03", ACK = "\x06", NAK = "\x15";

// LRC over the frame body, as Ingenico's serial framing expects.
function lrc(body) {
  let acc = 0;
  for (const ch of body) acc ^= ch.charCodeAt(0);
  return String.fromCharCode(acc);
}
function frame(body) { return STX + body + ETX + lrc(body + ETX); }

// ── Model command profiles ────────────────────────────────────────────────────
// Each profile turns a POS intent into one or more frames, and parses the reply.
// A profile may also be sourced from the Hardware Library (pinpad_commands JSON)
// so a model can be tuned without redeploying the relay.
const PROFILES = {
  isc250: {
    port: DEFAULT_PORT,
    // Screen control
    clear:      () => frame("W0"),
    display:    (p) => frame("W1" + [p.title || "", ...(p.lines || [])].join("|").slice(0, 240)),
    cart:       (p) => frame("W2" + [
                    "ITEMS " + (p.item_count || 0),
                    ...(p.lines || []).map(l => (l.qty > 1 ? l.qty + "x " : "") + l.name + "  " + l.amount),
                    "SUBTOTAL " + p.subtotal,
                    "TAX " + p.tax,
                    "TOTAL " + p.total,
                  ].join("|").slice(0, 480)),
    // Blocking interactions
    signature:  (p) => frame("S0" + (p.title || "PLEASE SIGN")),
    input:      (p) => frame("I0" + (p.max_length || 24) + "|" + (p.title || "ENTER NUMBER")),
    confirm:    (p) => frame("C0" + (p.amount || "0.00")),
    rating:     (p) => frame("R0" + (p.title || "HOW WAS YOUR VISIT?")),
    cancel:     () => frame("X0"),
    // Replies arrive as STX <tag> <payload> ETX LRC. Signature payload is the
    // pad's bitmap, base64 encoded by the pad firmware.
    parse(raw) {
      const body = raw.replace(/^\x02/, "").replace(/\x03.*$/, "");
      const tag = body.slice(0, 2);
      const payload = body.slice(2);
      if (tag === "SR") return { image_base64: payload, format: "png" };
      if (tag === "IR") return { value: payload.replace(/[^0-9]/g, "") };
      if (tag === "CR") return { approved: payload.trim() === "1" };
      if (tag === "RR") return { rating: Number(payload.trim()) || null };
      if (tag === "XR" || payload === "CANCEL") return { cancelled: true };
      return { raw: payload };
    },
  },

  // Lane/7000 (Tetra) — reserved. Its display and signature primitives go through
  // Ingenico's Terminal API rather than these raw frames, so the POS treats this
  // profile as unsupported until the block below is filled in.
  lane_7000: null,
};

function profileFor(key) {
  const p = PROFILES[key];
  if (!p) throw new Error("Pinpad profile not supported on this relay: " + key);
  return p;
}
function resolveIp(ip) {
  if (!ip) throw new Error("No pinpad IP configured for this lane");
  return ip;
}

// Fire-and-forget write — screen updates never block the lane.
function send(ip, port, payload) {
  return new Promise((resolve, reject) => {
    const sock = new net.Socket();
    sock.setTimeout(5000);
    sock.once("error", reject);
    sock.once("timeout", () => { sock.destroy(); reject(new Error("Pinpad timeout at " + ip)); });
    sock.connect(port, ip, () => sock.end(Buffer.from(payload, "binary"), () => resolve(true)));
  });
}

// Request/response — hold the socket open while the customer acts on the pad.
// Like the cheque reader, the pad streams and then stops, so the read settles on a
// quiet period rather than a terminator.
function ask(ip, port, payload, profile, timeoutMs) {
  const target = resolveIp(ip);
  return new Promise((resolve, reject) => {
    const sock = new net.Socket();
    let buf = "", done = false, quiet = null;
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      clearTimeout(timer); clearTimeout(quiet);
      try { sock.end(); } catch (e) {}
      fn(arg);
    };
    const timer = setTimeout(() => {
      try { sock.write(Buffer.from(profile.cancel(), "binary")); } catch (e) {}
      finish(reject, new Error("Customer did not respond on the pinpad"));
    }, timeoutMs);

    sock.once("error", (e) => finish(reject, e));
    sock.on("data", (d) => {
      buf += d.toString("binary");
      if (buf === ACK) { buf = ""; return; }          // command accepted, keep waiting
      if (buf === NAK) return finish(reject, new Error("Pinpad rejected the command"));
      clearTimeout(quiet);
      quiet = setTimeout(() => {
        const out = profile.parse(buf);
        if (out.cancelled) return finish(reject, new Error("Cancelled on the pinpad"));
        finish(resolve, { ...out, build: BUILD });
      }, 400);
    });
    sock.connect(port, target, () => sock.write(Buffer.from(payload, "binary")));
  });
}

module.exports = {
  BUILD,
  clear:     (b) => { const p = profileFor(b.profile); return send(resolveIp(b.pinpad_ip), p.port, p.clear()); },
  display:   (b) => { const p = profileFor(b.profile); return send(resolveIp(b.pinpad_ip), p.port, p.display(b)); },
  cart:      (b) => { const p = profileFor(b.profile); return send(resolveIp(b.pinpad_ip), p.port, p.cart(b)); },
  cancel:    (b) => { const p = profileFor(b.profile); return send(resolveIp(b.pinpad_ip), p.port, p.cancel()); },
  signature: (b) => { const p = profileFor(b.profile); return ask(b.pinpad_ip, p.port, p.signature(b), p, 85000); },
  input:     (b) => { const p = profileFor(b.profile); return ask(b.pinpad_ip, p.port, p.input(b), p, 85000); },
  confirm:   (b) => { const p = profileFor(b.profile); return ask(b.pinpad_ip, p.port, p.confirm(b), p, 85000); },
  rating:    (b) => { const p = profileFor(b.profile); return ask(b.pinpad_ip, p.port, p.rating(b), p, 40000); },
};
