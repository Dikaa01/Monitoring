// smu-ydn-deepscan.js
// Dua fase:
//   Fase 1 (probe): coba tiap CID1 x CID2 dengan INFO=00 saja, timeout pendek -> cari command yang direspon (RTN=00).
//   Fase 2 (sweep): untuk command yang responsif, sapu penuh INFO=00..MAX dan catat balasan yang unik.
//
// Install:  npm install serialport
// Jalankan: node smu-ydn-deepscan.js COM3
//           node smu-ydn-deepscan.js COM3 --cid1 40-4A --cid2 40-50 --max FF --out baseline.json
//
// Opsi:
//   --baud 19200 --adr 1 --ver 21
//   --cid1 40-4A          rentang/daftar CID1, hex. Bisa "40-4A" atau "40,41,4D"
//   --cid2 40-50          rentang/daftar CID2, hex
//   --max FF              INFO terakhir yang disapu di fase 2 (hex)
//   --probe-timeout 300   timeout (ms) per query di fase 1 (harus lebih pendek, banyak yg timeout)
//   --probe-info 00,01    daftar/rentang INFO yang dicoba per command saat probe (hex)
//   --timeout 800         timeout (ms) per query di fase 2
//   --delay 20            jeda (ms) antar query, semua fase
//   --out file.json       simpan seluruh hasil fase 2 sebagai JSON (buat di-diff nanti)

const { SerialPort } = require("serialport");
const fs = require("fs");

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};

const PATH = args[0] && !args[0].startsWith("--") ? args[0] : "COM3";
const BAUD = parseInt(opt("baud", "19200"), 10);
const ADR = parseInt(opt("adr", "1"), 10);
const VER = parseInt(opt("ver", "21"), 16);
const MAX_INFO = parseInt(opt("max", "1F"), 16);
const PROBE_TIMEOUT = parseInt(opt("probe-timeout", "300"), 10);
const SWEEP_TIMEOUT = parseInt(opt("timeout", "800"), 10);
const DELAY = parseInt(opt("delay", "20"), 10);
const OUT_FILE = opt("out", null);

function parseRange(spec) {
  // "40-4A" -> [0x40..0x4A]; "40,41,4D" -> [0x40,0x41,0x4D]; gabungan boleh dipisah koma
  const out = new Set();
  for (const part of spec.split(",")) {
    const m = part.match(/^([0-9A-Fa-f]+)-([0-9A-Fa-f]+)$/);
    if (m) {
      const a = parseInt(m[1], 16),
        b = parseInt(m[2], 16);
      for (let v = a; v <= b; v++) out.add(v);
    } else if (part.trim()) {
      out.add(parseInt(part, 16));
    }
  }
  return [...out].sort((a, b) => a - b);
}

const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, "0");
const hex4 = (n) => n.toString(16).toUpperCase().padStart(4, "0");

const CID1S = parseRange(opt("cid1", "40-42"));
const CID2S = parseRange(opt("cid2", "40-48"));
// INFO yang dicoba saat probe (fase 1). RTN=06 artinya "INFO tidak valid", bukan "command tidak
// ada" -- jadi command yang butuh module-index (mis. mulai dari 01, bukan 00) akan kelewat kalau
// cuma dicoba INFO=00. Coba beberapa nilai sebelum menyerah.
const PROBE_INFOS = parseRange(opt("probe-info", "00,01")).map(hex2);
// Command yang sudah terbukti manual selalu dipaksa ikut fase 2, walau probe gagal.
const FORCE_INCLUDE = [
  [0x40, 0x41],
  [0x40, 0x43],
  [0x40, 0x44],
  [0x42, 0x41],
  [0x42, 0x44],
];

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
function buildFrame(cid1, cid2, info) {
  const body = hex2(VER) + hex2(ADR) + hex2(cid1) + hex2(cid2) + lengthField(info.length) + info;
  return `~${body}${checksum(body)}\r`;
}
function parseReply(r) {
  const s = r.endsWith("\r") ? r.slice(0, -1) : r;
  if (s[0] !== "~" || s.length < 17) return null;
  if (checksum(s.slice(1, -4)) !== s.slice(-4)) return null;
  return { rtn: s.slice(7, 9), info: s.slice(13, -4) };
}
function toBytes(info) {
  const out = [];
  for (let i = 0; i + 1 < info.length; i += 2) {
    const p = info.slice(i, i + 2);
    out.push(/^[0-9A-Fa-f]{2}$/.test(p) ? parseInt(p, 16) : null);
  }
  return out;
}
// tampilkan byte dengan run kosong dilipat: "00 E1 .. [gap x36]"
function compact(bytes) {
  const parts = [];
  let gap = 0;
  for (const b of bytes) {
    if (b === null) gap++;
    else {
      if (gap) parts.push(`[kosong x${gap}]`), (gap = 0);
      parts.push(hex2(b));
    }
  }
  if (gap) parts.push(`[kosong x${gap}]`);
  return parts.join(" ");
}
function floats(bytes) {
  const res = [];
  for (let i = 0; i + 3 < bytes.length; i++) {
    const w = bytes.slice(i, i + 4);
    if (w.some((x) => x === null) || w[3] < 0x3c || w[3] > 0x44) continue;
    const v = Buffer.from(w).readFloatLE(0);
    if (Number.isFinite(v) && Math.abs(v) >= 0.01) res.push({ offset: i, value: Math.round(v * 100) / 100 });
  }
  return res;
}

const port = new SerialPort({ path: PATH, baudRate: BAUD, dataBits: 8, stopBits: 1, parity: "none", autoOpen: false });
let rx = "";
port.on("data", (d) => (rx += d.toString("latin1")));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function query(frame, timeout) {
  rx = "";
  await new Promise((res, rej) => port.write(frame, "latin1", (e) => (e ? rej(e) : res())));
  await new Promise((res) => port.drain(res));
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const r = rx.startsWith(frame) ? rx.slice(frame.length) : rx;
    if (r.includes("\r")) return r;
    await sleep(5);
  }
  return rx.startsWith(frame) ? rx.slice(frame.length) : rx;
}

async function main() {
  await new Promise((res, rej) => port.open((e) => (e ? rej(e) : res())));
  console.log(
    `Deep scan @ ${BAUD}, ADR ${ADR}. CID1=[${CID1S.map(hex2).join(",")}] CID2=[${CID2S.map(hex2).join(",")}] INFO 00..${hex2(MAX_INFO)}\n`
  );

  // ---------- Fase 1: probe ----------
  console.log(
    `Fase 1: probe ${CID1S.length * CID2S.length} kombinasi CID1/CID2 (INFO=[${PROBE_INFOS.join(",")}], timeout ${PROBE_TIMEOUT}ms)...`
  );
  const responsive = [];
  const noReply = [];
  for (const cid1 of CID1S) {
    for (const cid2 of CID2S) {
      let ok = false;
      let lastRtn = null;
      for (const info of PROBE_INFOS) {
        const p = parseReply(await query(buildFrame(cid1, cid2, info), PROBE_TIMEOUT));
        await sleep(DELAY);
        if (p && p.rtn === "00") {
          ok = true;
          break; // sudah ketemu satu INFO yang jalan, cukup, fase 2 yang sapu penuh
        }
        lastRtn = p ? `RTN=${p.rtn}` : "timeout/no-reply";
      }
      if (ok) responsive.push([cid1, cid2]);
      else noReply.push([cid1, cid2, lastRtn]);
    }
  }
  // Gabungkan dengan command yang sudah terbukti manual, kalau belum ada di daftar
  for (const [c1, c2] of FORCE_INCLUDE) {
    if (!responsive.some(([a, b]) => a === c1 && b === c2)) responsive.push([c1, c2]);
  }
  console.log(`  -> ${responsive.length} command responsif (termasuk force-include), ${noReply.length} tidak (RTN!=00 atau timeout untuk semua INFO dicoba).\n`);

  // ---------- Fase 2: sweep penuh untuk yang responsif ----------
  console.log(`Fase 2: sweep INFO=00..${hex2(MAX_INFO)} untuk ${responsive.length} command responsif (timeout ${SWEEP_TIMEOUT}ms)...\n`);
  const seen = new Set();
  const results = [];

  for (const [cid1, cid2] of responsive) {
    for (let n = 0; n <= MAX_INFO; n++) {
      const info = hex2(n);
      const p = parseReply(await query(buildFrame(cid1, cid2, info), SWEEP_TIMEOUT));
      await sleep(DELAY);
      if (!p || p.rtn !== "00" || !p.info) continue;
      const key = `${cid1}-${cid2}-${p.info}`;
      if (seen.has(key)) continue; // lewati balasan identik (sudah pernah dilihat persis sama)
      seen.add(key);
      const bytes = toBytes(p.info);
      const f = floats(bytes);
      console.log(`CID1=${hex2(cid1)} CID2=${hex2(cid2)} INFO=${info}  (${bytes.length} byte)`);
      console.log(`  ${compact(bytes)}`);
      if (f.length) console.log(`  float: ${f.map((x) => `+${x.offset}:${x.value.toFixed(2)}`).join("  ")}`);
      console.log();
      results.push({
        time: new Date().toISOString(),
        cid1: hex2(cid1),
        cid2: hex2(cid2),
        info,
        raw: p.info,
        bytes,
        floats: f,
      });
    }
  }

  console.log("Selesai.");
  if (noReply.length) {
    console.log(`\nCommand tanpa respon (RTN!=00 / timeout), ${noReply.length}:`);
    console.log("  " + noReply.map(([a, b, why]) => `${hex2(a)}/${hex2(b)}(${why})`).join(", "));
  }

  if (OUT_FILE) {
    fs.writeFileSync(
      OUT_FILE,
      JSON.stringify(
        {
          time: new Date().toISOString(),
          adr: ADR,
          cid1_range: CID1S.map(hex2),
          cid2_range: CID2S.map(hex2),
          max_info: hex2(MAX_INFO),
          results,
        },
        null,
        2
      )
    );
    console.log(`\nHasil disimpan ke ${OUT_FILE} (${results.length} entri unik).`);
  }

  port.close(() => process.exit(0));
}

main().catch((e) => {
  console.error("Gagal:", e.message);
  process.exit(1);
});