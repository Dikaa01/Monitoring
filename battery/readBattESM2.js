const { SerialPort } = require("serialport");

// Contoh: node readBatt2_modbus.js --port COM4
// Opsional: --baud 9600 --slave 214 --parity none --fc 3 --timeout 700
//           --range 257-271,272-287   (ganti daftar blok register bawaan)
// Read-only: hanya function code 03/04 (baca), tidak ada perintah tulis.
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith("--")) acc.push([cur.slice(2), arr[i + 1] ?? true]);
    return acc;
  }, [])
);

const PORT = args.port || "COM4";
const BAUD = parseInt(args.baud || 9600);
const SLAVE = parseInt(args.slave || 214);
const PARITY = String(args.parity || "none").toLowerCase(); // none | even | odd
const FC = parseInt(args.fc || 3); // 3 = holding, 4 = input
const TIMEOUT = parseInt(args.timeout || 700);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HEX2 = (n) => n.toString(16).toUpperCase().padStart(2, "0");
const HEX4 = (n) => n.toString(16).toUpperCase().padStart(4, "0");
const hexs = (b) => [...b].map(HEX2).join(" ");

const EXC = {
  1: "Illegal Function",
  2: "Illegal Data Address",
  3: "Illegal Data Value",
  4: "Slave Device Failure",
  6: "Slave Busy",
};

// Blok register sesuai hasil dump (FC03, slave 214, 9600 8N1).
// Nama blok hanya rentang alamat: arti tiap register belum diketahui.
const DEFAULT_BLOCKS = [
  [0, 1, "register 0 (membalas saat scan, tapi tidak muncul di dump)"],
  [66, 9, "blok 66-74 (hasil dump)"],
  [257, 15, "blok 257-271 (hasil dump)"],
  [272, 16, "blok 272-287 (hasil dump)"],
];

function blocksFromRange(str) {
  const out = [];
  for (const part of String(str).split(",")) {
    const [a, b] = part.split("-").map((x) => parseInt(x, 10));
    const end = Number.isNaN(b) ? a : b;
    for (let s = a; s <= end; s += 16) {
      const n = Math.min(16, end - s + 1);
      out.push([s, n, `range ${s}-${s + n - 1}`]);
    }
  }
  return out;
}

function crc16(buf) {
  let crc = 0xffff;
  for (const b of buf) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >> 1) ^ 0xa001 : crc >> 1;
  }
  return crc;
}

function buildFrame(fc, addr, qty) {
  const body = Buffer.alloc(6);
  body[0] = SLAVE;
  body[1] = fc;
  body.writeUInt16BE(addr, 2);
  body.writeUInt16BE(qty, 4);
  const crc = Buffer.alloc(2);
  crc.writeUInt16LE(crc16(body));
  return Buffer.concat([body, crc]);
}

function parseFrame(buf) {
  if (buf.length < 5) return null;
  const f = {
    slave: buf[0],
    fc: buf[1],
    crcOk: crc16(buf.subarray(0, -2)) === buf.readUInt16LE(buf.length - 2),
  };
  if (f.fc & 0x80) {
    f.exception = buf[2];
    return f;
  }
  f.byteCount = buf[2];
  f.lenOk = buf.length === 5 + f.byteCount;
  f.bytes = buf.subarray(3, 3 + f.byteCount);
  f.words = [];
  for (let i = 0; i + 1 < f.bytes.length; i += 2) f.words.push(f.bytes.readUInt16BE(i));
  return f;
}

function openPort() {
  return new Promise((resolve, reject) => {
    const p = new SerialPort({ path: PORT, baudRate: BAUD, dataBits: 8, parity: PARITY, stopBits: 1, autoOpen: false });
    p.open((err) => (err ? reject(err) : resolve(p)));
  });
}

function registerTable(addr, words) {
  const rows = {};
  words.forEach((v, i) => {
    const a = addr + i;
    rows["reg " + a] = {
      alamat: "0x" + HEX4(a),
      uint16: v,
      int16: v & 0x8000 ? v - 0x10000 : v,
      hex: "0x" + HEX4(v),
    };
  });
  return rows;
}

async function main() {
  const p = await openPort();
  let rx = Buffer.alloc(0);
  let lastRx = 0;
  p.on("data", (d) => {
    rx = Buffer.concat([rx, d]);
    lastRx = Date.now();
  });

  // kirim satu request, tunggu balasan (berhenti setelah jeda hening), buang echo adaptor
  async function request(frame) {
    rx = Buffer.alloc(0);
    p.write(frame);
    await new Promise((r) => p.drain(() => r()));
    const t0 = Date.now();
    for (;;) {
      const now = Date.now();
      const onlyEcho = rx.length > 0 && rx.length <= frame.length && frame.subarray(0, rx.length).equals(rx);
      if (rx.length && now - lastRx > 40 && !onlyEcho) break;
      if (now - t0 > TIMEOUT) break;
      await sleep(5);
    }
    let out = Buffer.from(rx);
    if (out.length >= frame.length && out.subarray(0, frame.length).equals(frame)) out = out.subarray(frame.length);
    return out;
  }

  console.log(`Port ${PORT} | ${BAUD} bps ${PARITY} | Slave ${SLAVE} | FC${HEX2(FC)}\n`);

  const blocks = args.range ? blocksFromRange(args.range) : DEFAULT_BLOCKS;

  for (const [addr, qty, name] of blocks) {
    const frame = buildFrame(FC, addr, qty);
    const reply = await request(frame);
    console.log(`--- FC${HEX2(FC)} ${name} | alamat ${addr}, jumlah ${qty}`);
    console.log(`Kirim : ${hexs(frame)}`);
    if (!reply.length) {
      console.log("Balasan: (kosong)");
    } else {
      console.log(`Balasan: ${hexs(reply)}`);
      const f = parseFrame(reply);
      if (!f) {
        console.log("  Frame tidak valid / terlalu pendek");
      } else if (f.exception !== undefined) {
        console.log(
          `  Slave ${f.slave} | FC ${HEX2(f.fc)} | Exception ${HEX2(f.exception)} (${EXC[f.exception] || "?"}) | CRC ${f.crcOk ? "OK" : "SALAH"}`
        );
      } else {
        console.log(
          `  Slave ${f.slave} | FC ${HEX2(f.fc)} | byte ${f.byteCount} | CRC ${f.crcOk ? "OK" : "SALAH"}${f.lenOk ? "" : " | panjang tidak cocok"}`
        );
        if (f.crcOk && f.words.length) {
          console.log(`  Data bytes: ${hexs(f.bytes)}`);
          console.table(registerTable(addr, f.words));
          console.log();
          continue;
        }
      }
    }

    // blok gagal: cek satu per satu, tampilkan yang menjawab saja
    if (qty > 1) {
      console.log("  Blok gagal, cek satu per satu:");
      const found = [];
      for (let i = 0; i < qty; i++) {
        const r = await request(buildFrame(FC, addr + i, 1));
        const f = r.length ? parseFrame(r) : null;
        if (f && f.crcOk && f.exception === undefined && f.words.length) found.push([addr + i, f.words[0]]);
      }
      if (found.length) {
        const rows = {};
        for (const [a, v] of found) {
          rows["reg " + a] = { alamat: "0x" + HEX4(a), uint16: v, int16: v & 0x8000 ? v - 0x10000 : v, hex: "0x" + HEX4(v) };
        }
        console.table(rows);
      } else {
        console.log("  (tidak ada register yang menjawab)");
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