'use strict';
/**

//BETA TEST api.js
//DevDik 
//v0.10.9

 * api.js - Notifikasi Telegram berbasis threshold (BUKAN real-time).
 *
 * Pesan hanya dikirim saat:
 *   - kondisi berubah: NORMAL -> WARNING/KRITIS, WARNING <-> KRITIS, atau kembali NORMAL
 *   - kondisi bermasalah masih berlanjut (pengingat tiap REMINDER_MENIT)
 *
 * Bentuk snapshot data yang diharapkan (field boleh kosong/tidak ada):
 *   {
 *     battery:   { voltage, soc, temp, alarm },
 *     fan:       { temp, rpm, startTemp, alarm },
 *     rectifier: { voltage, modul, acFail, alarm }
 *   }
 *
 * Dua cara pakai:
 *   1) Di-require dari local.js:  const api = require('./api');
 *                                 api.proses(snapshot);   // tiap siklus baca
 *                                 api.mulai();            // sekali saat start: pesan "aktif" + perintah /status
 *   2) Standalone: node --env-file=.env api.js  (ambil data dari DATA_URL)
 */
const fs = require('fs');
const path = require('path');

// Muat .env (satu folder dengan api.js) tanpa dependency; variabel yang sudah ada di environment tidak ditimpa.
try {
  for (const baris of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = baris.match(/^\s*([A-Za-z_]\w*)\s*=\s*(.*?)\s*$/);
    if (m && !m[1].startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* tidak ada .env, tidak apa-apa */ }

const CFG = {
  token: process.env.TG_TOKEN,
  chatId: process.env.TG_CHAT_ID,
  dataUrl: process.env.DATA_URL || 'http://127.0.0.1:3000/api/data',
  intervalDetik: Number(process.env.INTERVAL_DETIK || 10), // ini adalah seberapa sering program membaca sensor (detik)
  konfirmasi: Number(process.env.KONFIRMASI || 3), // berapa kali pembacaan berturut-turut sebelum dianggap  (diatur 3 karena menghindari pembacaan palsu akibat noise)
  reminderMenit: Number(process.env.REMINDER_MENIT || 1), // ini adalah menit pengingat kondisi terkini (menit)
  expectedModul: Number(process.env.EXPECTED_MODUL || 0), // jumlah modul rectifier yang seharusnya aktif (0 = cek dimatikan)
  logFile: process.env.LOG_FILE || 'api.log',
  namaSite: process.env.NAMA_SITE || 'Monitoring Power Dasaria',
};

// =====================================================================
//  SAKLAR PERANGKAT  (ATUR DI SINI)
//  true  = perangkat dipantau (warning & notifikasi aktif)
//  false = perangkat diabaikan (tidak ada warning/notifikasi sama sekali)
// =====================================================================
const AKTIF = {
  battery:   true,   // BATT  (ESM-48100B1)
  fan:       false,   // JPF   (JPF4828)
  rectifier: true,   // RECTI (SMU01C / ETP4890)
};

// Nama tampilan untuk pesan & perintah Telegram
const NAMA_DEV = { battery: 'BATT', fan: 'JPF', rectifier: 'RECTI' };

// ---------- util ----------
const waktu = (t = Date.now()) =>
  new Date(t).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false }) + ' WIB';

function log(...a) {
  const line = `[${waktu()}] ${a.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(CFG.logFile, line + '\n'); } catch { /* abaikan */ }
}

// ---------- Telegram (dengan antrian, supaya pesan tidak hilang saat internet putus) ----------
const antrian = [];
let sedangKuras = false;

async function kirimLangsung(teks) {
  const res = await fetch(`https://api.telegram.org/bot${CFG.token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CFG.chatId, text: teks }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
}

function kirim(teks) {
  antrian.push({ teks, t: Date.now() });
  if (antrian.length > 50) antrian.shift();
  return kuras();
}

async function kuras() {
  if (sedangKuras) return;
  sedangKuras = true;
  try {
    while (antrian.length) {
      const { teks, t } = antrian[0];
      if (!CFG.token || !CFG.chatId) { // mode uji: tanpa token, cetak ke konsol
        console.log('[DRY-RUN]\n' + teks + '\n');
        antrian.shift();
        continue;
      }
      const telat = Date.now() - t > 60000 ? `\n(tertunda, kejadian ${waktu(t)})` : '';
      try {
        await kirimLangsung(teks + telat);
        antrian.shift();
      } catch (e) {
        log('Gagal kirim Telegram (akan dicoba lagi):', e.message);
        break;
      }
    }
  } finally {
    sedangKuras = false;
  }
}

// ---------- pembuat aturan ----------
/** Aturan numerik: low.* = peringatan bila nilai <= batas, high.* = bila nilai >= batas. hys = histeresis. */
function numerik({ ambil, unit = '', low = {}, high = {}, hys = 0, desimal = 1 }) {
  return (s, prev) => {
    const v = ambil(s);
    if (typeof v !== 'number' || Number.isNaN(v)) return null; // tidak ada data -> status tidak diubah
    const adjC = prev === 'crit' ? hys : 0;
    const adjW = prev === 'warn' || prev === 'crit' ? hys : 0;
    let level = 'ok', batas = '';
    if (low.crit != null && v <= low.crit + adjC) { level = 'crit'; batas = `<= ${low.crit}`; }
    else if (high.crit != null && v >= high.crit - adjC) { level = 'crit'; batas = `>= ${high.crit}`; }
    else if (low.warn != null && v <= low.warn + adjW) { level = 'warn'; batas = `<= ${low.warn}`; }
    else if (high.warn != null && v >= high.warn - adjW) { level = 'warn'; batas = `>= ${high.warn}`; }
    return { level, text: `${v.toFixed(desimal)} ${unit}`.trim() + (batas ? ` (batas ${batas})` : '') };
  };
}

/** Aturan alarm: aktif bila field `alarm` perangkat bernilai true / string / array tidak kosong. */
const alarmRule = (kunci, level = 'warn') => (s) => {
  const o = s[kunci];
  if (!o) return null;
  const a = o.alarm;
  const aktif = Array.isArray(a) ? a.length > 0 : !!a;
  const detail = Array.isArray(a) ? a.join(', ') : typeof a === 'string' ? a : '';
  return { level: aktif ? level : 'ok', text: aktif ? `Alarm aktif${detail ? ': ' + detail : ''}` : 'Tidak ada alarm' };
};

/** Aturan koneksi: perangkat tidak mengirim data sama sekali. */
const koneksiRule = (kunci, nama) => (s) => {
  if (!s._ok) return null; // seluruh sumber data mati -> ditangani aturan 'dashboard'
  return { level: s[kunci] ? 'ok' : 'warn', text: s[kunci] ? 'Data terbaca' : `Data ${nama} tidak terbaca (komunikasi/perangkat bermasalah)` };
};

// ---------- ATUR WARNING TIAP & THRESHOLD (sesuaikan angka di sini) ----------
const RULES = [
  { id: 'dashboard', grup: '🖥️ Sistem', nama: 'Sumber data', eval: (s) => ({ level: s._ok ? 'ok' : 'crit', text: s._ok ? 'Tersambung' : 'Data tidak bisa diambil dari local.js' }) },
  { id: 'kon_bat', grup: '🖥️ Sistem', nama: 'Koneksi baterai', eval: koneksiRule('battery', 'baterai') },
  { id: 'kon_fan', grup: '🖥️ Sistem', nama: 'Koneksi fan JPF', eval: koneksiRule('fan', 'fan JPF') },
  { id: 'kon_rect', grup: '🖥️ Sistem', nama: 'Koneksi rectifier', eval: koneksiRule('rectifier', 'rectifier/SMU') },

  { id: 'bat_v', grup: '🔋 Baterai', nama: 'Tegangan', eval: numerik({ ambil: (s) => s.battery?.voltage, unit: 'V', low: { warn: 49.0, crit: 47.0 }, high: { warn: 57.0, crit: 58.0 }, hys: 0.3 }) },
  { id: 'bat_soc', grup: '🔋 Baterai', nama: 'Kapasitas (SOC)', eval: numerik({ ambil: (s) => s.battery?.soc, unit: '%', low: { warn: 40, crit: 20 }, hys: 3, desimal: 0 }) },
  { id: 'bat_temp', grup: '🔋 Baterai', nama: 'Suhu', eval: numerik({ ambil: (s) => s.battery?.temp, unit: '°C', high: { warn: 40, crit: 50 }, hys: 2 }) },
  { id: 'bat_delta', grup: '🔋 Baterai', nama: 'Selisih tegangan sel', eval: numerik({ ambil: (s) => s.battery?.cellDelta, unit: 'mV', high: { warn: 100, crit: 200 }, hys: 20, desimal: 0 }) },
  { id: 'bat_alarm', grup: '🔋 Baterai', nama: 'Alarm perangkat', eval: alarmRule('battery') },
  {
    id: 'bat_mode', grup: '🔋 Baterai', nama: 'Mode baterai',
    eval: (s) => {
      const b = s.battery;
      if (!b || !b.status || b.status === 'Unknown') return null;
      const arus = typeof b.current === 'number' ? ` (arus ${b.current.toFixed(2)} A)` : '';
      const dis = b.status === 'Discharge';
      return { level: dis ? 'warn' : 'ok', text: (dis ? 'DISCHARGE' : 'Charge') + arus };
    },
  },

  { id: 'fan_temp', grup: '🌀 Fan JPF', nama: 'Suhu', eval: numerik({ ambil: (s) => s.fan?.temp, unit: '°C', high: { warn: 27, crit: 29 }, hys: 2 }) },
  {
    id: 'fan_stuck', grup: '🌀 Fan JPF', nama: 'Putaran fan',
    eval: (s) => {
      const f = s.fan;
      if (!f || typeof f.temp !== 'number' || typeof f.rpm !== 'number') return null;
      const L = typeof f.startTemp === 'number' ? f.startTemp : 40;
      const mati = f.temp >= L - 5 && f.rpm <= 0;
      return { level: mati ? 'crit' : 'ok', text: mati ? `Suhu ${f.temp}°C sudah di atas start ${L}°C tapi RPM 0` : `RPM ${f.rpm}` };
    },
  },
  { id: 'fan_alarm', grup: '🌀 Fan JPF', nama: 'Alarm perangkat', eval: alarmRule('fan') },

  { id: 'rect_v', grup: '⚡ Rectifier', nama: 'Tegangan output', eval: numerik({ ambil: (s) => s.rectifier?.voltage, unit: 'V', low: { warn: 50.0, crit: 47.0 }, high: { warn: 57.0, crit: 58.0 }, hys: 0.3 }) },
  { id: 'rect_arus', grup: '⚡ Rectifier', nama: 'Arus rectifier', eval: numerik({ ambil: (s) => s.rectifier?.arus, unit: 'A', desimal: 2 }) },
  { id: 'rect_beban', grup: '⚡ Rectifier', nama: 'Arus beban', eval: numerik({ ambil: (s) => s.rectifier?.arusBeban, unit: 'A', desimal: 2 }) },
  {
    id: 'rect_modul', grup: '⚡ Rectifier', nama: 'Jumlah modul aktif',
    eval: (s) => {
      const r = s.rectifier;
      if (!r || typeof r.modul !== 'number' || !CFG.expectedModul) return null;
      const level = r.modul === 0 ? 'crit' : r.modul < CFG.expectedModul ? 'warn' : 'ok';
      return { level, text: `${r.modul} dari ${CFG.expectedModul} modul aktif` };
    },
  },
  {
    id: 'rect_ac', grup: '⚡ Rectifier', nama: 'Input AC (PLN)',
    eval: (s) => {
      if (!s.rectifier || s.rectifier.acFail == null) return null;
      return { level: s.rectifier.acFail ? 'crit' : 'ok', text: s.rectifier.acFail ? 'Input AC padam, beban ditanggung baterai' : 'Normal' };
    },
  },
  { id: 'rect_alarm', grup: '⚡ Rectifier', nama: 'Alarm perangkat', eval: alarmRule('rectifier') },
];

// ---------- kelompokkan aturan per perangkat (untuk saklar AKTIF) ----------
function perangkatDari(id) {
  if (id === 'kon_bat'  || id.startsWith('bat_'))  return 'battery';
  if (id === 'kon_fan'  || id.startsWith('fan_'))  return 'fan';
  if (id === 'kon_rect' || id.startsWith('rect_')) return 'rectifier';
  return null; // 'dashboard' selalu aktif
}
for (const r of RULES) r.dev = perangkatDari(r.id);

const dimatikan = (r) => r.dev && !AKTIF[r.dev];

// ---------- mesin status ----------
const IKON = { ok: '✅', warn: '⚠️', crit: '❌' };
const LABEL = { ok: 'NORMAL', warn: 'WARNING', crit: 'KRITIS' };
const state = new Map(); // id -> { level, kandidat, hitung, lastSent, text }

function pesan(r, h, ingat) {
  const kepala = ingat ? `🔁 MASIH ${LABEL[h.level]}` : `${IKON[h.level]} ${LABEL[h.level]}`;
  return `${kepala} - ${CFG.namaSite}\n${r.grup} › ${r.nama}\n${h.text}\n🕒 ${waktu()}`;
}

function proses(snapshot) {
  const s = snapshot ? { ...snapshot, _ok: true } : { _ok: false };
  for (const r of RULES) {
    if (dimatikan(r)) { state.delete(r.id); continue; } // perangkat dimatikan -> lewati & reset status

    let st = state.get(r.id);
    if (!st) { st = { level: 'ok', kandidat: 'ok', hitung: 0, lastSent: 0, text: '-' }; state.set(r.id, st); }

    let h;
    try { h = r.eval(s, st.level); } catch (e) { log('Error aturan', r.id, e.message); continue; }
    if (!h) continue;
    st.text = h.text;

    if (h.level === st.level) { // tidak ada perubahan
      st.kandidat = st.level; st.hitung = 0;
      if (st.level !== 'ok' && CFG.reminderMenit > 0 && Date.now() - st.lastSent >= CFG.reminderMenit * 60000) {
        st.lastSent = Date.now();
        kirim(pesan(r, h, true));
      }
      continue;
    }

    // ada kandidat perubahan: harus konsisten beberapa kali berturut-turut (anti lonjakan sesaat)
    if (h.level === st.kandidat) st.hitung++; else { st.kandidat = h.level; st.hitung = 1; }
    if (st.hitung >= CFG.konfirmasi) {
      log(`${r.id}: ${st.level} -> ${h.level} | ${h.text}`);
      st.level = h.level; st.hitung = 0; st.lastSent = Date.now();
      kirim(pesan(r, h, false));
    }
  }
  return kuras(); // sekaligus mencoba kirim ulang pesan yang tertunda
}

function ringkasan() {
  const baris = [`📟 Status ${CFG.namaSite} - ${waktu()}`];
  const off = Object.keys(AKTIF).filter((k) => !AKTIF[k]).map((k) => NAMA_DEV[k]);
  if (off.length) baris.push(`⏸️ Dinonaktifkan: ${off.join(', ')}`);
  let grup = '';
  for (const r of RULES) {
    if (dimatikan(r)) continue;
    const st = state.get(r.id);
    if (!st) continue;
    if (r.grup !== grup) { grup = r.grup; baris.push('\n' + grup); }
    baris.push(`${IKON[st.level]} ${r.nama}: ${st.text}`);
  }
  return baris.join('\n');
}

// ---------- perintah Telegram (/status) - hanya dari chat_id kamu ----------
const KODE_RESTART = 75;

async function restartProgram(offsetBaru) {
  try {
    await kirimLangsung(`🔄 Restart diterima - ${CFG.namaSite}\nProgram dimulai ulang, tunggu pesan "Notifier aktif".\n🕒 ${waktu()}`);
    // Tandai update /restart sebagai sudah dibaca. Tanpa ini, setelah start ulang
    // Telegram mengirim /restart yang sama lagi dan program restart terus (loop).
    await fetch(`https://api.telegram.org/bot${CFG.token}/getUpdates?offset=${offsetBaru}&timeout=0`, { signal: AbortSignal.timeout(10000) });
  } catch (e) {
    log('Persiapan restart gagal:', e.message);
  }
  log('Restart lewat perintah Telegram');
  process.exit(KODE_RESTART);
}

async function dengarPerintah() {
  if (!CFG.token || !CFG.chatId) return;
  let offset = 0;
  for (;;) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${CFG.token}/getUpdates?timeout=25&offset=${offset}`, { signal: AbortSignal.timeout(35000) });
      const j = await res.json();
      for (const u of j.result || []) {
        offset = u.update_id + 1;
        const m = u.message;
        if (!m || String(m.chat.id) !== String(CFG.chatId)) continue; // abaikan orang lain
        const teks = (m.text || '').trim();

        if (/^\/status/.test(teks)) kirim(ringkasan());
        if (/^\/(cek|cek_sistem)/.test(teks)) kirim(ringkasan());

        // /aktifkan <batt|jpf|recti>  atau  /matikan <batt|jpf|recti>  (sementara, kembali ke nilai AKTIF di atas setelah restart)
        const t = teks.match(/^\/(aktifkan|matikan)\s+(batt|jpf|recti)/i);
        if (t) {
          const kunci = { batt: 'battery', jpf: 'fan', recti: 'rectifier' }[t[2].toLowerCase()];
          AKTIF[kunci] = t[1].toLowerCase() === 'aktifkan';
          kirim(`${AKTIF[kunci] ? '▶️ Dipantau' : '⏸️ Dinonaktifkan'}: ${NAMA_DEV[kunci]} - ${CFG.namaSite}\n🕒 ${waktu()}`);
        }

        if (/^\/restart/.test(teks)) await restartProgram(offset);
      }
    } catch {
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

// ---------- mode standalone ----------
/** SESUAIKAN: ubah bentuk JSON dari local.js menjadi bentuk snapshot di bagian atas file. */
function normalisasi(raw) {
  return raw;
}

async function ambilData() {
  const res = await fetch(CFG.dataUrl, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return normalisasi(await res.json());
}

async function loop() {
  let snap = null;
  try { snap = await ambilData(); } catch (e) { log('Gagal ambil data:', e.message); }
  await proses(snap);
  setTimeout(loop, CFG.intervalDetik * 1000);
}

/** Kirim pesan "aktif" dan mulai mendengarkan perintah /status. */
function mulai() {
  const off = Object.keys(AKTIF).filter((k) => !AKTIF[k]).map((k) => NAMA_DEV[k]);
  const info = off.length ? `\n⏸️ Dinonaktifkan: ${off.join(', ')}` : '';
  kirim(`🟢 Notifier aktif - ${CFG.namaSite}${info}\nKetik /status untuk melihat kondisi terakhir, dan ketik /cek untuk mengecek kondisi terkini sistem yang sedang berjalan.\nKetik /matikan atau /aktifkan diikuti batt/jpf/recti untuk mengatur perangkat (sementara).\nKetik /restart untuk memulai ulang program.\n🕒 ${waktu()}`);
  dengarPerintah();
}

if (require.main === module) {
  log('Notifier mulai. Sumber data:', CFG.dataUrl);
  mulai();
  loop();
}

module.exports = { proses, kirim, ringkasan, mulai, RULES, AKTIF };