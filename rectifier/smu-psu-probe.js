// smu-psu-probe.js
// Bantu cari JUMLAH PSU (modul rectifier) di Huawei SMU01C lewat protokol YDN. Read-only.
//
// Jalankan (pastikan port SMU tidak sedang dipakai local.js / smu-monitor.js):
//   node smu-psu-probe.js COM5                     (probe sekali, seperti sebelumnya)
//   node smu-psu-probe.js COM5 --watch             (pantau terus, cetak tiap 2 detik)
//   node smu-psu-probe.js COM5 --watch --interval 1000
//   node smu-psu-probe.js COM5 --adr 1 --baud 19200
//
// Mode --watch: dipakai sambil memasang / mencabut PSU. Tiap baris menampilkan panjang data 41/41,
// jumlah modul (byte[5]), tegangan output rectifier, arus modul, dan tegangan DC bus (grup 42/41).
// Baris diberi tanda "<<< BERUBAH" kalau jumlah modul atau panjang data berbeda dari pembacaan sebelumnya.
// Tegangan DC bus ikut ditampilkan supaya kelihatan kalau bus turun saat PSU tidak terbaca
// (artinya beban sedang ditopang baterai).

const { SerialPort } = require('serialport');

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const PATH = args[0] && !args[0].startsWith('--') ? args[0] : 'COM5';
const BAUD = parseInt(opt('baud', '19200'), 10);
const ADR = parseInt(opt('adr', '1'), 10);
const VER = parseInt(opt('ver', '21'), 16);
const INTERVAL = parseInt(opt('interval', '2000'), 10);
const WATCH = args.includes('--watch');
const TIMEOUT = 700;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, '0');
const hex4 = (n) => n.toString(16).toUpperCase().padStart(4, '0');

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
function buildFrame(cid1, cid2, info = '') {
  const body = hex2(VER) + hex2(ADR) + hex2(cid1) + hex2(cid2) + lengthField(info.length) + info;
  return `~${body}${checksum(body)}\r`;
}
function toBytes(info) {
  const out = [];
  for (let i = 0; i + 1 < info.length; i += 2) {
    const pair = info.slice(i, i + 2);
    out.push(/^[0-9A-Fa-f]{2}$/.test(pair) ? parseInt(pair, 16) : null);
  }
  return out;
}
function f32(bytes, off) {
  if (!bytes) return null;
  const w = bytes.slice(off, off + 4);
  if (w.length < 4 || w.some((x) => x === null)) return null;
  const v = Buffer.from(w).readFloatLE(0);
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
}

const port = new SerialPort({ path: PATH, baudRate: BAUD, dataBits: 8, stopBits: 1, parity: 'none', autoOpen: false });
let rx = '';
port.on('data', (d) => (rx += d.toString('latin1')));

async function query(frame) {
  rx = '';
  await new Promise((res, rej) => port.write(frame, 'latin1', (e) => (e ? rej(e) : res())));
  await new Promise((res) => port.drain(res));
  const start = Date.now();
  let r = '';
  while (Date.now() - start < TIMEOUT) {
    r = rx.startsWith(frame) ? rx.slice(frame.length) : rx;
    if (r.includes('\r')) return r;
    await sleep(10);
  }
  return rx.startsWith(frame) ? rx.slice(frame.length) : rx;
}

/** Kirim command, kembalikan { ok, rtn, bytes } atau { ok:false, why }. */
async function getBytes(cid1, cid2, info = '') {
  const s = (await query(buildFrame(cid1, cid2, info))).replace(/\r$/, '');
  if (!s || s[0] !== '~' || s.length < 17) return { ok: false, why: 'tidak ada respons valid' };
  if (checksum(s.slice(1, -4)) !== s.slice(-4)) return { ok: false, why: 'checksum salah' };
  const rtn = s.slice(7, 9);
  if (rtn !== '00') return { ok: false, rtn, why: `RTN=${rtn}` };
  return { ok: true, rtn, bytes: toBytes(s.slice(13, -4)) };
}

/* ---------------- Mode probe sekali (sama seperti versi lama) ---------------- */
function show(label, res) {
  console.log(`\n=== ${label} ===`);
  if (!res.ok) {
    console.log(res.rtn ? `  RTN = ${res.rtn} (ditolak / tidak didukung)` : `  (${res.why})`);
    return;
  }
  const bytes = res.bytes;
  console.log('  RTN = 00 (OK)');
  console.log(`  panjang data = ${bytes.length} byte`);
  for (let i = 0; i < bytes.length; i += 8) {
    const row = bytes.slice(i, i + 8).map((b) => (b === null ? '??' : hex2(b))).join(' ');
    console.log(`  [${String(i).padStart(3)}] ${row}`);
  }
  const small = [];
  for (let i = 0; i < Math.min(8, bytes.length); i++) if (bytes[i] !== null && bytes[i] >= 1 && bytes[i] <= 12) small.push(`byte[${i}]=${bytes[i]}`);
  if (small.length) console.log(`  kandidat jumlah modul: ${small.join(', ')}`);
  const fl = [];
  for (let i = 0; i + 4 <= bytes.length; i++) {
    const w = bytes.slice(i, i + 4);
    if (w.some((x) => x === null)) continue;
    const v = Buffer.from(w).readFloatLE(0);
    if (Number.isFinite(v) && Math.abs(v) >= 0.01 && Math.abs(v) < 1000) fl.push(`@${i}=${Math.round(v * 100) / 100}`);
  }
  if (fl.length) console.log(`  float (offset=nilai): ${fl.join('  ')}`);
}

const COMMANDS = [
  [0x41, 0x41, '', 'rectifier analog (41/41) info kosong'],
  [0x41, 0x41, '01', 'rectifier analog (41/41) info 01'],
  [0x41, 0x43, '', 'rectifier status/digital (41/43) info kosong'],
  [0x41, 0x43, '01', 'rectifier status/digital (41/43) info 01'],
  [0x41, 0x44, '', 'rectifier alarm (41/44) info kosong'],
  [0x41, 0x44, '01', 'rectifier alarm (41/44) info 01'],
  [0x41, 0x46, '', 'rectifier config (41/46) info kosong'],
  [0x41, 0x46, '01', 'rectifier config (41/46) info 01'],
];

async function probeOnce() {
  for (const [c1, c2, info, label] of COMMANDS) {
    show(label, await getBytes(c1, c2, info));
    await sleep(100);
  }
}

/* ---------------- Mode watch ---------------- */
const fmt = (v, d = 2) => (v === null || v === undefined ? '--' : v.toFixed(d));

async function watch() {
  console.log(`Mode watch tiap ${INTERVAL} ms. Ctrl+C untuk berhenti.`);
  console.log('Pasang / cabut PSU sekarang, lalu lihat kapan jumlah modul berubah.\n');
  let last = null;
  for (;;) {
    const t = new Date().toLocaleTimeString();
    let line;
    let sig;
    try {
      const rc = await getBytes(0x41, 0x41, '');
      const st = await getBytes(0x41, 0x43, '');
      const dc = await getBytes(0x42, 0x41, '01');
      const dcV = dc.ok ? f32(dc.bytes, 1) : null;
      if (!rc.ok) {
        sig = `rc:${rc.why}`;
        line = `[${t}] 41/41 gagal (${rc.why}) | DC bus ${fmt(dcV)} V`;
      } else {
        const b = rc.bytes;
        const m = b.length > 5 ? b[5] : null;
        const vOut = f32(b, 1);
        const cur = m >= 1 ? f32(b, 6) : null;
        const stLen = st.ok ? st.bytes.length : '--';
        sig = `len:${b.length}|m:${m}|st:${stLen}`;
        line =
          `[${t}] 41/41 ${String(b.length).padStart(2)} byte | modul=${m} | V out ${fmt(vOut)} V` +
          ` | arus modul1 ${fmt(cur)} A | 41/43 ${stLen} byte | DC bus ${fmt(dcV)} V`;
      }
    } catch (e) {
      sig = `err:${e.message}`;
      line = `[${t}] error: ${e.message}`;
    }
    console.log(line + (last !== null && sig !== last ? '   <<< BERUBAH' : ''));
    last = sig;
    await sleep(INTERVAL);
  }
}

(async () => {
  await new Promise((res, rej) => port.open((e) => (e ? rej(e) : res())));
  console.log(`Terbuka ${PATH} @ ${BAUD}, ADR ${ADR}`);
  if (WATCH) {
    process.on('SIGINT', () => port.close(() => process.exit(0)));
    await watch();
  } else {
    await probeOnce();
    port.close(() => process.exit(0));
  }
})().catch((e) => { console.error('Gagal:', e.message); process.exit(1); });