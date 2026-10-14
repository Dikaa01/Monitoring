// smu-ydn-probe.js
// Probe protokol YDN (YD/T 1363.3) ke Huawei SMU01C.
// Frame: '~' VER ADR CID1 CID2 LENGTH INFO CHKSUM '\r'  (semua ASCII-hex)
// Perintah yang dikirim: CID2 = 4F (get protocol version), INFO kosong.
//
// Install:  npm install serialport
// Jalankan: node smu-ydn-probe.js COM3
//           node smu-ydn-probe.js COM3 --baud 19200 --adr 1
//           node smu-ydn-probe.js COM3 --adr-min 0 --adr-max 30 --ver 20 --cid1 40
//
// Opsi: --adr N (satu address) | --adr-min/--adr-max | --cid1 HEX (kosong = scan 40..4F)
//       --cid2 HEX (default 4F) | --ver HEX (default 20) | --parity none|even|odd | --stop 1|2

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
const VER = parseInt(opt("ver", "20"), 16);
const CID2 = parseInt(opt("cid2", "4F"), 16);
const CID1_OPT = opt("cid1", null);
const ADR_ONE = opt("adr", null);
const ADR_MIN = ADR_ONE !== null ? +ADR_ONE : parseInt(opt("adr-min", "0"), 10);
const ADR_MAX = ADR_ONE !== null ? +ADR_ONE : parseInt(opt("adr-max", "30"), 10);
const TIMEOUT = parseInt(opt("timeout", "300"), 10);

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
    // buang echo dari frame yang kita kirim sendiri (adaptor 2-kawat kadang echo)
    let r = rx.startsWith(frame) ? rx.slice(frame.length) : rx;
    if (r.includes("\r")) return r;
    await sleep(10);
  }
  return rx.startsWith(frame) ? rx.slice(frame.length) : rx;
}

async function main() {
  await new Promise((res, rej) => port.open((e) => (e ? rej(e) : res())));
  console.log(`Terbuka ${PATH} @ ${BAUD}, 8-${PARITY}-${STOP}`);
  const cid1List = CID1_OPT ? [parseInt(CID1_OPT, 16)] : Array.from({ length: 16 }, (_, i) => 0x40 + i);
  console.log(`Scan ADR ${ADR_MIN}-${ADR_MAX}, CID1 ${cid1List.map(hex2).join(",")}, CID2 ${hex2(CID2)}, VER ${hex2(VER)}\n`);

  let found = 0;
  for (let adr = ADR_MIN; adr <= ADR_MAX; adr++) {
    for (const cid1 of cid1List) {
      const frame = buildFrame(VER, adr, cid1, CID2);
      const r = await query(frame);
      process.stdout.write(`\rADR ${adr} CID1 ${hex2(cid1)}   `);
      if (r.length) {
        found++;
        console.log(`\n  TX: ${JSON.stringify(frame)}`);
        console.log(`  RX: ${JSON.stringify(r)}`);
        console.log(`  RX hex: ${Buffer.from(r, "latin1").toString("hex").replace(/(..)/g, "$1 ")}`);
      }
    }
  }
  console.log(`\nSelesai. ${found ? found + " respon diterima." : "Tidak ada respon."}`);
  port.close(() => process.exit(0));
}

main().catch((e) => {
  console.error("Gagal:", e.message);
  process.exit(1);
});