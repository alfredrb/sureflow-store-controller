// poledisplay.js — customer pole display (line display)
const net = require("net");

const BUILD = "pole-build 1";
const DEFAULT_PORT = Number(process.env.POLE_PORT || 9100);
// Port the lane's ser2net bridge publishes a USB pole on. Bridge-transport
// profiles use this instead of the printer port.
const BRIDGE_PORT = Number(process.env.POLE_BRIDGE_PORT || 9101);
const IDLE_LINE_1 = process.env.POLE_IDLE_LINE_1 || "*** WELCOME ***";
const IDLE_LINE_2 = process.env.POLE_IDLE_LINE_2 || "";

const ESC = "\x1b", CLR = "\x0c";
const COLS = 20;
const pad = (s) => String(s || "").slice(0, COLS).padEnd(COLS);

// ── Model command profiles ────────────────────────────────────────────────────
const PROFILES = {
  // Epson DM-D110 on the TM printer's DM-D port. ESC = n selects the peripheral:
  // 2 = customer display, 1 = printer. CLR (0x0C) clears the display; the two
  // padded 20-column rows then fill it exactly.
  epson_dmd110: {
    port: DEFAULT_PORT,
    frame(lines) {
      return (
        ESC + "=" + "\x02" +                  // talk to the display
        CLR +
        pad(lines[0]) + pad(lines[1]) +
        ESC + "=" + "\x01"                    // hand the port back to the printer
      );
    },
  },

  // IBM / Toshiba 2x20 poles on the 4610/4820 RS-485 device chain. These are NOT
  // Epson devices: they answer on a chain address with the IBM/ADX display
  // command set, so ESC = peripheral select does not reach them. Reserved until
  // the frames are captured from a live unit with polecapture.js — paste the
  // returned frame_body here and the profile goes live. Encode the pole's chain
  // address (rotary/DIP switch on the unit) in the frames.
  ibm_4610_2x20: null,
  toshiba_4820_2x20: null,

  // Toshiba 2x20 pole on a USB (USB-serial) port. Transport is already solved:
  // the lane's ser2net bridge publishes the pad as lane_ip:BRIDGE_PORT, so this
  // profile writes to the LANE address, never the printer. Frames are the same
  // IBM/ADX family as the chain poles, so it stays reserved until captured.
  toshiba_usb_2x20: null,

  // Logic Controls LD9900 (LCI command set over a serial-device server) —
  // reserved. Fill in its frame() before enabling the profile on lanes.
  logic_ld9900: null,
};

function profileFor(key) {
  const p = PROFILES[key];
  if (!p) throw new Error("Pole display profile not supported on this relay: " + key);
  return p;
}

function resolveIp(ip, p) {
  // Bridge poles hang off the LANE, so the address is mandatory — never fall back
  // to the printer or the frames would land on the receipt roll.
  if (p && p.bridge) {
    if (!ip) throw new Error("Bridge pole display needs the lane's IP");
    return ip;
  }
  // Pass-through poles ride the printer address; blank falls back to the
  // relay's default printer, same as receipt printing.
  return ip || (process.env.PRINTER_IPS || "").split(",")[0].trim();
}

// Fire-and-forget write — a display update never blocks the lane.
function send(ip, port, payload) {
  return new Promise((resolve, reject) => {
    const sock = new net.Socket();
    sock.setTimeout(4000);
    sock.once("error", reject);
    sock.once("timeout", () => { sock.destroy(); reject(new Error("Pole display timeout at " + ip)); });
    sock.connect(port, ip, () => sock.end(Buffer.from(payload, "binary"), () => resolve(true)));
  });
}

module.exports = {
  BUILD,
  show(b) {
    const p = profileFor(b.profile);
    const lines = Array.isArray(b.lines) ? b.lines : [];
    return send(resolveIp(b.pole_ip, p), p.port, p.frame([lines[0] || "", lines[1] || ""]));
  },
  idle(b) {
    const p = profileFor(b.profile);
    return send(resolveIp(b.pole_ip, p), p.port, p.frame([IDLE_LINE_1, IDLE_LINE_2]));
  },
};
