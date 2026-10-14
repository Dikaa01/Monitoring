const { SerialPort } = require("serialport");

// Contoh: node readBatt2.js --port COM4
// Opsional: --baud 19200 --adr 0 --ver 29
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith("--")) acc.push([cur.slice(2), arr[i + 1] ?? true]);
    return acc;
  }, [])
);

const PORT = args.port || "COM4";
const BAUD = parseInt(args.baud || 19200);
const ADR = parseInt(args.adr || 0);
const VER = String(args.ver || "29").toUpperCase();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const H2 = (n) => n.toString(16).toUpperCase().padStart(2, "0");

const RTN = {
  "00": "Normal",
  "01": "VER error",
  "02": "CHKSUM error",
  "03": "LCHKSUM error",
  "04": "CID2 tidak valid",
  "05": "Format perintah error",
  "06": "Data tidak valid",
};

function buildFrame(cid2, info = "") {
  const lenid = info.length;
  const s = (lenid & 0xf) + ((lenid >> 4) & 0xf) + ((lenid >> 8) & 0xf);
  const lchk = (~(s % 16) + 1) & 0xf;
  const lenField = ((lchk << 12) | lenid).toString(16).toUpperCase().padStart(4, "0");
  const body = VER + H2(ADR) + "46" + cid2 + lenField + info;
  let sum = 0;
  for (const ch of body) sum += ch.charCodeAt(0);
  const chk = (~(sum % 65536) + 1) & 0xffff;
  return "~" + body + chk.toString(16).toUpperCase().padStart(4, "0") + "\r";
}

function parseFrame(str) {
  const s = str.trim();
  if (!s.startsWith("~") || s.length < 17) return null;
  const body = s.slice(1, -4);
  const chkRx = s.slice(-4);
  let sum = 0;
  for (const ch of body) sum += ch.charCodeAt(0);
  const chkCalc = ((~(sum % 65536) + 1) & 0xffff).toString(16).toUpperCase().padStart(4, "0");
  const info = body.slice(12);
  const bytes = info.match(/.{1,2}/g) || [];
  const words = [];
  for (let i = 0; i + 1 < bytes.length; i += 2) words.push(bytes[i] + bytes[i + 1]);
  return {
    ver: body.slice(0, 2),
    adr: body.slice(2, 4),
    cid1: body.slice(4, 6),
    rtn: body.slice(6, 8),
    len: body.slice(8, 12),
    info,
    bytes,
    words,
    chkOk: chkRx === chkCalc,
  };
}

function openPort() {
  return new Promise((resolve, reject) => {
    const p = new SerialPort({ path: PORT, baudRate: BAUD, dataBits: 8, parity: "none", stopBits: 1, autoOpen: false });
    p.open((err) => (err ? reject(err) : resolve(p)));
  });
}

async function main() {
  const p = await openPort();
  let rx = Buffer.alloc(0);
  p.on("data", (d) => (rx = Buffer.concat([rx, d])));

  console.log(`Port ${PORT} | ${BAUD} bps | VER ${VER} | ADR ${ADR}\n`);

  const cmds = [
    ["4F", "", "versi protokol"],
    ["42", H2(ADR), "data analog (INFO = alamat)"],
    ["42", "00", "data analog (INFO 00)"],
    ["42", "01", "data analog (INFO 01)"],
    ["42", "FF", "data analog (INFO FF)"],
    ["42", "", "data analog (tanpa INFO)"],
    ["44", H2(ADR), "info alarm (INFO = alamat)"],
    ["44", "FF", "info alarm (INFO FF)"],
    ["47", "", "parameter sistem"],
    ["51", "", "info pabrikan"],
    ["92", H2(ADR), "info charge/discharge"],
    ["92", "", "info charge/discharge (tanpa INFO)"],
  ];

  for (const [cid2, info, name] of cmds) {
    rx = Buffer.alloc(0);
    const frame = buildFrame(cid2, info);
    p.write(frame);
    await sleep(700);
    console.log(`--- CID2 ${cid2} ${name}`);
    console.log(`Kirim : ${frame.trim()}`);
    if (!rx.length) {
      console.log("Balasan: (kosong)\n");
      continue;
    }
    const txt = rx.toString("latin1");
    console.log(`Balasan: ${txt.trim()}`);
    const f = parseFrame(txt);
    if (f) {
      console.log(
        `  VER ${f.ver} | ADR ${f.adr} | CID1 ${f.cid1} | RTN ${f.rtn} (${RTN[f.rtn] || "?"}) | LEN ${f.len} | checksum ${f.chkOk ? "OK" : "SALAH"}`
      );
      if (f.info) {
        console.log(`  INFO bytes: ${f.bytes.join(" ")}`);
        console.log(`  INFO word 16-bit: ${f.words.join(" ")}`);
      }
    }
    console.log();
  }

  p.close(() => process.exit(0));
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});