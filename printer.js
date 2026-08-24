// printer.js — raw ESC/POS printing + cash drawer kick (Epson TM-H6000IV)
const net = require("net");

// Bumped whenever this file changes. The test print shows it, so a technician can
// confirm the relay is actually running the current printer.js and not a stale copy.
const BUILD = "printer-build 9 (denomination breakdown on cash slips)";

// Cheque tender reference for the receipt: cheque number + account last 4 only.
// The full routing/account number is deliberately NOT printed — that stays on the
// CheckPayment record and on the cheque itself.
function checkTenderLines(tenders) {
  return (tenders || [])
    .filter((t) => t.method === "check" && (t.reference || t.account_last4))
    .map((t) => "CHK# " + (t.reference || "") +
      (t.account_last4 ? "  ACCT ***" + t.account_last4 : ""));
}

const PRINTER_IPS = (process.env.PRINTER_IPS || "").split(",").filter(Boolean);
const PORT = Number(process.env.PRINTER_PORT || 9100);
const WIDTH = Number(process.env.RECEIPT_WIDTH || 42); // chars on 80mm paper

const ESC = "\x1b", GS = "\x1d";
const INIT = ESC + "@";
const ALIGN_L = ESC + "a0", ALIGN_C = ESC + "a1";
const BOLD_ON = ESC + "E1", BOLD_OFF = ESC + "E0";
const BIG_ON = GS + "!\x11", BIG_OFF = GS + "!\x00";
const CUT = GS + "V\x42\x00";
// Slip station (front insert slot) — used for chits and for printing a receipt on a
// blank sheet when the receipt roll is out. 40 columns, impact, no cutter.
const SLIP_WIDTH = Number(process.env.SLIP_WIDTH || 40);
// ESC c 0 n selects the print station. PROVEN BY DIRECT PRINTER TEST on the fleet's
// TM-H6000V: n=4 is the slip / cheque station, and n=2 is silently ignored so the job
// stays on the receipt roll. Do not "correct" this to 2.
// Do NOT also send ESC c 1 n — that is the paper-END SENSOR select and it cancels
// the slip selection, sending the job back to the roll.
const SLIP_PAPER = Number(process.env.SLIP_PAPER || 4);
const SEL_SLIP = ESC + "c0" + String.fromCharCode(SLIP_PAPER);
const SEL_RECEIPT = ESC + "c0\x01";           // ESC c 0 1 — back to the receipt roll
// ESC f t1 t2 — t1 is the insertion WAIT time (seconds), t2 the detection wait.
// t1 must be non-zero or the printer gives up instantly and never waits for the sheet.
const WAIT_INSERT = ESC + "f\x1e\x0a";       // wait ~30s for the operator to insert paper
const EJECT = "\x0c";                          // FF — print and eject the cut sheet
// Drawer kick: pin 2, 100ms on / 200ms off. Some drawers are wired to pin 5 (p=1).
const KICK = ESC + "p\x00\x32\x64";

function money(n) { return Number(n || 0).toFixed(2); }
function padR(s, n) { return String(s == null ? "" : s).slice(0, n).padEnd(n, " "); }
function padL(s, n) { return String(s == null ? "" : s).slice(-n).padStart(n, " "); }

// IBM 4690 totals block: right-aligned label + right-aligned amount.
function amountRow(label, amount) { return padL(label, 30) + padL(amount, 12) + "\n"; }

// Denomination breakdown line for cash slips: "  250 x $  20.00 = $  5000.00"
function denomRow(d) {
  const qty = Number(d.qty || 0);
  const amt = money(qty * Number(d.value || 0));
  const label = d.label ? padR(d.label, 9) : "$" + padL(money(d.value), 8);
  return padL(String(qty), 6) + " x " + label + " = $" + padL(amt, 10) + "\n";
}

// Centers text in a fixed-width column so item names line up uniformly.
function padC(s, n) {
  const t = String(s == null ? "" : s).slice(0, n);
  const left = Math.floor((n - t.length) / 2);
  return " ".repeat(left) + t + " ".repeat(n - t.length - left);
}

// NAME(centered 16) SKU(12) F AMOUNT(9) TAXCODE — the 4690 item column layout.
function itemLine(it, exempt) {
  const code = exempt ? "E" : Number(it.tax_rate || 0) > 0 ? "X" : "O";
  return padC(String(it.name || "").toUpperCase(), 16) + " " + padL(it.sku || "", 12) +
    " " + (it.food ? "F" : " ") + padL(money(it.total), 9) + " " + code + "\n";
}

function center(text) { return ALIGN_C + text + "\n" + ALIGN_L; }

// Builds the ESC/POS byte string for a receipt payload sent by the POS.
function buildReceipt(r) {
  let o = INIT + ALIGN_C;
  o += BOLD_ON + BIG_ON + String(r.store_name || "Store").toUpperCase() + "\n" + BIG_OFF + BOLD_OFF;
  for (const l of [r.header_line_1, r.store_address, r.store_phone]) {
    if (l) o += l + "\n";
  }
  o += "\n";
  if (r.doc_type === "return") o += BOLD_ON + "*** RETURN / REFUND ***" + BOLD_OFF + "\n";
  if (r.doc_type === "exchange") o += BOLD_ON + "*** EXCHANGE ***" + BOLD_OFF + "\n";
  if (r.manager_name) o += "MANAGER " + String(r.manager_name).toUpperCase() + "\n";
  o += "ST# " + (r.store_number || "0000") + "  OP# " + (r.operator_pin || "") +
    "  REG# " + (r.register_id || "00") + "\n";
  o += ALIGN_L;

  // Operator notice slips (maintenance notices, store announcements, suspended
  // sales) print a heading + message block instead of line items and totals.
  // A notice.barcode value prints as a scannable CODE128 symbol (suspend slips).
  if (r.doc_type === "notice") {
    const n = r.notice || {};
    o += "\n" + ALIGN_C + BOLD_ON + BIG_ON +
      String(n.heading || "NOTICE").toUpperCase() + "\n" + BIG_OFF + BOLD_OFF + ALIGN_L;
    o += "=".repeat(WIDTH) + "\n" + ALIGN_C;
    for (const l of n.lines || []) o += (l ? l : "") + "\n";
    o += ALIGN_L + "=".repeat(WIDTH) + "\n\n";
    o += center("OPERATOR " + String(r.operator_name || "").toUpperCase());
    o += center(r.date || new Date().toLocaleString());
    if (n.barcode) {
      const b = String(n.barcode);
      o += ALIGN_C + GS + "h\x50" + GS + "w\x02" + GS + "H\x02";
      o += GS + "k\x49" + String.fromCharCode(b.length + 2) + "{B" + b + "\n" + ALIGN_L;
    }
    o += "\n" + center(n.footer || "***MAINTENANCE NOTICE***");
    o += "\n";
    o += CUT;
    return o;
  }

  // Cash slips print an amount + audit block instead of line items and totals.
  if (r.doc_type === "cash") {
    const cs = r.cash_slip || {};
    o += "\n" + ALIGN_C + BOLD_ON + BIG_ON +
      String(cs.title || "CASH SLIP").toUpperCase() + "\n" + BIG_OFF + BOLD_OFF + ALIGN_L + "\n";
    o += amountRow("TYPE", String(cs.kind || "").toUpperCase());
    o += amountRow("AMOUNT", money(cs.amount));
    // Denomination breakdown (the 4690 "Notes:" block) when the slip carries one.
    if ((cs.denominations || []).length) {
      o += "\nNOTES:\n";
      let dt = 0;
      for (const d of cs.denominations) {
        dt += Number(d.qty || 0) * Number(d.value || 0);
        o += denomRow(d);
      }
      o += amountRow("NOTES TOTAL", money(dt));
    }
    if (cs.reason) o += "\n" + center("REASON") + center(String(cs.reason));
    o += "\nOPERATOR X________________________\n";
    o += "AUDITOR  X________________________\n\n";
    o += center(r.date || new Date().toLocaleString());
    o += center("***FOR AUDITOR CONFIRMATION***");
    o += "\n";
    o += CUT;
    return o;
  }

  for (const it of r.items || []) {
    o += itemLine(it, r.tax_exempt);
    for (const sn of it.serial_numbers || []) o += "   SN: " + sn + "\n";
  }

  o += amountRow("SUBTOTAL", money(r.subtotal));
  if (r.tax_exempt) o += amountRow("TAX EXEMPT", "0.00");
  else o += amountRow("TAX  " + Number(r.tax_rate || 0).toFixed(3) + " %", money(r.tax));
  o += amountRow(r.doc_type === "return" ? "REFUND TOTAL"
    : r.doc_type === "exchange" ? "BALANCE DUE" : "TOTAL", money(r.total));
  // On a refund the money moves back to the customer, so tender prints negative.
  const signed = (n) => (r.doc_type === "return" ? "-" + money(n) : money(n));
  if (r.rewards_applied > 0) o += amountRow("REWARDS TEND", signed(r.rewards_applied));
  const tender = String(r.payment_method || "cash").toUpperCase().replace("_", " ");
  o += amountRow(tender + " TEND", signed(r.payment_method === "cash"
    ? r.amount_tendered : (r.total || 0) - (r.rewards_applied || 0)));
  o += amountRow("CHANGE DUE", money(r.change_due));
  for (const l of checkTenderLines(r.tenders)) o += center(l);

  const count = (r.items || []).reduce(function (s, i) { return s + Number(i.qty || 0); }, 0);
  o += "\n" + ALIGN_C + "# ITEMS " + (r.doc_type === "return" ? "RETURNED " : "SOLD ") +
    count + "\n" + ALIGN_L;

  // Transaction ID as a CODE128 barcode (with the TX printed under it) so
  // returns can be scanned straight from the receipt.
  if (r.transaction_id) {
    const d = r.transaction_id;
    o += ALIGN_C + GS + "h\x50" + GS + "w\x02" + GS + "H\x02";
    o += GS + "k\x49" + String.fromCharCode(d.length + 2) + "{B" + d + "\n" + ALIGN_L;
  }

  if (r.giftcard_notice) {
    o += center("GIFT CARDS NOT REFUNDABLE") + center("Cannot be exchanged for cash or credit");
  }
  if (r.tax_exempt) {
    o += center("TAX EXEMPT " + (r.tax_exempt.tax_exempt_id || ""));
    o += center(String(r.tax_exempt.name || "").toUpperCase());
  }
  if (r.loyalty_member) {
    o += center("MEMBER " + (r.loyalty_member.loyalty_id || ""));
    o += amountRow("REWARDS EARNED", money(r.rewards_earned));
    o += amountRow("REWARDS BALANCE", money(r.loyalty_balance));
  }

  for (const l of [r.footer_line_1, r.footer_line_2]) if (l) o += center(l);
  o += center(r.date || new Date().toLocaleString());
  o += "\n" + center(r.reprint ? "***REPRINTED***" : "***CUSTOMER COPY***");

  o += "\n";                     // GS V 66 feeds to the cutter, so no extra padding needed
  if (r.open_drawer) o += KICK;   // pop the drawer on cash sales
  o += CUT;
  return o;
}

// Compact 40-column version of a receipt for the slip station. The impact slip
// station has no cutter and poor barcode quality, so the transaction number
// prints as text and the sheet is ejected instead of cut.
function buildSlip(r) {
  const w = SLIP_WIDTH;
  const rowL = (label, amount) => padL(label, w - 12) + padL(amount, 12) + "\n";
  const ctr = (s) => {
    const t = String(s == null ? "" : s).slice(0, w);
    return " ".repeat(Math.max(0, Math.floor((w - t.length) / 2))) + t + "\n";
  };
  let o = INIT + SEL_SLIP + WAIT_INSERT;
  o += ctr(String(r.store_name || "Store").toUpperCase());
  if (r.store_phone) o += ctr(r.store_phone);
  o += ctr("ST# " + (r.store_number || "0000") + " OP# " + (r.operator_pin || "") +
    " REG# " + (r.register_id || "00"));
  o += "-".repeat(w) + "\n";
  if (r.doc_type === "return") o += ctr("*** RETURN / REFUND ***");
  if (r.doc_type === "exchange") o += ctr("*** EXCHANGE ***");
  for (const it of r.items || []) {
    o += padR(String(it.name || "").toUpperCase(), w - 12) + padL(money(it.total), 12) + "\n";
    for (const sn of it.serial_numbers || []) o += "  SN: " + sn + "\n";
  }
  o += "-".repeat(w) + "\n";
  o += rowL("SUBTOTAL", money(r.subtotal));
  o += rowL(r.tax_exempt ? "TAX EXEMPT" : "TAX", money(r.tax_exempt ? 0 : r.tax));
  o += rowL("TOTAL", money(r.total));
  const tenders = (r.tenders || []).length ? r.tenders
    : [{ method: r.payment_method || "cash", amount: r.amount_tendered || r.total }];
  for (const t of tenders) {
    o += rowL(String(t.method || "cash").toUpperCase().replace("_", " ") + " TEND", money(t.amount));
  }
  o += rowL("CHANGE DUE", money(r.change_due));
  for (const l of checkTenderLines(r.tenders)) o += ctr(l);
  o += "-".repeat(w) + "\n";
  if (r.transaction_id) o += ctr("TX " + r.transaction_id);
  o += ctr(r.date || new Date().toLocaleString());
  o += ctr(r.slip_note || "***SLIP COPY***") + "\n";
  o += EJECT + SEL_RECEIPT;
  return o;
}

// Resolve which printer to talk to: explicit IP, else the store's first configured printer.
function resolvePrinter(ip) {
  const target = ip || PRINTER_IPS[0];
  if (!target) throw new Error("No printer IP configured (set PRINTER_IPS in .env)");
  return target;
}

function sendRaw(ip, payload) {
  return new Promise((resolve, reject) => {
    const sock = new net.Socket();
    sock.setTimeout(5000);
    sock.once("error", reject);
    sock.once("timeout", () => { sock.destroy(); reject(new Error("Printer timeout at " + ip)); });
    // Resolve as soon as the bytes are flushed to the printer instead of waiting
    // for the socket teardown — the print starts immediately either way.
    sock.connect(PORT, ip, () => sock.end(Buffer.from(payload, "binary"), () => resolve(true)));
    sock.once("close", () => resolve(true));
  });
}

module.exports = {
  // station: "slip" prints the compact chit on an inserted blank sheet instead of the roll.
  printReceipt: (receipt) => sendRaw(resolvePrinter(receipt.printer_ip),
    receipt.station === "slip" ? buildSlip(receipt) : buildReceipt(receipt)),
  openDrawer: (ip) => sendRaw(resolvePrinter(ip), INIT + KICK),
  // station:"slip" sends the same test to the front slip slot — the fastest way to
  // prove whether the slip station itself responds, separate from receipt layout.
  testPrint: (ip, station) => {
    const body = BOLD_ON + "SUREFLOW TEST PRINT\n" + BOLD_OFF + BUILD + "\n" +
      "STATION " + (station || "receipt") + " PAPER " + SLIP_PAPER + "\n" +
      new Date().toLocaleString() + "\n" + (process.env.STORE_ID || "") + "\n";
    return sendRaw(resolvePrinter(ip), station === "slip"
      ? INIT + SEL_SLIP + WAIT_INSERT + ALIGN_C + body + EJECT + SEL_RECEIPT
      : INIT + ALIGN_C + body + "\n\n" + CUT);
  },
  printers: PRINTER_IPS,
};
