#!/usr/bin/env node
'use strict';
// version 0.3.10
/*
NAMA FILE: esm-reader.js
 * Pembaca register baterai Huawei ESM-48100B1 (Modbus RTU / RS485)
 * ---------------------------------------------------------------
 * - Hanya membaca (function code 0x03). Tidak ada perintah tulis.
 * - Default: 9600 baud, 8N1, slave address 0xD6 (214).
 * - Peta register berdasarkan capture bus nyata pada ESM-48100B1
 *   (github.com/GImDX/huawei-esm48100, PROTOCOL.md). Firmware/model lain
 *   bisa berbeda, jadi verifikasi hasilnya dengan tampilan di baterai/BMS.
 *
 * Instalasi : npm install serialport
 * Contoh    : node esm-reader.js --list
 *             node esm-reader.js --port /dev/ttyUSB0
 *             node esm-reader.js --port COM3 --slave 0xD7 --once
 *             node esm-reader.js --port /dev/ttyUSB0 --scan
 *             node esm-reader.js --port /dev/ttyUSB0 --read 0x0000 --count 7
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/*  Argumen CLI                                                        */
/* ------------------------------------------------------------------ */
const DEFAULTS = {
  port: process.platform === 'win32' ? 'COM5' : '/dev/ttyACM1',
  baud: 9600,
  parity: 'none',   // none | even | odd  (coba 'even' jika tidak ada respons)
  slave: 0xd6,      // 214
  interval: 5,      // detik antar pembacaan (jaga baterai tetap "bangun")
  timeout: 1500,    // ms menunggu respons per request
};

function usage() {
  console.log(`
Pemakaian: node esm-reader.js [opsi]

  --list                 Tampilkan daftar port serial lalu keluar
  --port, -p <path>      Port serial (mis. /dev/ttyUSB0 atau COM3)   [${DEFAULTS.port}]
  --slave, -s <addr>     Alamat slave, desimal atau 0x..            [0xD6 = 214]
  --baud <n>             Baud rate                                   [${DEFAULTS.baud}]
  --parity <p>           none | even | odd                           [${DEFAULTS.parity}]
  --interval, -i <detik> Jeda antar pembacaan                        [${DEFAULTS.interval}]
  --timeout <ms>         Timeout respons per request                 [${DEFAULTS.timeout}]
  --once                 Baca sekali lalu keluar
  --clear                Bersihkan layar tiap pembacaan
  --scan                 Cari baterai di alamat 0xD6-0xDD dan 0xE0-0xE7
  --read <reg> --count n Dump register mentah (function 0x03)
  --debug                Tampilkan byte TX/RX
  --help, -h             Bantuan
`);
}

function parseNum(s) {
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error(`Angka tidak valid: ${s}`);
  return n;
}

function parseArgs(argv) {
  const o = { ...DEFAULTS, list: false, scan: false, once: false, clear: false, debug: false, read: null, count: 1, help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Opsi ${a} membutuhkan nilai`);
      return argv[++i];
    };
    switch (a) {
      case '--port': case '-p': o.port = next(); break;
      case '--slave': case '-s': o.slave = parseNum(next()); break;
      case '--baud': o.baud = parseNum(next()); break;
      case '--parity': o.parity = next().toLowerCase(); break;
      case '--interval': case '-i': o.interval = parseNum(next()); break;
      case '--timeout': o.timeout = parseNum(next()); break;
      case '--read': o.read = parseNum(next()); break;
      case '--count': o.count = parseNum(next()); break;
      case '--once': o.once = true; break;
      case '--clear': o.clear = true; break;
      case '--scan': o.scan = true; break;
      case '--list': o.list = true; break;
      case '--debug': o.debug = true; break;
      case '--help': case '-h': o.help = true; break;
      default: throw new Error(`Opsi tidak dikenal: ${a}`);
    }
  }
  return o;
}

/* ------------------------------------------------------------------ */
/*  Modbus RTU                                                         */
/* ------------------------------------------------------------------ */
function crc16(buf) {
  let crc = 0xffff;
  for (const b of buf) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  }
  return crc;
}

function buildReadRequest(slave, addr, count) {
  const b = Buffer.alloc(8);
  b[0] = slave;
  b[1] = 0x03;
  b.writeUInt16BE(addr, 2);
  b.writeUInt16BE(count, 4);
  b.writeUInt16LE(crc16(b.subarray(0, 6)), 6); // CRC: low byte dulu
  return b;
}

/**
 * Cari frame respons yang valid di dalam buffer. Pencarian per-offset ini
 * membuat program tahan terhadap echo TX dari adaptor dan byte sampah
 * (baterai ini kadang mengirim sisa byte setelah bangun dari sleep).
 * Return: { regs:[...] } | { exception:kode } | null
 */
function findFrame(buf, slave) {
  for (let i = 0; i + 5 <= buf.length; i++) {
    if (buf[i] !== slave) continue;
    const fn = buf[i + 1];
    if (fn === 0x83) {
      const f = buf.subarray(i, i + 5);
      if (crc16(f.subarray(0, 3)) === f.readUInt16LE(3)) return { exception: f[2] };
    } else if (fn === 0x03) {
      const len = buf[i + 2];
      const total = 5 + len;
      if (len === 0 || len % 2 !== 0 || i + total > buf.length) continue;
      const f = buf.subarray(i, i + total);
      if (crc16(f.subarray(0, total - 2)) === f.readUInt16LE(total - 2)) {
        const regs = [];
        for (let k = 0; k < len; k += 2) regs.push(f.readUInt16BE(3 + k));
        return { regs };
      }
    }
  }
  return null;
}

const EXC_NAMES = {
  1: 'Illegal Function', 2: 'Illegal Data Address', 3: 'Illegal Data Value',
  4: 'Slave Device Failure', 6: 'Slave Device Busy',
};

class ModbusError extends Error {
  constructor(msg, code) { super(msg); this.code = code; }
}

class ModbusRtu {
  constructor(port, { timeout = 1500, debug = false } = {}) {
    this.port = port;
    this.timeout = timeout;
    this.debug = debug;
    this.buf = Buffer.alloc(0);
    this.waiter = null;
    this.lastEnd = 0;
    port.on('data', (d) => {
      if (this.debug) console.log('  RX', d.toString('hex').match(/../g).join(' '));
      this.buf = Buffer.concat([this.buf, d]);
      if (this.waiter) this.waiter();
    });
  }

  _wait(ms) {
    return new Promise((res) => {
      const t = setTimeout(() => { this.waiter = null; res(); }, ms);
      this.waiter = () => { clearTimeout(t); this.waiter = null; res(); };
    });
  }

  _write(data) {
    return new Promise((res, rej) => {
      this.port.write(data, (err) => {
        if (err) return rej(err);
        this.port.drain((err2) => (err2 ? rej(err2) : res()));
      });
    });
  }

  async readRegisters(slave, addr, count, timeout = this.timeout) {
    // Jaga jeda senyap antar frame (>= 3,5 karakter; pakai 20 ms utk USB-RS485)
    const gap = 20 - (Date.now() - this.lastEnd);
    if (gap > 0) await sleep(gap);

    this.buf = Buffer.alloc(0);
    const req = buildReadRequest(slave, addr, count);
    if (this.debug) console.log('  TX', req.toString('hex').match(/../g).join(' '));
    await this._write(req);

    const deadline = Date.now() + timeout;
    for (;;) {
      const r = findFrame(this.buf, slave);
      if (r) {
        this.lastEnd = Date.now();
        if (r.exception !== undefined) {
          throw new ModbusError(
            `Slave 0x${slave.toString(16)} menolak baca 0x${addr.toString(16)} ` +
            `(exception ${r.exception}: ${EXC_NAMES[r.exception] || 'tidak dikenal'})`, 'EXCEPTION');
        }
        if (r.regs.length === count) return r.regs;
        // panjang tidak cocok -> anggap frame sampah, lanjut menunggu
        this.buf = Buffer.alloc(0);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        this.lastEnd = Date.now();
        throw new ModbusError(
          `Timeout membaca 0x${addr.toString(16)} x${count} dari slave 0x${slave.toString(16)}` +
          (this.buf.length ? ` (diterima ${this.buf.length} byte tak valid)` : ' (tidak ada respons)'), 'TIMEOUT');
      }
      await this._wait(remaining);
    }
  }

  /** Baca dengan retry untuk timeout/CRC; exception dari slave tidak di-retry. */
  async read(slave, addr, count, retries = 3) {
    let last;
    for (let i = 0; i < retries; i++) {
      try {
        return await this.readRegisters(slave, addr, count);
      } catch (e) {
        if (e.code === 'EXCEPTION') throw e;
        last = e;
        await sleep(100);
      }
    }
    throw last;
  }
}

/* ------------------------------------------------------------------ */
/*  Dekode data baterai                                                */
/* ------------------------------------------------------------------ */
const u16 = (v) => (v === 0xffff ? null : v);                                 // 0xFFFF = tidak valid
const s16 = (v) => (v === 0x8000 ? null : v & 0x8000 ? v - 0x10000 : v);      // 0x8000 = tidak valid
const u32 = (hi, lo) => ((hi << 16) | lo) >>> 0 === 0xffffffff ? null : ((hi << 16) | lo) >>> 0;
const mul = (v, k) => (v === null ? null : v * k);

const STATE_NAMES = ['Charge', 'Discharge'];

async function readSnapshot(mb, slave, cache) {
  const rd = (a, c) => mb.read(slave, a, c);

  const b = await rd(0x0000, 7);
  const state = (await rd(0x000a, 1))[0];
  const dTimes = await rd(0x0042, 2);
  const dAh = await rd(0x0044, 2);
  const alarms = await rd(0x0046, 5);

  // Data statis, cukup dibaca sekali
  if (cache.cellCount === undefined) {
    cache.swVersion = (await rd(0x0101, 1))[0];
    const n = (await rd(0x010f, 1))[0];
    cache.cellCount = n >= 1 && n <= 24 ? n : 15; // ESM-48100B1 = 15 sel
  }
  const n = cache.cellCount;
  const n1 = Math.min(n, 16);
  let temps = await rd(0x0012, n1);
  let volts = await rd(0x0022, n1);
  if (n > 16) { // hanya untuk model dengan >16 sel (menurut dokumen protokol)
    temps = temps.concat(await rd(0x0300, n - 16));
    volts = volts.concat(await rd(0x0310, n - 16));
  }

  const busV = mul(u16(b[0]), 0.01);
  const packV = mul(u16(b[1]), 0.01);
  const cur = mul(s16(b[2]), 0.01);

  return {
    time: new Date(),
    busV, packV, current: cur,
    power: packV !== null && cur !== null ? packV * cur : null,
    soc: u16(b[3]), soh: u16(b[4]),
    tMax: s16(b[5]), tMin: s16(b[6]),
    state,
    dischargeTimes: u32(dTimes[0], dTimes[1]),
    dischargeAh: u32(dAh[0], dAh[1]),
    alarms,
    swVersion: cache.swVersion,
    cellCount: n,
    cellTemps: temps.map(s16),
    cellVolts: volts.map((v) => (u16(v) === null || v === 999 ? null : v / 1000)),
  };
}

/* ------------------------------------------------------------------ */
/*  Tampilan terminal                                                  */
/* ------------------------------------------------------------------ */
const fmt = (v, d = 2, unit = '') => (v === null || v === undefined ? 'n/a' : `${v.toFixed(d)}${unit ? ' ' + unit : ''}`);
const pad = (s, n) => String(s).padEnd(n);
const hex = (v, w = 4) => '0x' + v.toString(16).toUpperCase().padStart(w, '0');

const ALARM_WORDS = [
  [0x0046, 'Fatal-1'],
  [0x0047, 'Fatal-2 (fault sel)'],
  [0x0048, 'Serius (proteksi)'],
  [0x0049, 'Umum (warning)'],
  [0x004a, 'Modul (alarm/status)'],
];

function printSnapshot(s, slave) {
  const line = (k, v) => console.log(`${pad(k, 24)}: ${v}`);
  console.log(`\n=== Huawei ESM-48100B1 | slave ${hex(slave, 2)} (${slave}) | ${s.time.toLocaleString()} ===`);
  line('Tegangan busbar', fmt(s.busV, 2, 'V'));
  line('Tegangan pack', fmt(s.packV, 2, 'V'));
  line('Arus', fmt(s.current, 2, 'A'));
  line('Daya (V x I)', fmt(s.power, 1, 'W'));
  line('SOC', s.soc === null ? 'n/a' : `${s.soc} %`);
  line('SOH', s.soh === null ? 'n/a' : `${s.soh} %`);
  line('Suhu sel maks / min', `${s.tMax ?? 'n/a'} / ${s.tMin ?? 'n/a'} °C`);
  line('Status', `${STATE_NAMES[s.state] ?? 'Unknown'} (${s.state})`);
  line('Jumlah discharge', s.dischargeTimes === null ? 'n/a' : `${s.dischargeTimes} kali`);
  line('Total discharge', s.dischargeAh === null ? 'n/a' : `${s.dischargeAh} Ah`);
  line('Versi software (raw)', hex(s.swVersion));
  line('Jumlah sel', s.cellCount);

  const vs = s.cellVolts.filter((v) => v !== null);
  if (vs.length) {
    const delta = (Math.max(...vs) - Math.min(...vs)) * 1000;
    line('Selisih tegangan sel', `${delta.toFixed(0)} mV (maks ${Math.max(...vs).toFixed(3)} V, min ${Math.min(...vs).toFixed(3)} V)`);
    line('Jumlah tegangan sel', fmt(vs.reduce((a, b) => a + b, 0), 2, 'V'));
  }

  console.log('\n  Sel   Tegangan    Suhu');
  s.cellVolts.forEach((v, i) => {
    console.log(`  ${String(i + 1).padStart(2)}    ${pad(fmt(v, 3, 'V'), 10)}  ${s.cellTemps[i] ?? 'n/a'} °C`);
  });

  console.log('\n  Alarm:');
  let any = false;
  s.alarms.forEach((w, i) => {
    const bits = [];
    for (let b = 0; b < 16; b++) if (w & (1 << b)) bits.push(b);
    if (w) any = true;
    console.log(`  ${hex(ALARM_WORDS[i][0])} ${pad(ALARM_WORDS[i][1], 22)} ${hex(w)}${bits.length ? '  bit aktif: ' + bits.join(',') : ''}`);
  });
  if (!any) console.log('  (semua word alarm = 0, tidak ada alarm)');
}

/* ------------------------------------------------------------------ */
/*  Fitur bantu: wake-up, scan, dump                                   */
/* ------------------------------------------------------------------ */
/** Baterai bisa "tidur" bila bus sepi; beberapa request pertama bisa tanpa respons. */
async function wakeUp(mb, slave, maxMs = 60000) {
  const start = Date.now();
  for (let attempt = 1; Date.now() - start < maxMs; attempt++) {
    try {
      await mb.readRegisters(slave, 0x0000, 1, 1500);
      if (attempt > 1) console.log(`  -> baterai merespons pada percobaan ke-${attempt}`);
      return;
    } catch (e) {
      if (e.code === 'EXCEPTION') throw e;
      process.stdout.write(`\rMenunggu respons baterai ${hex(slave, 2)}... percobaan ${attempt} (${Math.round((Date.now() - start) / 1000)} dtk)   `);
      await sleep(3000);
    }
  }
  process.stdout.write('\n');
  throw new Error('Baterai tidak merespons dalam 60 detik. Cek wiring A/B, port, baud/parity, dan alamat slave.');
}

async function scan(mb, windowMs = 60000) {
  const addrs = [];
  for (let a = 0xd6; a <= 0xdd; a++) addrs.push(a);
  for (let a = 0xe0; a <= 0xe7; a++) addrs.push(a);
  const found = new Set();
  const start = Date.now();
  console.log(`Scan ${addrs.length} alamat (0xD6-0xDD, 0xE0-0xE7), maks ${windowMs / 1000} detik...`);
  while (Date.now() - start < windowMs) {
    for (const a of addrs) {
      if (found.has(a)) continue;
      try {
        const [v] = await mb.readRegisters(a, 0x0000, 1, 500);
        found.add(a);
        console.log(`  Ditemukan: slave ${hex(a, 2)} (${a}), reg 0x0000 = ${v}`);
      } catch (e) { /* belum merespons */ }
    }
    if (found.size === addrs.length) break;
    await sleep(3000);
  }
  console.log(found.size ? `Selesai: ${found.size} perangkat.` : 'Tidak ada perangkat yang merespons.');
}

async function dump(mb, slave, addr, count) {
  const regs = await mb.read(slave, addr, count);
  console.log(`Slave ${hex(slave, 2)}, register ${hex(addr)} .. ${hex(addr + count - 1)}`);
  regs.forEach((v, i) => {
    console.log(`  ${hex(addr + i)}  dec=${String(v).padStart(5)}  s16=${String(v & 0x8000 ? v - 0x10000 : v).padStart(6)}  hex=${hex(v)}`);
  });
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */
function openPort(SerialPort, o) {
  return new Promise((resolve, reject) => {
    const p = new SerialPort(
      { path: o.port, baudRate: o.baud, dataBits: 8, stopBits: 1, parity: o.parity },
      (err) => (err ? reject(err) : resolve(p)),
    );
  });
}

async function main() {
  let o;
  try { o = parseArgs(process.argv); } catch (e) { console.error(e.message); usage(); process.exit(1); }
  if (o.help) return usage();

  let SerialPort;
  try { ({ SerialPort } = require('serialport')); } catch (e) {
    console.error('Modul "serialport" belum terpasang. Jalankan:  npm install serialport');
    process.exit(1);
  }

  if (o.list) {
    const ports = await SerialPort.list();
    if (!ports.length) return console.log('Tidak ada port serial terdeteksi.');
    ports.forEach((p) => console.log(`${pad(p.path, 28)} ${p.manufacturer || ''} ${p.serialNumber ? 'SN:' + p.serialNumber : ''} ${p.vendorId ? `VID:${p.vendorId} PID:${p.productId}` : ''}`));
    return;
  }

  let port;
  try { port = await openPort(SerialPort, o); } catch (e) {
    console.error(`Gagal membuka ${o.port}: ${e.message}`);
    if (process.platform === 'linux') console.error('Tips: sudo usermod -aG dialout $USER  (lalu login ulang), dan pastikan port benar (--list).');
    process.exit(1);
  }
  console.log(`Port ${o.port} terbuka: ${o.baud} baud, 8${o.parity[0].toUpperCase()}1`);

  const mb = new ModbusRtu(port, { timeout: o.timeout, debug: o.debug });
  let stop = false;
  process.on('SIGINT', () => { stop = true; console.log('\nBerhenti...'); port.close(() => process.exit(0)); });

  try {
    if (o.scan) return await scan(mb);

    await wakeUp(mb, o.slave);
    if (o.read !== null) return await dump(mb, o.slave, o.read, o.count);

    const cache = {};
    let fails = 0;
    while (!stop) {
      try {
        const snap = await readSnapshot(mb, o.slave, cache);
        if (o.clear) process.stdout.write('\x1b[2J\x1b[H');
        printSnapshot(snap, o.slave);
        fails = 0;
      } catch (e) {
        fails++;
        console.error(`[!] ${e.message}`);
        if (fails >= 3) { console.error('[!] Gagal berulang, mencoba membangunkan baterai lagi...'); await wakeUp(mb, o.slave); fails = 0; }
      }
      if (o.once) break;
      await sleep(o.interval * 1000);
    }
  } catch (e) {
    console.error(`\nError: ${e.message}`);
    process.exitCode = 1;
  } finally {
    if (!stop && port.isOpen) port.close();
  }
}

module.exports = { crc16, buildReadRequest, findFrame, ModbusRtu, readSnapshot, printSnapshot };

if (require.main === module) main();
