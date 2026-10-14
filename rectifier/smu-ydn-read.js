// smu-ydn-read.js
// Baca data dari Huawei SMU01C via YDN, tampilkan hex mentah + kandidat float32 (little-endian).
// Hanya perintah BACA (read-only).
//
// Install:  npm install serialport
// Jalankan: node smu-ydn-read.js COM3
//           node smu-ydn-read.js COM3 --watch 2000     (ulangi tiap 2 detik, cocokkan dengan LCD)
// Opsi: --baud 19200 --adr 1 --ver 21 --parity none --stop 1 --timeout 500

const { SerialPort } = require("serialport");

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};

const PATH = args[0] && !args[0].startsWith("--") ? args[0] : "COM3";
const BAUD = parseInt(opt("baud", "19200"), 10);
const PARITY = opt("parity", "none");
const STOP = parseInt(opt("stop", "1"), 10);
const ADR = parseInt(opt("adr", "1"), 10);
const VER = parseInt(opt("ver", "21"), 16);
const TIMEOUT = parseInt(opt("timeout", "500"), 10);
const WATCH = opt("watch", null);

// Perintah baca yang sudah terbukti dijawab RTN=00 oleh SMU01C ini
const TARGETS = [
  { name: "CID1=40 (grup AC?)", cid1: 0x40, cid2: 0x41, info: "01" },
  { name: "CID1=41 (grup rectifier?)", cid1: 0x41, cid2: 0x41, info: "" },
  { name: "CID1=42 (grup DC?)", cid1: 0x42, cid2: 0x41, info: "01" },
];

const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, "0");
const hex4 = (n) => n.toString(16).toUpperCase().padStart(4, "0");

function lengthField(lenid) {
  const sum = ((lenid >> 8) & 0xf) + ((lenid >> 4) & 0xf) + (lenid & 0xf);
  const lchk = (~(sum % 16) + 1) & 0xf;
  return hex4((lchk << 12) | lenid);
}
function checksum(body) {
  let s = 0;
  for (const ch of body) s += ch.charCodeAt(0);
  return hex4((~s + 1) & 0xffff);
}
function buildFrame(ver, adr, cid1, cid2, info = "") {
  const body = hex2(ver) + hex2(adr) + hex2(cid1) + hex2(cid2) + lengthField(info.length) + info;
  return `~${body}${checksum(body)}\r`;
}

// Parser (minimal 17 karakter: '~' + 16 + CR; frame tanpa INFO tetap valid)
function parseReply(r) {
  const s = r.endsWith("\r") ? r.slice(0, -1) : r;
  if (s[0] !== "~" || s.length < 17) return null;
  return {
    rtn: s.slice(7, 9),
    info: s.slice(13, -4),
    chkOk: checksum(s.slice(1, -4)) === s.slice(-4),
  };
}

// Ubah teks ASCII-hex jadi byte; pasangan bukan hex -> null (ditampilkan '??')
function toBytes(info) {
  const out = [];
  for (let i = 0; i + 1 < info.length; i += 2) {
    const pair = info.slice(i, i + 2);
    out.push(/^[0-9A-Fa-f]{2}$/.test(pair) ? parseInt(pair, 16) : null);
  }
  return out;
}

function floatCandidates(bytes) {
  const res = [];
  for (let i = 0; i + 3 < bytes.length; i++) {
    const w = bytes.slice(i, i + 4);
    if (w.some((x) => x === null)) continue;
    if (w[3] < 0x3c || w[3] > 0x44) continue; // kira-kira 0.01 .. 2000
    const v = Buffer.from(w).readFloatLE(0);
    if (Number.isFinite(v) && Math.abs(v) >= 0.01) res.push(`+${i}: ${v.toFixed(3)}`);
  }
  return res;
}

const port = new SerialPort({
  path: PATH,
  baudRate: BAUD,
  dataBits: 8,
  stopBits: STOP,
  parity: PARITY,
  autoOpen: false,
});
let rx = "";
port.on("data", (d) => (rx += d.toString("latin1")));
port.on("error", (e) => console.error("Error:", e.message));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function query(frame) {
  rx = "";
  await new Promise((res, rej) => port.write(frame, "latin1", (e) => (e ? rej(e) : res())));
  await new Promise((res) => port.drain(res));
  const start = Date.now();
  while (Date.now() - start < TIMEOUT) {
    const r = rx.startsWith(frame) ? rx.slice(frame.length) : rx;
    if (r.includes("\r")) return r;
    await sleep(10);
  }
  return rx.startsWith(frame) ? rx.slice(frame.length) : rx;
}

async function readAll() {
  console.log(`\n===== ${new Date().toLocaleTimeString()} =====`);
  for (const t of TARGETS) {
    const reply = await query(buildFrame(VER, ADR, t.cid1, t.cid2, t.info));
    const p = parseReply(reply);
    console.log(`\n--- ${t.name}  CID2=${hex2(t.cid2)} INFO="${t.info}"`);
    if (!p) {
      console.log("  tidak ada / balasan tidak valid:", JSON.stringify(reply));
      continue;
    }
    console.log(`  RTN=${p.rtn}  checksum ${p.chkOk ? "OK" : "SALAH"}`);
    if (p.rtn !== "00") continue;
    const bytes = toBytes(p.info);
    console.log(`  Frame mentah (hex): ${Buffer.from(reply, "latin1").toString("hex")}`);
    console.log(`  Byte data (${bytes.length}): ${bytes.map((b) => (b === null ? "??" : hex2(b))).join(" ")}`);
    console.log(`  Kandidat float32 LE: ${floatCandidates(bytes).join(" | ") || "-"}`);
  }
}

async function main() {
  await new Promise((res, rej) => port.open((e) => (e ? rej(e) : res())));
  console.log(`Terbuka ${PATH} @ ${BAUD}, 8-${PARITY}-${STOP}, ADR ${ADR}, VER ${hex2(VER)}`);
  do {
    await readAll();
    if (WATCH) await sleep(parseInt(WATCH, 10));
  } while (WATCH);
  port.close(() => process.exit(0));
}

process.on("SIGINT", () => port.close(() => process.exit(0)));
main().catch((e) => {
  console.error("Gagal:", e.message);
  process.exit(1);
});