//version 0.3.10

// smu-monitor.js
// Monitor Huawei SMU01C via RS485 (protokol YDN, ADR 1, 19200 baud). Read-only.
//
// Install:  npm install serialport
// Jalankan: node smu-monitor.js COM3
//           node smu-monitor.js COM3 --interval 2000
//           node smu-monitor.js COM3 --json
//           node smu-monitor.js COM3 --csv log.csv
//           node smu-monitor.js COM3 --alarm          (tampilkan raw alarm bytes dari 3 grup: AC/RC/DC)
//
// Opsi: --baud 19200 --adr 1 --ver 21 --parity none --stop 1 --timeout 500 --interval 1000
//       --no-config   lewati pembacaan config/threshold sekali di awal (kalau device tidak punya command itu)

const { SerialPort } = require("serialport");
const fs = require("fs");

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};

const PATH = args[0] && !args[0].startsWith("--") ? args[0] : "COM5";
const BAUD = parseInt(opt("baud", "19200"), 10);
const PARITY = opt("parity", "none");
const STOP = parseInt(opt("stop", "1"), 10);
const ADR = parseInt(opt("adr", "1"), 10); //ADDR 1 = default SMU01C 
const VER = parseInt(opt("ver", "21"), 16);
const TIMEOUT = parseInt(opt("timeout", "500"), 10);
const INTERVAL = parseInt(opt("interval", "1000"), 10);
const AS_JSON = args.includes("--json");
const SHOW_ALARM = args.includes("--alarm");
const CSV_FILE = opt("csv", null);
const SKIP_CONFIG = args.includes("--no-config");
// Command alarm, dari hasil deep-scan: CID2=0x44 direspon di 3 grup CID1 berbeda (AC/rectifier-lain/DC-baterai).
// Semua ditampilkan sebagai raw bytes -- pemetaan makna per-bit belum dikonfirmasi.
const ALARM_TARGETS = [
  { name: "ac", cid1: 0x40, cid2: 0x44 },
  { name: "rc", cid1: 0x41, cid2: 0x44 },
  { name: "dc", cid1: 0x42, cid2: 0x44 },
];

// ---------- Protokol YDN ----------
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
function buildFrame(cid1, cid2, info = "") {
  const body = hex2(VER) + hex2(ADR) + hex2(cid1) + hex2(cid2) + lengthField(info.length) + info;
  return `~${body}${checksum(body)}\r`;
}
function parseReply(r) {
  const s = r.endsWith("\r") ? r.slice(0, -1) : r;
  if (s[0] !== "~" || s.length < 17) return null;
  if (checksum(s.slice(1, -4)) !== s.slice(-4)) return null;
  if (s.slice(7, 9) !== "00") return null;
  return s.slice(13, -4);
}
// teks ASCII-hex -> byte (spasi/karakter non-hex -> null)
function toBytes(info) {
  const out = [];
  for (let i = 0; i + 1 < info.length; i += 2) {
    const pair = info.slice(i, i + 2);
    out.push(/^[0-9A-Fa-f]{2}$/.test(pair) ? parseInt(pair, 16) : null);
  }
  return out;
}
function f32(bytes, off) {
  const w = bytes.slice(off, off + 4);
  if (w.length < 4 || w.some((x) => x === null)) return null;
  const v = Buffer.from(w).readFloatLE(0);
  return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null;
}
// tampilkan tiap byte sbg biner 8-bit, dipisah spasi — buat mancing mapping bit alarm
function bytesToBinString(bytes) {
  if (!bytes) return null;
  return bytes.map((b) => (b === null ? "????????" : b.toString(2).padStart(8, "0"))).join(" ");
}

// Parse rectifier analog (41/41). Layout (terverifikasi dari panjang data: 6 + 57*M = 63 byte untuk M=1, 177 byte untuk M=3):
//   [0]=flag, [1-4]=V output rectifier (float), [5]=jumlah slot modul M,
//   lalu M blok @57 byte, tiap blok: arus modul (float 4B) + 1 byte N (=13) + 13 float (52B).
// Blok yang isinya non-hex semua ("??") = slot tanpa data (kosong / tidak berkomunikasi).
// Makna 4 float pertama tiap blok (122 / 53.5 / 40.2 / 231) masih dugaan, belum dicocokkan dengan LCD.
const PSU_BLOCK = 57;
function parsePsu(rc) {
  if (!rc || rc.length < 6) return null;
  const count = rc[5];
  if (count === null || count > 30) return null;
  const modules = [];
  for (let i = 0; i < count; i++) {
    const o = 6 + PSU_BLOCK * i;
    const m = {
      slot: i + 1,
      current_a: f32(rc, o),
      limit_guess: f32(rc, o + 5), // dugaan: batas arus modul (122)
      out_v_guess: f32(rc, o + 9), // dugaan: tegangan output modul
      temp_guess: f32(rc, o + 13), // dugaan: suhu modul
      ac_in_guess: f32(rc, o + 17), // dugaan: tegangan AC masuk modul
    };
    m.valid = [m.current_a, m.limit_guess, m.out_v_guess, m.temp_guess, m.ac_in_guess].some((v) => v !== null);
    modules.push(m);
  }
  const live = modules.filter((m) => m.valid && m.current_a !== null);
  return {
    count,
    responding: modules.filter((m) => m.valid).length,
    out_v: f32(rc, 1),
    current_total: live.length ? Math.round(live.reduce((a, m) => a + m.current_a, 0) * 1000) / 1000 : null,
    len_ok: rc.length === 6 + PSU_BLOCK * count,
    modules,
  };
}

// ringkasan per slot untuk satu baris / satu kolom CSV
function psuDetail(psu) {
  return psu.modules
    .map((m) => (m.valid ? `${m.slot}:${m.current_a === null ? "--" : m.current_a.toFixed(2)}A/${m.temp_guess === null ? "--" : m.temp_guess.toFixed(1)}C?` : `${m.slot}:kosong`))
    .join(" ");
}

// ---------- Serial ----------
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

async function getBytes(cid1, cid2, info) {
  const reply = await query(buildFrame(cid1, cid2, info));
  const data = parseReply(reply);
  return data === null ? null : toBytes(data);
}

// ---------- Config / threshold (dibaca SEKALI di awal, bukan tiap poll -- nilainya statis) ----------
// Dari deep-scan: CID1=40 CID2=46 dan CID1=42 CID2=46. Field *_guess belum dikonfirmasi,
// beberapa offset di grup 42/46 kemungkinan false-positive scanner float (blok 217-byte, padat).
async function readConfig() {
  const acCfg = await getBytes(0x40, 0x46, "01");
  const dcCfg = await getBytes(0x42, 0x46, "01");
  return {
    ac_upper_v_guess: acCfg && f32(acCfg, 0), // dugaan: batas atas tegangan AC
    ac_lower_v_guess: acCfg && f32(acCfg, 4), // dugaan: batas bawah tegangan AC
    dc_overvolt_protect_guess: dcCfg && f32(dcCfg, 0),
    dc_undervolt_protect_guess: dcCfg && f32(dcCfg, 4),
    batt_float_v_guess: dcCfg && f32(dcCfg, 69), // dugaan: tegangan float charge baterai
    batt_equalize_v_guess: dcCfg && f32(dcCfg, 73), // dugaan: tegangan equalize charge baterai
    batt_capacity_pct_guess: dcCfg && f32(dcCfg, 129), // dugaan: kapasitas baterai terkonfigurasi (%)
  };
}
function printConfig(c) {
  const f = (v) => (v === null || v === undefined ? "--" : v.toFixed(2));
  console.error(
    `Config/threshold (dibaca sekali, semua *_guess belum dikonfirmasi):\n` +
      `  AC upper/lower: ${f(c.ac_upper_v_guess)} / ${f(c.ac_lower_v_guess)} V\n` +
      `  DC over/under-volt protect: ${f(c.dc_overvolt_protect_guess)} / ${f(c.dc_undervolt_protect_guess)} V\n` +
      `  Batt float/equalize charge: ${f(c.batt_float_v_guess)} / ${f(c.batt_equalize_v_guess)} V\n` +
      `  Batt capacity terkonfigurasi: ${f(c.batt_capacity_pct_guess)} %`
  );
}

// ---------- Pembacaan live (tiap --interval) ----------
// Offset dikonfirmasi vs LCD: acV, freq, dcV, loadA.
// Jumlah PSU terkonfirmasi (fisik = 1). Field bertanda *_guess / unk_* belum dikonfirmasi maknanya.
async function readSMU() {
  const ac = await getBytes(0x40, 0x41, "01"); // grup AC
  const dc = await getBytes(0x42, 0x41, "01"); // grup DC
  const rc = await getBytes(0x41, 0x41, ""); // grup rectifier (PSU)

  const psu = parsePsu(rc);
  const d = {
    time: new Date().toISOString(),
    ac_v: ac && f32(ac, 2),
    freq_hz: ac && f32(ac, 14),
    dc_v: dc && f32(dc, 1),
    load_a: dc && f32(dc, 5),
    psu_count: psu ? psu.count : null,
    psu_responding: psu ? psu.responding : null,
    psu_current_a: psu ? psu.current_total : null,
    psu_detail: psu ? psuDetail(psu) : null,
    unk_100: dc && f32(dc, 76),
  };

  if (SHOW_ALARM) {
    for (const t of ALARM_TARGETS) {
      d[`alarm_${t.name}_raw`] = await getBytes(t.cid1, t.cid2, "01");
    }
  }
  return d;
}

const fmt = (v, d = 1) => (v === null || v === undefined ? "--" : v.toFixed(d));

function printLine(d) {
  const t = new Date(d.time).toLocaleTimeString();
  let line =
    `[${t}] AC ${fmt(d.ac_v)} V ${fmt(d.freq_hz)} Hz | DC ${fmt(d.dc_v, 2)} V | Load ${fmt(d.load_a, 2)} A` +
    ` | PSU ${d.psu_responding ?? "--"} terpasang (slot tertinggi ${d.psu_count ?? "--"}), ${fmt(d.psu_current_a, 2)} A | ${d.psu_detail ?? "--"}`;
  if (SHOW_ALARM) {
    for (const t of ALARM_TARGETS) {
      const bytes = d[`alarm_${t.name}_raw`];
      line += bytes ? ` | ${t.name}:${bytesToBinString(bytes)}` : ` | ${t.name}:(no resp)`;
    }
  }
  console.log(line);
}

function appendCsv(d) {
  const keys = Object.keys(d);
  if (!fs.existsSync(CSV_FILE)) fs.writeFileSync(CSV_FILE, keys.join(",") + "\n");
  fs.appendFileSync(
    CSV_FILE,
    keys
      .map((k) => (Array.isArray(d[k]) ? bytesToBinString(d[k]) : d[k] === null ? "" : d[k]))
      .join(",") + "\n"
  );
}

async function main() {
  await new Promise((res, rej) => port.open((e) => (e ? rej(e) : res())));
  console.error(`Terbuka ${PATH} @ ${BAUD}, ADR ${ADR}. Ctrl+C untuk berhenti.`);

  if (!SKIP_CONFIG) {
    try {
      printConfig(await readConfig());
    } catch (e) {
      console.error("[warn] gagal baca config:", e.message);
    }
  }
  if (SHOW_ALARM) {
    console.error(
      `Alarm query dari 3 grup: ${ALARM_TARGETS.map((t) => `${t.name}=${hex2(t.cid1)}/${hex2(t.cid2)}`).join(", ")} ` +
        `(masih raw bytes, bandingkan perubahan saat memicu alarm nyata untuk memetakan artinya).`
    );
  }

  while (true) {
    try {
      const d = await readSMU();
      if (d.ac_v === null && d.dc_v === null) {
        console.error("[error] tidak ada respon dari SMU");
      } else {
        AS_JSON ? console.log(JSON.stringify(d)) : printLine(d);
        if (CSV_FILE) appendCsv(d);
      }
    } catch (e) {
      console.error("[error]", e.message);
    }
    await sleep(INTERVAL);
  }
}

process.on("SIGINT", () => port.close(() => process.exit(0)));
main().catch((e) => {
  console.error("Gagal:", e.message);
  process.exit(1);
});