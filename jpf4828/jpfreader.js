#!/usr/bin/env node
'use strict';

//version 0.3.10
/**
NAMA FILE: jpfreader.js
 * JPF4828 RS485 (Modbus RTU) Reader/Writer — Node.js
 * -----------------------------------------------------------------
 * Alat: JPF4828 4-wire PWM DC Fan Temperature Control & Speed
 *       Regulation Terminal — Chengdu Jingzhicheng Electronic Tech.
 *
 * Peta register di bawah ini SUDAH DIVALIDASI dari:
 *   1) User Manual V2.0 resmi (bagian 10.3 "Register address table"
 *      dan 10.4 "RS485 serial port protocol usage example")
 *   2) Hasil scan langsung ke device (dicocokkan dengan suhu 29°C
 *      yang tampil di layar fisik alat — match persis di register 1)
 *
 * Serial port: 9600 baud, no parity, 8 data bits, 1 stop bit (tetap)
 * -----------------------------------------------------------------
 * File ini bisa dipakai dua cara:
 *
 *  1) CLI (seperti sebelumnya):
 *       node jpf4828.js                     polling terus-menerus
 *       node jpf4828.js scan                baca 22 register mentah
 *       node jpf4828.js setspeed 60         paksa speed fan 60%
 *       node jpf4828.js on [N] | off        paksa speed N% (default 100) / 0%
 *       node jpf4828.js release             speed fan kembali otomatis
 *       node jpf4828.js setL 30 | setH 50   ubah L / H
 *       node jpf4828.js set <param> <nilai> ubah parameter apa saja (lihat bawah)
 *       node jpf4828.js config              interaktif, tanya semua parameter
 *
 *     Parameter untuk "set": startTemp(L) fullTemp(H) workingMode(P)
 *     numFans(F) pwmFreq relayOpenT(b) relayCloseT(C) fanSpeed (angka / auto)
 *       contoh:  node jpf4828.js set F 6      node jpf4828.js set P 0
 *
 *  2) Modul (dipanggil oleh local.js):
 *       const { createJpf } = require('./jpf4828');
 *       const jpf = createJpf({ port: 'COM6', slaveId: 1 });
 *       await jpf.connect();
 *       const data = await jpf.readAll();
 *       await jpf.setParams({ startTemp: 30, fullTemp: 50 });
 * -----------------------------------------------------------------
 */

const ModbusRTU = require('modbus-serial');

// ============ KONFIGURASI — SESUAIKAN DENGAN SETUP ANDA ============
// (dipakai untuk mode CLI; kalau dipanggil dari local.js, nilainya ditimpa
//  oleh opsi yang dikirim local.js, mis. --jpf COM6)
const CONFIG = {
  //port: "COM6",
  port: '/dev/ttyACM2',      // Ganti sesuai port COM Anda (cek Device Manager)
  baudRate: 9600,            // Tetap 9600 (fixed by device, sesuai manual 10.2)
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  slaveId: 1,                // Alamat Modbus device (default pabrik = 1)
  timeoutMs: 1000,
  pollIntervalMs: 2000,
};

// Peta register resmi JPF4828 (holding register, function code 0x03/0x06)
//   settable: true  -> boleh diubah lewat setParams() / web local.js
//   short/unit/min/max dipakai untuk validasi dan pesan.
// modbusAddr dan relayState sengaja TIDAK settable:
//   - modbusAddr : kalau diubah, alamat slave di konfigurasi jadi tidak cocok
//                  dan komunikasi putus sampai konfigurasi disesuaikan.
//   - relayState : arti nilai "force control"-nya belum diketahui.
const REGISTERS = {
  tm1Temp:      { addr: 0x0000, rw: false, offset: 40, label: 'Suhu Sensor 1 / TM1 (°C)' },
  tm2Temp:      { addr: 0x0001, rw: false, offset: 40, label: 'Suhu Sensor 2 / TM2 (°C)' },
  fanSpeed:     { addr: 0x0002, rw: true,  offset: 0,  label: 'Speed Fan (%)',
                  settable: true, short: 'Speed fan paksa', unit: '%', min: 0, max: 100 },
  fanStatus:    { addr: 0x0003, rw: false, offset: 0,  label: 'Status Fan (bitmap, 1=jalan)' },
  fanFault:     { addr: 0x0004, rw: false, offset: 0,  label: 'Fault Fan (bitmap, 1=normal)' },
  startTemp:    { addr: 0x0005, rw: true,  offset: 40, label: 'Setting Suhu Start / L (°C)',
                  settable: true, short: 'L (start temp)', unit: '°C', min: -20, max: 120 },
  fullTemp:     { addr: 0x0006, rw: true,  offset: 40, label: 'Setting Suhu Full Speed / H (°C)',
                  settable: true, short: 'H (full speed temp)', unit: '°C', min: -20, max: 120 },
  workingMode:  { addr: 0x0007, rw: true,  offset: 0,  label: 'Mode Kerja / P (1=min speed, 0=shutdown)',
                  settable: true, short: 'Mode kerja (P)', unit: '', min: 0, max: 1 },
  numFans:      { addr: 0x0008, rw: true,  offset: 0,  label: 'Jumlah Fan Terpasang / F (0-8)',
                  settable: true, short: 'Jumlah fan (F)', unit: '', min: 0, max: 8 },
  modbusAddr:   { addr: 0x0009, rw: true,  offset: 0,  label: 'Alamat Modbus / A' },
  pwmFreq:      { addr: 0x0012, rw: true,  offset: 0,  label: 'PWM Frequency (0=500Hz..5=25KHz)',
                  settable: true, short: 'PWM frequency (kode)', unit: '', min: 0, max: 5 },
  relayOpenT:   { addr: 0x0013, rw: true,  offset: 40, label: 'Suhu Buka Relay Temp-Control / b (°C)',
                  settable: true, short: 'Suhu buka relay (b)', unit: '°C', min: -20, max: 120 },
  relayCloseT:  { addr: 0x0014, rw: true,  offset: 40, label: 'Suhu Tutup Relay Temp-Control / C (°C)',
                  settable: true, short: 'Suhu tutup relay (C)', unit: '°C', min: -20, max: 120 },
  relayState:   { addr: 0x0015, rw: true,  offset: 0,  label: 'State Relay Temp-Control (force ctrl)' },
};
const SETTABLE = Object.keys(REGISTERS).filter((k) => REGISTERS[k].settable);

// Register RPM 8 fan: 0x000A - 0x0011 (fan1..fan8)
const RPM_BASE_ADDR = 0x000a;
const RPM_COUNT = 8;
const REG_COUNT = 22; // 0x0000 - 0x0015

// =====================================================================

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function applyOffset(raw, offset) {
  // Nilai suhu di device pakai signed representation setelah dikurangi offset
  const signed = raw > 32767 ? raw - 65536 : raw;
  return signed - offset;
}

/** 22 register mentah -> objek nilai per nama register + daftar fan. */
function decode(raw) {
  const v = {};
  for (const [k, def] of Object.entries(REGISTERS)) v[k] = applyOffset(raw[def.addr], def.offset);
  v.rpm = raw.slice(RPM_BASE_ADDR, RPM_BASE_ADDR + RPM_COUNT);
  v.fans = [];
  const n = Math.min(raw[REGISTERS.numFans.addr], 8);
  for (let i = 0; i < n; i++) {
    v.fans.push({
      n: i + 1,
      rpm: raw[RPM_BASE_ADDR + i],
      running: !!((raw[REGISTERS.fanStatus.addr] >> i) & 1), // bitmap status: 1 = jalan
      ok: !!((raw[REGISTERS.fanFault.addr] >> i) & 1),       // bitmap fault : 1 = normal
    });
  }
  v.raw = raw;
  return v;
}

/**
 * Buat koneksi JPF4828. Semua operasi baca/tulis diantre (satu transaksi
 * pada satu waktu), jadi aman dipanggil bersamaan dari polling dan web.
 */
function createJpf(options = {}) {
  const cfg = { ...CONFIG, ...options };
  let client = null;
  let chain = Promise.resolve();
  const exclusive = (fn) => {
    const run = chain.then(fn);
    chain = run.catch(() => {});
    return run;
  };

  const isOpen = () => !!(client && client.isOpen);
  const need = () => { if (!isOpen()) throw new Error('Port JPF belum terbuka'); };

  function close() {
    return new Promise((res) => {
      if (client && client.isOpen) client.close(() => res());
      else res();
    });
  }

  async function connect() {
    await close();
    client = new ModbusRTU();
    client.on('error', () => {}); // error ditangani lewat promise / cek isOpen()
    await client.connectRTUBuffered(cfg.port, {
      baudRate: cfg.baudRate,
      dataBits: cfg.dataBits,
      stopBits: cfg.stopBits,
      parity: cfg.parity,
    });
    client.setID(cfg.slaveId);
    client.setTimeout(cfg.timeoutMs);
  }

  /** Baca semua 22 register sekaligus (manual bagian 10.4.7). Tanpa antrean. */
  async function _readRaw(attempts = 2) {
    need();
    let last;
    for (let i = 0; i < attempts; i++) {
      try {
        return (await client.readHoldingRegisters(0x0000, REG_COUNT)).data;
      } catch (e) {
        last = e;
        await sleep(100);
      }
    }
    throw last;
  }

  const readRaw = () => exclusive(() => _readRaw());
  const readAll = () => exclusive(async () => decode(await _readRaw()));

  /**
   * Ubah satu atau beberapa parameter sekaligus, mis. { startTemp: 30, numFans: 6 }.
   *  - hanya key dengan settable:true; nilai bilangan bulat dalam rentang min..max
   *  - suhu disimpan di alat sebagai raw = suhu + 40
   *  - fanSpeed: 0-100 = paksa speed, 'auto' = kirim 0xFFFF (kembali ke kontrol suhu)
   *  - H harus > L; urutan tulis diatur supaya H > L selalu terjaga di alat
   *  - setelah menulis, semua nilai dibaca ulang dari alat sebagai bukti
   * Return: { applied:[{key,label,value,unit}], warnings:[...], changed:boolean }
   */
  function setParams(req) {
    return exclusive(async () => {
      const want = {};
      for (const [k, v] of Object.entries(req)) {
        if (v === undefined) continue;
        const def = REGISTERS[k];
        if (!def || !def.settable) throw new Error(`Parameter tidak dikenal atau tidak bisa diubah: ${k}`);
        if (k === 'fanSpeed' && v === 'auto') { want[k] = 'auto'; continue; }
        if (!Number.isInteger(v) || v < def.min || v > def.max) {
          throw new Error(`${def.short} harus bilangan bulat antara ${def.min} dan ${def.max}${def.unit ? ' ' + def.unit : ''}`);
        }
        want[k] = v;
      }
      if (!Object.keys(want).length) throw new Error('Isi minimal satu nilai yang ingin diubah');

      const cur = decode(await _readRaw());
      const newL = want.startTemp !== undefined ? want.startTemp : cur.startTemp;
      const newH = want.fullTemp !== undefined ? want.fullTemp : cur.fullTemp;
      if (newH <= newL) throw new Error(`H (${newH}°C) harus LEBIH BESAR dari L (${newL}°C)`);

      const writes = [];
      for (const [k, v] of Object.entries(want)) {
        const def = REGISTERS[k];
        if (k === 'fanSpeed') writes.push({ key: k, addr: def.addr, raw: v === 'auto' ? 0xffff : v });
        else if (v !== cur[k]) writes.push({ key: k, addr: def.addr, raw: v + def.offset });
      }
      // Kalau L baru >= H lama, tulis H dulu supaya H > L selalu terjaga di alat
      if (newL >= cur.fullTemp) {
        const li = writes.findIndex((w) => w.key === 'startTemp');
        const hi = writes.findIndex((w) => w.key === 'fullTemp');
        if (li >= 0 && hi >= 0 && li < hi) [writes[li], writes[hi]] = [writes[hi], writes[li]];
      }

      need();
      for (const w of writes) await client.writeRegister(w.addr, w.raw);

      await sleep(300);
      const now = decode(await _readRaw());
      const warnings = [];
      for (const [k, v] of Object.entries(want)) {
        const def = REGISTERS[k];
        if (k === 'fanSpeed') {
          if (v !== 'auto' && now.fanSpeed !== v) {
            warnings.push(`Speed fan terbaca ${now.fanSpeed}% (diminta ${v}%), alat mungkin masih menyesuaikan atau menimpa.`);
          }
        } else if (now[k] !== v) {
          throw new Error(`Alat tidak menerima ${def.short}. Sekarang ${now[k]}${def.unit ? ' ' + def.unit : ''} (diminta ${v}).`);
        }
      }
      const applied = Object.keys(want).map((k) => {
        const auto = k === 'fanSpeed' && want[k] === 'auto';
        return {
          key: k,
          label: REGISTERS[k].short,
          value: auto ? 'otomatis (ikut suhu)' : now[k],
          unit: auto ? '' : REGISTERS[k].unit,
        };
      });
      return { applied, warnings, changed: writes.length > 0 };
    });
  }

  return { config: cfg, connect, close, isOpen, readRaw, readAll, setParams };
}

// =====================================================================
//  CLI
// =====================================================================

// Huruf di panel alat -> nama register
const ALIASES = { L: 'startTemp', H: 'fullTemp', P: 'workingMode', F: 'numFans', b: 'relayOpenT', C: 'relayCloseT', speed: 'fanSpeed' };
const parseValue = (key, s) => (key === 'fanSpeed' && String(s).toLowerCase() === 'auto' ? 'auto' : Number(s));

function printResult(r) {
  for (const a of r.applied) console.log(`  ${a.label} -> ${a.value}${a.unit ? ' ' + a.unit : ''}`);
  console.log('  (nilai di atas sudah dibaca ulang dari alat)');
  for (const w of r.warnings) console.log(`  Catatan: ${w}`);
}

async function pollLoop(jpf) {
  console.log('Mulai polling data. Tekan Ctrl+C untuk berhenti.\n');
  for (;;) {
    try {
      const v = await jpf.readAll();
      console.log(`\n[${new Date().toISOString()}]`);
      for (const [k, def] of Object.entries(REGISTERS)) {
        console.log(`  ${def.label}: ${v[k]}  (raw=${v.raw[def.addr]})`);
      }
      console.log(`  RPM Fan1-8: ${v.rpm.join(', ')}`);
    } catch (e) {
      console.error(`ERROR - ${e.message}`);
    }
    await sleep(CONFIG.pollIntervalMs);
  }
}

async function interactiveConfig(jpf) {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((resolve) => rl.question(q, resolve));
  try {
    const cur = await jpf.readAll();
    const req = {};
    for (const k of SETTABLE) {
      const def = REGISTERS[k];
      const hint = k === 'fanSpeed' ? '0-100 atau "auto"' : `${def.min}..${def.max}`;
      const ans = (await ask(`${def.short} [sekarang ${cur[k]}${def.unit ? ' ' + def.unit : ''}] (${hint}), kosongkan untuk skip: `)).trim();
      if (ans !== '') req[k] = parseValue(k, ans);
    }
    rl.close();
    if (!Object.keys(req).length) return console.log('Tidak ada nilai yang diubah.');
    printResult(await jpf.setParams(req));
  } finally {
    rl.close();
  }
}

async function cli() {
  const jpf = createJpf();
  await jpf.connect();
  console.log(`Terhubung ke ${CONFIG.port} @ ${CONFIG.baudRate}bps, slave ID ${CONFIG.slaveId}\n`);

  const mode = process.argv[2];
  const arg = process.argv[3];
  const arg2 = process.argv[4];
  const set = async (req) => printResult(await jpf.setParams(req));

  try {
    if (mode === 'scan') {
      const raw = await jpf.readRaw();
      console.log('Raw 22 register (0x0000 - 0x0015):');
      raw.forEach((v, i) => console.log(`  Reg 0x${i.toString(16).padStart(4, '0')}: raw=${v}`));
    } else if (mode === 'setspeed' && arg !== undefined) {
      await set({ fanSpeed: parseInt(arg, 10) });
    } else if (mode === 'on') {
      await set({ fanSpeed: arg !== undefined ? parseInt(arg, 10) : 100 }); // paksa 100% (atau angka lain)
    } else if (mode === 'off') {
      await set({ fanSpeed: 0 }); // paksa 0%
    } else if (mode === 'release') {
      await set({ fanSpeed: 'auto' });
    } else if (mode === 'setL' && arg !== undefined) {
      await set({ startTemp: Number(arg) });
    } else if (mode === 'setH' && arg !== undefined) {
      await set({ fullTemp: Number(arg) });
    } else if (mode === 'set') {
      const key = ALIASES[arg] || arg;
      if (!SETTABLE.includes(key) || arg2 === undefined) {
        console.log(`Pemakaian: node jpf4828.js set <param> <nilai>\nParam: ${SETTABLE.join(', ')}\nAlias: ${Object.entries(ALIASES).map(([a, k]) => `${a}=${k}`).join(', ')}`);
      } else {
        await set({ [key]: parseValue(key, arg2) });
      }
    } else if (mode === 'config') {
      await interactiveConfig(jpf);
    } else {
      return await pollLoop(jpf); // polling tidak berhenti sendiri
    }
  } catch (e) {
    console.error('Gagal:', e.message);
    process.exitCode = 1;
  }
  process.exit(process.exitCode || 0);
}

module.exports = { createJpf, REGISTERS, SETTABLE, CONFIG, applyOffset, decode };

if (require.main === module) {
  cli().catch((err) => {
    console.error('Gagal konek/membaca:', err.message);
    process.exit(1);
  });
}