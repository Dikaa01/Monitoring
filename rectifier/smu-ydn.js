// smu-ydn-cmd.js
// Tool YDN (YD/T 1363.3) untuk Huawei SMU01C. Hanya perintah BACA (read-only) di mode scan.
//
// Install:  npm install serialport
//
// Mode scan (cari perintah baca yang didukung SMU):
//   node smu-ydn-cmd.js COM3
//
// Mode tunggal (kirim satu perintah):
//   node smu-ydn-cmd.js COM3 --cid1 40 --cid2 41 --info 01
//   (--info dalam ASCII-hex, kosong jika tanpa data)
//
// Opsi umum: --baud 19200 --adr 1 --ver 21 --parity none --stop 1 --timeout 400

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
const TIMEOUT = parseInt(opt("timeout", "400"), 10);

const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, "0");
const hex4 = (n) => n.toString(16).toUpperCase().padStart(4, "0");

const RTN = {
  "00": "Normal",
  "01": "VER error",
  "02": "CHKSUM error",
  "03": "LCHKSUM error",
  "04": "CID2 tidak valid (perintah tidak didukung)",
  "05": "Format perintah salah (INFO salah)",
  "06": "Data tidak valid",
};

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

function parseReply(r) {
  const m = r.trim();
  if (!m.startsWith("~") || m.length < 18) return { ok: false, raw: r };
  const body = m.slice(1, -4);
  const chk = m.slice(-4);
  const info = m.slice(13, -4);
  const rtn = m.slice(7, 9);
  return {
    ok: true,
    ver: m.slice(1, 3),
    adr: m.slice(3, 5),
    cid1: m.slice(5, 7),
    rtn,
    rtnText: RTN[rtn] || (parseInt(rtn, 16) >= 0x80 ? "Kode khusus pabrikan" : "Tidak dikenal"),
    length: m.slice(9, 13),
    info,
    chkOk: checksum(body) === chk,
  };
}

function describeInfo(info) {
  if (!info) return "(kosong)";
  const bytes = info.match(/../g) || [];
  const ascii = bytes
    .map((h) => parseInt(h, 16))
    .map((x) => (x >= 32 && x < 127 ? String.fromCharCode(x) : "."))
    .join("");
  return `${info}\n      bytes: ${bytes.join(" ")}\n      ascii: ${ascii}`;
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

function report(cid1, cid2, info, reply) {
  const p = parseReply(reply);
  const tag = `CID1=${hex2(cid1)} CID2=${hex2(cid2)} INFO="${info}"`;
  if (!reply) return false;
  if (!p.ok) {
    console.log(`\n[${tag}] balasan tidak dikenal: ${JSON.stringify(reply)}`);
    return true;
  }
  console.log(`\n[${tag}]`);
  console.log(`  RTN=${p.rtn} (${p.rtnText}), LEN=${p.length}, checksum ${p.chkOk ? "OK" : "SALAH"}`);
  if (p.info) console.log(`  INFO: ${describeInfo(p.info)}`);
  return true;
}

async function main() {
  await new Promise((res, rej) => port.open((e) => (e ? rej(e) : res())));
  console.log(`Terbuka ${PATH} @ ${BAUD}, 8-${PARITY}-${STOP}, ADR ${ADR}, VER ${hex2(VER)}`);

  if (opt("cid2", null)) {
    // mode tunggal
    const cid1 = parseInt(opt("cid1", "40"), 16);
    const cid2 = parseInt(opt("cid2"), 16);
    const info = opt("info", "");
    const frame = buildFrame(VER, ADR, cid1, cid2, info);
    console.log("TX:", JSON.stringify(frame));
    const r = await query(frame);
    if (!report(cid1, cid2, info, r)) console.log("Tidak ada respon.");
  } else {
    // mode scan, hanya perintah BACA
    const cid1s = [0x40, 0x41, 0x42];
    const cid2s = [0x41, 0x42, 0x43, 0x44, 0x47, 0x49, 0x50, 0x51];
    const infos = ["", "01", "00", "FF"];
    console.log("Scan perintah baca (read-only)...");
    let n = 0;
    for (const cid1 of cid1s) {
      for (const cid2 of cid2s) {
        for (const info of infos) {
          const frame = buildFrame(VER, ADR, cid1, cid2, info);
          const r = await query(frame);
          if (report(cid1, cid2, info, r)) n++;
        }
      }
    }
    console.log(`\nSelesai. ${n} respon.`);
  }
  port.close(() => process.exit(0));
}

main().catch((e) => {
  console.error("Gagal:", e.message);
  process.exit(1);
});