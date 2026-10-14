#!/usr/bin/env node
'use strict';

/*BETA TEST api.js
 *DevDik 
 *v0.10.8
 * local.js
 * 
 * 
 * ---------------------------------------------------------------
 *  1) JPF4828     : fan controller, Modbus RTU, slave 1
 *  2) ESM-48100B1 : baterai Huawei, Modbus RTU, slave 0xD6
 *  3) SMU01C      : Huawei SMU, protokol YDN, ADR 1
 *
 * Dependency:  npm install serialport modbus-serial
 * File pendamping: ./jpf4828/jpfreader.js (logika baca/tulis JPF4828)
 *                  ./api.js             (API untuk notifikasi Telegram)
 *                  ./.env                 (TG_TOKEN, TG_CHAT_ID, EXPECTED_MODUL, ...)
 *
 * BARU: port COM, baudrate (9600 / 19200), address/slave, dan parity ESM
 * bisa diatur dari web (panel "Koneksi Perangkat") + tombol "Auto-deteksi"
 * yang mencocokkan tiap port COM ke perangkatnya. Pengaturan disimpan di
 * local-config.json (satu folder dengan local.js), jadi tidak perlu ubah
 * program atau argumen lagi.
 *
 * BARU: notifikasi Telegram. Pesan hanya dikirim saat kondisi menyimpang dari
 * threshold (warning / kritis), saat pulih, dan sebagai pengingat berkala
 * selama masalah belum selesai. Bukan real-time. Kirim /status ke bot untuk
 * melihat kondisi terakhir. Threshold diatur di api.js (bagian RULES).
 *
 * Prioritas konfigurasi:  default  <  local-config.json  <  argumen CLI
 * (argumen CLI yang diberikan saat start selalu menang atas file).
 *
 * Jalankan:
 *   node local.js
 *   node local.js --http 8080 --host 0.0.0.0     (akses dari perangkat lain di LAN)
 *   node local.js --key rahasia123               (wajib key untuk ubah setting dari web)
 *   node local.js --readonly                     (matikan SEMUA fitur ubah dari web)
 *   node local.js --smu-alarm                    (ikut baca raw alarm SMU)
 *   node local.js --no-notify                    (matikan notifikasi Telegram)
 * Opsional (menimpa file config): --jpf COM6 --esm COM5 --smu COM3
 *   --esm-parity even --esm-slave 0xD7 --smu-adr 1 --no-jpf --no-esm --no-smu
 *
 * Lalu buka:  http://localhost:3000
 *
 * Tiap perangkat punya port + loop polling sendiri, jadi kalau satu
 * perangkat mati / kabel lepas, yang lain tetap jalan. Port yang gagal
 * dibuka akan dicoba lagi otomatis.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
let SerialPort;
try { ({ SerialPort } = require('serialport')); } catch (e) {
  console.error('Modul "serialport" belum terpasang. Jalankan:  npm install serialport');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ================================================================== */
/*  KONFIGURASI                                                        */
/* ================================================================== */
const IS_WIN = process.platform === 'win32';
const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : d;
};
const has = (n) => args.includes(`--${n}`);

const BAUDS = [9600, 19200];
const PARITIES = ['none', 'even', 'odd'];
const PATH_RE = /^(COM\d{1,3}|\/dev\/(tty|cu)[\w.\-]+)$/i;
const CONFIG_FILE = path.join(__dirname, 'local-config.json');

// Field yang boleh diubah dari GUI dan disimpan ke file
const PERSIST = {
  jpf: ['enabled', 'path', 'baud', 'slave'],
  esm: ['enabled', 'path', 'baud', 'parity', 'slave'],
  smu: ['enabled', 'path', 'baud', 'adr'],
};

const CFG = {
  http: { port: parseInt(opt('http', '3000'), 10), host: opt('host', '0.0.0.0') },
  jpf: {
    enabled: true,
    path: IS_WIN ? 'COM6' : '/dev/ttyACM2',
    baud: 9600, slave: 1, interval: 2000,
  },
  esm: {
    enabled: true,
    path: IS_WIN ? 'COM5' : '/dev/ttyACM1',
    baud: 9600, parity: 'none',
    slave: 0xd6, interval: 5000,
  },
  smu: {
    enabled: true,
    path: IS_WIN ? 'COM3' : '/dev/ttyACM3',
    baud: 19200, adr: 1,
    ver: parseInt(opt('smu-ver', '21'), 16),
    timeout: 500, interval: 2000, alarm: has('smu-alarm'),
  },
  // Fitur ubah setting dari web. --readonly untuk mematikan,
  // --key <rahasia> untuk mewajibkan key saat menulis.
  write: { enabled: !has('readonly'), key: opt('key', '') },
};

const intIn = (v, name, min, max) => {
  const n = typeof v === 'string' ? Number(v.trim()) : Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} harus bilangan bulat ${min}-${max}`);
  return n;
};

/** Validasi + normalisasi satu perangkat dari GUI / file config. p.addr = slave (JPF/ESM) atau ADR (SMU). */
function normalizeDevice(key, p) {
  const label = key.toUpperCase();
  const out = { enabled: !!p.enabled };
  const pth = String(p.path ?? '').trim() || CFG[key].path;
  if (!PATH_RE.test(pth)) throw new Error(`${label}: nama port "${pth}" tidak valid (contoh COM3 atau /dev/ttyACM0)`);
  out.path = pth;
  const baud = Number(p.baud);
  if (!BAUDS.includes(baud)) throw new Error(`${label}: baudrate harus ${BAUDS.join(' atau ')}`);
  out.baud = baud;
  if (key === 'smu') out.adr = intIn(p.addr, `${label}: ADR`, 1, 254);
  else out.slave = intIn(p.addr, `${label}: address`, 1, 247);
  if (key === 'esm') {
    const par = String(p.parity ?? CFG.esm.parity);
    if (!PARITIES.includes(par)) throw new Error(`${label}: parity harus ${PARITIES.join('/')}`);
    out.parity = par;
  }
  return out;
}

function pickPersist(key) {
  const o = {};
  for (const f of PERSIST[key]) o[f] = CFG[key][f];
  return o;
}
const publicConfig = () => ({ jpf: pickPersist('jpf'), esm: pickPersist('esm'), smu: pickPersist('smu') });

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(publicConfig(), null, 2));
  } catch (e) {
    console.error(`Gagal menyimpan ${CONFIG_FILE}: ${e.message}`);
  }
}

// 1) file config
(function loadSaved() {
  let saved;
  try { saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) { return; }
  for (const key of Object.keys(PERSIST)) {
    const s = saved && saved[key];
    if (!s) continue;
    try {
      Object.assign(CFG[key], normalizeDevice(key, { ...s, addr: key === 'smu' ? s.adr : s.slave }));
    } catch (e) {
      console.error(`[config] ${key} di ${path.basename(CONFIG_FILE)} diabaikan: ${e.message}`);
    }
  }
})();

// 2) argumen CLI menimpa file
(function applyCli() {
  const o = (n) => opt(n, undefined);
  if (o('jpf')) CFG.jpf.path = o('jpf');
  if (o('esm')) CFG.esm.path = o('esm');
  if (o('smu')) CFG.smu.path = o('smu');
  if (o('esm-parity')) CFG.esm.parity = o('esm-parity');
  if (o('esm-slave')) CFG.esm.slave = Number(o('esm-slave'));
  if (o('smu-adr')) CFG.smu.adr = parseInt(o('smu-adr'), 10);
  if (has('no-jpf')) CFG.jpf.enabled = false;
  if (has('no-esm')) CFG.esm.enabled = false;
  if (has('no-smu')) CFG.smu.enabled = false;
})();

/* ================================================================== */
/*  STATE BERSAMA (dibaca oleh web server)                             */
/* ================================================================== */
const state = {};
function initState(key, name, cfg) {
  state[key] = { name, port: cfg.path, interval: cfg.interval, online: false, updated: null, error: null, data: null };
}

/* ================================================================== */
/*  SERIAL HELPER + RUNNER                                             */
/* ================================================================== */
function openSerial(opts) {
  return new Promise((resolve, reject) => {
    const p = new SerialPort({ ...opts, autoOpen: false });
    p.on('error', () => {}); // error ditangani lewat callback / loop polling
    p.open((err) => (err ? reject(err) : resolve(p)));
  });
}

const isLockError = (e) => /cannot lock|temporarily unavailable|resource busy/i.test((e && e.message) || '');

/** openSerial dengan coba-ulang singkat kalau port masih terkunci (lock belum dilepas OS). */
async function openSerialRetry(opts, tries = 6, gap = 500) {
  for (let i = 0; ; i++) {
    try {
      return await openSerial(opts);
    } catch (e) {
      if (i >= tries - 1 || !isLockError(e)) throw e;
      await sleep(gap);
    }
  }
}

function closeSerial(p) {
  return new Promise((res) => {
    if (!p) return res();
    p.removeAllListeners('data');
    if (!p.isOpen) return setTimeout(res, 150);
    p.close(() => setTimeout(res, 300)); // beri waktu OS melepas lock sebelum port dibuka lagi
  });
}

/** Tidur yang bisa dipotong kalau runner dihentikan. */
async function nap(ms, r) {
  const end = Date.now() + ms;
  while (!r.stopped && Date.now() < end) await sleep(Math.min(100, end - Date.now()));
}

/** Loop untuk satu perangkat: buka port -> poll -> tidur. Berhenti kalau r.stopped = true. */
async function runDevice(key, cfg, serialOf, r) {
  const st = state[key];
  const dev = r.dev;
  let wasOnline = null;
  while (!r.stopped) {
    try {
      if (dev.open) {
        // perangkat yang mengelola koneksinya sendiri (JPF4828 lewat jpfreader.js)
        if (!dev.isOpen()) {
          await dev.open();
          console.log(`[${key}] port ${cfg.path} terbuka`);
        }
      } else if (!r.port || !r.port.isOpen) {
        // serialOf(r.cfg): baud terbaru dipakai kalau port perlu dibuka ulang
        r.port = await openSerialRetry({ path: cfg.path, ...serialOf(r.cfg) });
        dev.attach(r.port);
        console.log(`[${key}] port ${cfg.path} terbuka @ ${r.cfg.baud}`);
      }
      const data = await dev.poll();
      if (r.stopped) break;
      st.online = true;
      st.data = data;
      st.updated = Date.now();
      st.error = null;
    } catch (e) {
      if (r.stopped) break;
      st.online = false;
      st.error = e.message;
      if (isLockError(e)) {
        st.error += ` — port masih dipegang handle lain. Cek pemegangnya: lsof ${cfg.path}  (PID local.js ini: ${process.pid})`;
      }
      if (r.port && !r.port.isOpen) r.port = null;
    }
    if (wasOnline !== st.online) {
      console.log(`[${key}] ${st.online ? 'ONLINE' : 'OFFLINE — ' + st.error}`);
      wasOnline = st.online;
    }
    await nap(cfg.interval, r);
  }
}

/* ================================================================== */
/*  MODBUS RTU                                                        */
/* ================================================================== */
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
  b.writeUInt16LE(crc16(b.subarray(0, 6)), 6);
  return b;
}

/** Cari frame respons valid di buffer (tahan echo TX & byte sampah). */
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
  constructor(port, { timeout = 1500 } = {}) {
    this.port = port;
    this.timeout = timeout;
    this.buf = Buffer.alloc(0);
    this.waiter = null;
    this.lastEnd = 0;
    this._chain = Promise.resolve(); // antrean: 1 transaksi pada satu waktu
    port.on('data', (d) => {
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

  /** Jalankan fn setelah transaksi sebelumnya selesai (baca & tulis tidak boleh tabrakan). */
  _exclusive(fn) {
    const run = this._chain.then(fn);
    this._chain = run.catch(() => {});
    return run;
  }

  readRegisters(slave, addr, count, timeout = this.timeout) {
    return this._exclusive(() => this._readRegisters(slave, addr, count, timeout));
  }

  async _readRegisters(slave, addr, count, timeout) {
    const gap = 20 - (Date.now() - this.lastEnd);
    if (gap > 0) await sleep(gap);

    this.buf = Buffer.alloc(0);
    await this._write(buildReadRequest(slave, addr, count));

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
        this.buf = Buffer.alloc(0);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        this.lastEnd = Date.now();
        throw new ModbusError(
          `Timeout baca 0x${addr.toString(16)} x${count} dari slave 0x${slave.toString(16)}` +
          (this.buf.length ? ` (${this.buf.length} byte tak valid)` : ' (tidak ada respons)'), 'TIMEOUT');
      }
      await this._wait(remaining);
    }
  }

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

/* ================================================================== */
/*  PERANGKAT 1: JPF4828                                               */
/* ================================================================== */
function makeJpf(cfg) {
  const { createJpf } = require('./jpf4828/jpfreader.js'); // logika JPF ada di jpfreader.js
  const jpf = createJpf({ port: cfg.path, baudRate: cfg.baud, slaveId: cfg.slave });
  const KEYMAP = { l: 'startTemp', h: 'fullTemp', mode: 'workingMode' }; // nama field web -> nama register
  return {
    async open() {
      for (let i = 0; ; i++) {
        try { return await jpf.connect(); } catch (e) {
          if (i >= 5 || !isLockError(e)) throw e;
          await sleep(500);
        }
      }
    },
    isOpen: () => jpf.isOpen(),

    /** Lepas port saat konfigurasi diganti. Butuh jpf.close() atau jpf.disconnect() di jpfreader.js */
    async close() {
      const fn = jpf.close || jpf.disconnect;
      if (!fn) {
        console.warn('[jpf] PERINGATAN: jpfreader.js tidak punya close()/disconnect() — port lama TIDAK dilepas, ' +
          'ganti port/baud JPF akan gagal "Cannot lock port". Restart local.js, atau tambahkan close() di jpfreader.js.');
        return;
      }
      await fn.call(jpf);
      await sleep(300); // beri waktu OS melepas lock
    },

    async poll() {
      const v = await jpf.readAll();
      return {
        tm1: v.tm1Temp, tm2: v.tm2Temp,
        fanSpeed: v.fanSpeed,
        startTemp: v.startTemp, fullTemp: v.fullTemp,
        mode: v.workingMode, numFans: v.numFans, modbusAddr: v.modbusAddr,
        pwmFreq: v.pwmFreq,
        relayOpenT: v.relayOpenT, relayCloseT: v.relayCloseT, relayState: v.relayState,
        fans: v.fans,
      };
    },

    /** Ubah parameter: validasi, tulis, dan baca-ulang dikerjakan jpfreader.js */
    async setParams(req) {
      const mapped = {};
      for (const [k, v] of Object.entries(req)) mapped[KEYMAP[k] || k] = v;
      return jpf.setParams(mapped);
    },
  };
}

/* ================================================================== */
/*  PERANGKAT 2: Huawei ESM-48100B1                                    */
/* ================================================================== */
const u16 = (v) => (v === 0xffff ? null : v);
const s16 = (v) => (v === 0x8000 ? null : v & 0x8000 ? v - 0x10000 : v);
const u32 = (hi, lo) => { const x = ((hi << 16) | lo) >>> 0; return x === 0xffffffff ? null : x; };
const mul = (v, k) => (v === null ? null : Math.round(v * k * 1000) / 1000);

const ESM_STATES = ['Charge', 'Discharge'];
const ESM_ALARM_WORDS = [
  [0x0046, 'Fatal-1'],
  [0x0047, 'Fatal-2 (fault sel)'],
  [0x0048, 'Serius (proteksi)'],
  [0x0049, 'Umum (warning)'],
  [0x004a, 'Modul (alarm/status)'],
];

function makeEsm(cfg) {
  let mb = null;
  const cache = {};
  return {
    attach(port) { mb = new ModbusRtu(port, { timeout: 1500 }); },
    async poll() {
      const slave = cfg.slave;
      const rd = (a, c) => mb.read(slave, a, c);

      const b = await rd(0x0000, 7);
      const state = (await rd(0x000a, 1))[0];
      const dTimes = await rd(0x0042, 2);
      const dAh = await rd(0x0044, 2);
      const alarms = await rd(0x0046, 5);

      if (cache.cellCount === undefined) {
        cache.swVersion = (await rd(0x0101, 1))[0];
        const n0 = (await rd(0x010f, 1))[0];
        cache.cellCount = n0 >= 1 && n0 <= 24 ? n0 : 15; // ESM-48100B1 = 15 sel
      }
      const n = cache.cellCount;
      const n1 = Math.min(n, 16);
      let temps = await rd(0x0012, n1);
      let volts = await rd(0x0022, n1);
      if (n > 16) {
        temps = temps.concat(await rd(0x0300, n - 16));
        volts = volts.concat(await rd(0x0310, n - 16));
      }

      const packV = mul(u16(b[1]), 0.01);
      const cur = mul(s16(b[2]), 0.01);
      return {
        slave,
        busV: mul(u16(b[0]), 0.01),
        packV,
        current: cur,
        power: packV !== null && cur !== null ? Math.round(packV * cur * 10) / 10 : null,
        soc: u16(b[3]), soh: u16(b[4]),
        tMax: s16(b[5]), tMin: s16(b[6]),
        state,
        stateName: ESM_STATES[state] ?? 'Unknown',
        dischargeTimes: u32(dTimes[0], dTimes[1]),
        dischargeAh: u32(dAh[0], dAh[1]),
        swVersion: cache.swVersion,
        cellCount: n,
        cellTemps: temps.map(s16),
        cellVolts: volts.map((v) => (u16(v) === null || v === 999 ? null : v / 1000)),
        alarms: alarms.map((w, i) => {
          const bits = [];
          for (let k = 0; k < 16; k++) if (w & (1 << k)) bits.push(k);
          return { reg: ESM_ALARM_WORDS[i][0], name: ESM_ALARM_WORDS[i][1], value: w, bits };
        }),
      };
    },
  };
}

/* ================================================================== */
/*  PERANGKAT 3: Huawei SMU01C (protokol YDN)                          */
/* ================================================================== */
const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, '0');
const hex4 = (n) => n.toString(16).toUpperCase().padStart(4, '0');

function ydnLengthField(lenid) {
  const sum = ((lenid >> 8) & 0xf) + ((lenid >> 4) & 0xf) + (lenid & 0xf);
  const lchk = (~(sum % 16) + 1) & 0xf;
  return hex4((lchk << 12) | lenid);
}
function ydnChecksum(body) {
  let s = 0;
  for (const ch of body) s += ch.charCodeAt(0);
  return hex4((~s + 1) & 0xffff);
}
function ydnFrame(ver, adr, cid1, cid2, info = '') {
  const body = hex2(ver) + hex2(adr) + hex2(cid1) + hex2(cid2) + ydnLengthField(info.length) + info;
  return `~${body}${ydnChecksum(body)}\r`;
}
function ydnParse(r) {
  const s = r.endsWith('\r') ? r.slice(0, -1) : r;
  if (s[0] !== '~' || s.length < 17) return null;
  if (ydnChecksum(s.slice(1, -4)) !== s.slice(-4)) return null;
  if (s.slice(7, 9) !== '00') return null;
  return s.slice(13, -4);
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
  return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null;
}
const binString = (bytes) => (bytes ? bytes.map((b) => (b === null ? '????????' : b.toString(2).padStart(8, '0'))).join(' ') : null);

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

function makeSmu(cfg) {
  let port = null;
  let rx = '';
  let config = null;
  let configTries = 0;

  const buildFrame = (cid1, cid2, info = '') => ydnFrame(cfg.ver, cfg.adr, cid1, cid2, info);

  async function query(frame) {
    rx = '';
    await new Promise((res, rej) => port.write(frame, 'latin1', (e) => (e ? rej(e) : res())));
    await new Promise((res) => port.drain(res));
    const start = Date.now();
    while (Date.now() - start < cfg.timeout) {
      const r = rx.startsWith(frame) ? rx.slice(frame.length) : rx;
      if (r.includes('\r')) return r;
      await sleep(10);
    }
    return rx.startsWith(frame) ? rx.slice(frame.length) : rx;
  }

  async function getBytes(cid1, cid2, info) {
    const data = ydnParse(await query(buildFrame(cid1, cid2, info)));
    return data === null ? null : toBytes(data);
  }

  async function readConfig() {
    const ac = await getBytes(0x40, 0x46, '01');
    const dc = await getBytes(0x42, 0x46, '01');
    return {
      ac_upper_v: f32(ac, 0), ac_lower_v: f32(ac, 4),
      dc_overvolt: f32(dc, 0), dc_undervolt: f32(dc, 4),
      batt_float_v: f32(dc, 69), batt_equalize_v: f32(dc, 73),
      batt_capacity_pct: f32(dc, 129),
    };
  }

  return {
    attach(p) {
      port = p;
      rx = '';
      port.on('data', (d) => (rx += d.toString('latin1')));
    },
    async poll() {
      const ac = await getBytes(0x40, 0x41, '01');
      const dc = await getBytes(0x42, 0x41, '01');
      const rc = await getBytes(0x41, 0x41, '');

      const psu = parsePsu(rc);
      const d = {
        ac_v: f32(ac, 2),
        freq_hz: f32(ac, 14),
        dc_v: f32(dc, 1),
        load_a: f32(dc, 5),
        psu: psu,
        unk_100: f32(dc, 76),
      };
      if (d.ac_v === null && d.dc_v === null) throw new Error('Tidak ada respons dari SMU (cek port, baud, ADR)');

      // Config/threshold: statis, cukup dibaca sekali (maks 3 percobaan)
      if (!config && configTries < 3) {
        configTries++;
        try {
          const c = await readConfig();
          if (Object.values(c).some((v) => v !== null)) config = c;
        } catch (e) { /* abaikan */ }
      }
      d.config = config;

      if (cfg.alarm) {
        d.alarms = [];
        for (const t of [{ n: 'ac', c1: 0x40 }, { n: 'rc', c1: 0x41 }, { n: 'dc', c1: 0x42 }]) {
          d.alarms.push({ name: t.n, bin: binString(await getBytes(t.c1, 0x44, '01')) });
        }
      }
      return d;
    },
  };
}

/* ================================================================== */
/*  MANAJER PERANGKAT (start / stop / restart saat config berubah)     */
/* ================================================================== */
const DEVICES = {
  jpf: {
    title: 'JPF4828 — Fan Controller', make: makeJpf,
    serial: (c) => ({ baudRate: c.baud, dataBits: 8, stopBits: 1, parity: 'none' }),
  },
  esm: {
    title: 'Huawei ESM-48100B1 — Baterai', make: makeEsm,
    serial: (c) => ({ baudRate: c.baud, dataBits: 8, stopBits: 1, parity: c.parity }),
  },
  smu: {
    title: 'Huawei SMU01C — Power System', make: makeSmu,
    serial: (c) => ({ baudRate: c.baud, dataBits: 8, stopBits: 1, parity: 'none' }),
  },
};

const runners = {};
let jpfDev = null;
let busy = false; // true selama config sedang diterapkan

function startDevice(key) {
  delete state[key];
  if (key === 'jpf') jpfDev = null;
  const live = CFG[key];
  if (!live.enabled) return;
  const cfg = { ...live }; // snapshot: perubahan config berikutnya tidak menyentuh loop yang sedang jalan
  const def = DEVICES[key];
  initState(key, def.title, cfg);
  let dev;
  try {
    dev = def.make(cfg);
  } catch (e) {
    state[key].error = `Gagal memuat perangkat: ${e.message}`;
    console.error(`[${key}] ${state[key].error}`);
    return;
  }
  if (key === 'jpf') jpfDev = dev;
  const r = { stopped: false, dev, port: null, done: null, cfg };
  r.done = runDevice(key, cfg, def.serial, r);
  runners[key] = r;
}

async function stopDevice(key) {
  const r = runners[key];
  if (!r) return;
  r.stopped = true;
  await r.done.catch(() => {});
  try { if (r.dev.close) await r.dev.close(); } catch (e) { /* abaikan */ }
  if (r.port) await closeSerial(r.port);
  delete runners[key];
  if (state[key]) state[key].online = false;
}

/**
 * Terapkan perubahan baud / address ESM & SMU TANPA menutup port (tidak menyentuh lock).
 * Return true kalau berhasil; false -> pemanggil harus restart perangkat (stop + start).
 * Tidak berlaku untuk JPF, ganti port, ganti parity, atau enable/disable.
 */
async function hotApply(key, before, after) {
  const r = runners[key];
  if (!r || key === 'jpf' || !before.enabled || !after.enabled) return false;
  if (before.path !== after.path || before.parity !== after.parity) return false;
  try {
    if (before.baud !== after.baud && r.port && r.port.isOpen) {
      await new Promise((res, rej) => r.port.update({ baudRate: after.baud }, (e) => (e ? rej(e) : res())));
    }
    r.cfg.baud = after.baud;
    if (key === 'esm') r.cfg.slave = after.slave;
    if (key === 'smu') r.cfg.adr = after.adr;
    console.log(`[${key}] config diterapkan tanpa buka ulang port (baud ${after.baud})`);
    return true;
  } catch (e) {
    console.error(`[${key}] hot-apply gagal (${e.message}), restart perangkat`);
    return false;
  }
}

/* ================================================================== */
/*  DAFTAR PORT + AUTO-DETEKSI (PAIRING)                               */
/* ================================================================== */
async function listPorts() {
  const list = await SerialPort.list();
  return list
    .filter((p) => PATH_RE.test(p.path))
    .map((p) => ({
      path: p.path,
      manufacturer: p.manufacturer || '',
      serialNumber: p.serialNumber || '',
      vendorId: p.vendorId || '',
      productId: p.productId || '',
    }))
    .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
}

const uniq = (arr) => arr.filter((v, i) => arr.indexOf(v) === i);
const PROBE_TIMEOUT = 400;

/** Kirim 1 query YDN; true kalau ada balasan valid. */
async function probeYdn(port, baud) {
  let rx = '';
  port.on('data', (d) => (rx += d.toString('latin1')));
  for (const adr of uniq([CFG.smu.adr, 1])) {
    const frame = ydnFrame(CFG.smu.ver, adr, 0x40, 0x41, '01');
    rx = '';
    await new Promise((res, rej) => port.write(frame, 'latin1', (e) => (e ? rej(e) : res())));
    await new Promise((res) => port.drain(res));
    const start = Date.now();
    let reply = '';
    while (Date.now() - start < PROBE_TIMEOUT) {
      reply = rx.startsWith(frame) ? rx.slice(frame.length) : rx;
      if (reply.includes('\r')) break;
      await sleep(10);
    }
    if (reply.includes('\r') && ydnParse(reply) !== null) return { type: 'smu', baud, parity: 'none', addr: adr };
  }
  return null;
}

/** Baca register 0 dari beberapa kandidat slave. Exception Modbus juga dianggap "ada perangkat". */
async function probeModbus(port, baud, parity) {
  const mb = new ModbusRtu(port, { timeout: PROBE_TIMEOUT });
  const seen = {};
  const cands = [[CFG.esm.slave, 'esm'], [0xd6, 'esm'], [CFG.jpf.slave, 'jpf'], [1, 'jpf']]
    .filter(([s]) => (seen[s] ? false : (seen[s] = true)));
  for (const [slave, type] of cands) {
    try {
      await mb.readRegisters(slave, 0x0000, type === 'esm' ? 7 : 1, PROBE_TIMEOUT);
      return { type, baud, parity, addr: slave };
    } catch (e) {
      if (e.code === 'EXCEPTION') return { type, baud, parity, addr: slave };
    }
  }
  return null;
}

async function probePort(pth, onStep) {
  const steps = [{ kind: 'ydn', baud: 19200 }];
  for (const baud of BAUDS) for (const parity of ['none', 'even']) steps.push({ kind: 'mb', baud, parity });
  steps.push({ kind: 'ydn', baud: 9600 });
  for (const s of steps) {
    onStep(`${pth} @${s.baud}${s.kind === 'mb' ? ' ' + s.parity : ''}`);
    let port;
    try {
      port = await openSerial({ path: pth, baudRate: s.baud, dataBits: 8, stopBits: 1, parity: s.parity || 'none' });
    } catch (e) {
      return { path: pth, found: null, error: e.message };
    }
    try {
      const hit = s.kind === 'ydn' ? await probeYdn(port, s.baud) : await probeModbus(port, s.baud, s.parity);
      if (hit) return { path: pth, found: hit };
    } catch (e) { /* lanjut kombinasi berikutnya */ } finally {
      await closeSerial(port);
    }
    await sleep(50);
  }
  return { path: pth, found: null };
}

const scan = { running: false, current: '', done: 0, total: 0, results: [], error: null, startedAt: null, finishedAt: null };

async function runScan() {
  Object.assign(scan, { running: true, current: 'menyiapkan', done: 0, total: 0, results: [], error: null, startedAt: Date.now(), finishedAt: null });
  try {
    const ports = (await listPorts()).map((p) => p.path);
    scan.total = ports.length;
    for (const key of Object.keys(DEVICES)) await stopDevice(key); // lepas semua port dulu
    for (const p of ports) {
      scan.results.push(await probePort(p, (t) => { scan.current = t; }));
      scan.done++;
    }
  } catch (e) {
    scan.error = e.message;
  } finally {
    for (const key of Object.keys(DEVICES)) startDevice(key); // kembali pakai config lama; user yang memutuskan menyimpan hasil scan
    scan.running = false;
    scan.finishedAt = Date.now();
  }
}

/* ================================================================== */
/*  WEB SERVER                                                         */
/* ================================================================== */
const HTML = String.raw`<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Monitoring Lokal</title>
<style>
:root{--bg:#0f1419;--card:#1a212b;--line:#2a3441;--txt:#e6edf3;--mut:#8b98a5;--ok:#3fb950;--warn:#d29922;--bad:#f85149;--acc:#58a6ff}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--txt);font:14px/1.4 system-ui,Segoe UI,Roboto,sans-serif}
header{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;padding:14px 20px;border-bottom:1px solid var(--line)}
h1{font-size:18px;margin:0}
#conn{color:var(--mut);font-size:12px}
main{padding:16px 20px;display:grid;gap:16px;max-width:1300px;margin:0 auto}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.sh{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:10px}
.sh h2{font-size:15px;margin:0}
.meta{color:var(--mut);font-size:12px}
.badge{font-size:11px;font-weight:600;padding:2px 8px;border-radius:99px;border:1px solid}
.badge.ok{color:var(--ok);border-color:var(--ok)}
.badge.warn{color:var(--warn);border-color:var(--warn)}
.badge.bad{color:var(--bad);border-color:var(--bad)}
.err{background:#3a1d1d;color:#ffb4ae;border-radius:6px;padding:6px 10px;margin-bottom:10px;font-size:12px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}
.tile{background:#121820;border:1px solid var(--line);border-radius:8px;padding:8px 10px}
.tile .l{color:var(--mut);font-size:11px}
.tile .v{font-size:20px;font-weight:600;margin-top:2px}
.v.ok{color:var(--ok)}.v.warn{color:var(--warn)}.v.bad{color:var(--bad)}.v.acc{color:var(--acc)}
.dim{opacity:.55}
table{border-collapse:collapse;width:100%;margin-top:12px;font-size:13px}
th,td{text-align:left;padding:4px 8px;border-bottom:1px solid var(--line)}
th{color:var(--mut);font-weight:500;font-size:12px}
h3{margin:14px 0 0;font-size:12px;color:var(--mut);font-weight:600;text-transform:uppercase;letter-spacing:.04em}
code{font-family:ui-monospace,Consolas,monospace;font-size:12px}
.note{color:var(--mut);font-size:11px;margin-top:8px}
[hidden]{display:none !important}
.frm{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end}
.frm label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--mut)}
input,select{background:#121820;border:1px solid var(--line);border-radius:6px;color:var(--txt);padding:6px 8px;font:inherit;width:170px}
input[type=checkbox]{width:auto}
.cfgt input,.cfgt select{width:150px}
.cfgt input.addr{width:90px}
button{background:var(--acc);color:#0b1220;border:0;border-radius:6px;padding:7px 16px;font-weight:600;cursor:pointer}
button:disabled{opacity:.5;cursor:default}
button.sec{background:transparent;color:var(--txt);border:1px solid var(--line)}
.msg-ok{color:var(--ok)}.msg-bad{color:var(--bad)}
</style>
</head>
<body>
<header><h1>Monitoring Lokal</h1><div id="conn">memuat...</div></header>
<main id="app"></main>
<main style="padding-top:0">
<section id="conncfg" hidden>
  <div class="sh"><h2>Koneksi Perangkat</h2><span class="meta">pilih port COM, baudrate &amp; address — disimpan di local-config.json</span></div>
  <datalist id="portlist"></datalist>
  <table class="cfgt" style="margin-top:0">
    <tr><th>Aktif</th><th>Perangkat</th><th>Port</th><th>Baudrate</th><th>Address / ADR</th><th>Parity</th></tr>
    <tr>
      <td><input type="checkbox" id="cf_jpf_en"></td><td>JPF4828 (fan)</td>
      <td><input id="cf_jpf_path" list="portlist" autocomplete="off"></td>
      <td><select id="cf_jpf_baud"><option value="9600">9600</option><option value="19200">19200</option></select></td>
      <td><input id="cf_jpf_addr" class="addr" title="Modbus slave 1-247"></td>
      <td class="meta">none</td>
    </tr>
    <tr>
      <td><input type="checkbox" id="cf_esm_en"></td><td>ESM-48100B1 (baterai)</td>
      <td><input id="cf_esm_path" list="portlist" autocomplete="off"></td>
      <td><select id="cf_esm_baud"><option value="9600">9600</option><option value="19200">19200</option></select></td>
      <td><input id="cf_esm_addr" class="addr" title="Modbus slave, desimal atau 0x.."></td>
      <td><select id="cf_esm_par"><option value="none">none</option><option value="even">even</option><option value="odd">odd</option></select></td>
    </tr>
    <tr>
      <td><input type="checkbox" id="cf_smu_en"></td><td>SMU01C (power system)</td>
      <td><input id="cf_smu_path" list="portlist" autocomplete="off"></td>
      <td><select id="cf_smu_baud"><option value="9600">9600</option><option value="19200">19200</option></select></td>
      <td><input id="cf_smu_addr" class="addr" title="YDN ADR 1-254"></td>
      <td class="meta">none</td>
    </tr>
  </table>
  <div class="frm" style="margin-top:12px">
    <button id="btn_save">Simpan &amp; terapkan</button>
    <button id="btn_scan" class="sec">Auto-deteksi (pairing)</button>
    <button id="btn_ports" class="sec">Refresh daftar port</button>
    <label id="cf_keylbl" hidden>Key<input id="cf_key" type="password" autocomplete="off"></label>
  </div>
  <div id="portinfo" class="note"></div>
  <div id="cfgmsg2" class="note"></div>
  <div id="scanmsg" class="note"></div>
  <div id="scanres"></div>
  <div class="note">Address ESM boleh ditulis desimal (214) atau hex (0xD6). Auto-deteksi menghentikan sementara semua pembacaan, mencoba tiap port pada 9600/19200, lalu mengisi form — periksa hasilnya, lalu klik "Simpan &amp; terapkan". Perangkat yang tidak berubah tidak di-restart.</div>
</section>
<section id="jpfcfg" hidden>
  <div class="sh"><h2>Pengaturan Fan (JPF4828)</h2><span class="meta">tulis ke alat via Modbus — kosongkan kolom yang tidak ingin diubah</span></div>
  <div class="frm">
    <label>L — start temp (°C)<input id="in_l" type="number" step="1" min="-20" max="120"></label>
    <label>H — full speed temp (°C)<input id="in_h" type="number" step="1" min="-20" max="120"></label>
    <label>Mode kerja (P)<select id="in_mode"><option value="">(tidak diubah)</option><option value="1">1 — Min speed</option><option value="0">0 — Shutdown</option></select></label>
    <label>Jumlah fan (F, 0-8)<input id="in_numFans" type="number" step="1" min="0" max="8"></label>
    <label>PWM frequency<select id="in_pwmFreq"><option value="">(tidak diubah)</option><option value="0">0 — 500 Hz</option><option value="1">1</option><option value="2">2</option><option value="3">3</option><option value="4">4</option><option value="5">5 — 25 kHz</option></select></label>
    <label>Suhu buka relay (b, °C)<input id="in_relayOpenT" type="number" step="1" min="-20" max="120"></label>
    <label>Suhu tutup relay (C, °C)<input id="in_relayCloseT" type="number" step="1" min="-20" max="120"></label>
    <label>Paksa speed fan (%)<input id="in_fanSpeed" type="number" step="1" min="0" max="100"></label>
    <label id="keylbl" hidden>Key<input id="in_key" type="password" autocomplete="off"></label>
  </div>
  <div class="frm" style="margin-top:12px">
    <button id="btn_apply">Terapkan</button>
    <button id="btn_auto" class="sec">Speed fan kembali otomatis</button>
  </div>
  <div id="cfgmsg" class="note"></div>
  <div class="note">Suhu: bilangan bulat -20 s/d 120 °C, H harus lebih besar dari L. Speed fan paksa 0-100 %; tombol "kembali otomatis" mengembalikan kontrol ke suhu. Nilai selalu dibaca ulang dari alat setelah ditulis.</div>
</section>
</main>
<script>
var $ = function (id) { return document.getElementById(id); };
function esc(s) {
  return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
}
function f(v, d, u) {
  if (v === null || v === undefined || isNaN(v)) return '--';
  return Number(v).toFixed(d) + (u ? ' ' + u : '');
}
function tile(l, v, cls) {
  return '<div class="tile"><div class="l">' + l + '</div><div class="v ' + (cls || '') + '">' + v + '</div></div>';
}

function head(dev, now) {
  var age = dev.updated ? Math.round((now - dev.updated) / 1000) : null;
  var stale = age !== null && age > (dev.interval / 1000) * 3 + 3;
  var good = dev.online && !stale;
  var cls = good ? 'ok' : (dev.data ? 'warn' : 'bad');
  var txt = good ? 'ONLINE' : (dev.data ? 'DATA LAMA' : 'OFFLINE');
  var h = '<div class="sh"><h2>' + esc(dev.name) + '</h2><span class="badge ' + cls + '">' + txt + '</span>' +
    '<span class="meta">' + esc(dev.port) + (age !== null ? ' · update ' + age + ' dtk lalu' : '') + '</span></div>';
  if (dev.error) h += '<div class="err">' + esc(dev.error) + '</div>';
  return { html: h, dim: !good && dev.data };
}

function renderJpf(d) {
  var h = '<div class="grid">' +
    tile('Suhu TM1', f(d.tm1, 0, '°C'), 'acc') +
    tile('Suhu TM2', f(d.tm2, 0, '°C'), 'acc') +
    tile('Speed Fan', f(d.fanSpeed, 0, '%')) +
    tile('Mode kerja (P)', d.mode === 1 ? 'Min speed' : (d.mode === 0 ? 'Shutdown' : d.mode)) +
    tile('Start temp (L)', f(d.startTemp, 0, '°C')) +
    tile('Full speed temp (H)', f(d.fullTemp, 0, '°C')) +
    tile('Jumlah fan (F)', d.numFans) +
    tile('Relay buka / tutup', f(d.relayOpenT, 0) + ' / ' + f(d.relayCloseT, 0) + ' °C') +
    tile('State relay', d.relayState) +
    tile('PWM freq (kode)', d.pwmFreq) +
    tile('Alamat Modbus', d.modbusAddr) +
    '</div>';
  if (d.fans.length) {
    h += '<table><tr><th>Fan</th><th>RPM</th><th>Status</th><th>Fault</th></tr>';
    d.fans.forEach(function (x) {
      h += '<tr><td>' + x.n + '</td><td>' + x.rpm + '</td><td>' +
        (x.running ? '<span style="color:var(--ok)">Jalan</span>' : 'Berhenti') + '</td><td>' +
        (x.ok ? '<span style="color:var(--ok)">Normal</span>' : '<span style="color:var(--bad)">FAULT</span>') + '</td></tr>';
    });
    h += '</table>';
  }
  return h;
}

function renderEsm(d) {
  var vs = d.cellVolts.filter(function (v) { return v !== null; });
  var vmax = vs.length ? Math.max.apply(null, vs) : null;
  var vmin = vs.length ? Math.min.apply(null, vs) : null;
  var delta = vs.length ? (vmax - vmin) * 1000 : null;
  var sum = vs.length ? vs.reduce(function (a, b) { return a + b; }, 0) : null;
  var socCls = d.soc === null ? '' : (d.soc < 20 ? 'bad' : (d.soc < 50 ? 'warn' : 'ok'));
  var h = '<div class="grid">' +
    tile('Tegangan busbar', f(d.busV, 2, 'V')) +
    tile('Tegangan pack', f(d.packV, 2, 'V'), 'acc') +
    tile('Arus', f(d.current, 2, 'A')) +
    tile('Daya', f(d.power, 1, 'W')) +
    tile('SOC', d.soc === null ? '--' : d.soc + ' %', socCls) +
    tile('SOH', d.soh === null ? '--' : d.soh + ' %') +
    tile('Suhu sel maks / min', (d.tMax === null ? '--' : d.tMax) + ' / ' + (d.tMin === null ? '--' : d.tMin) + ' °C') +
    tile('Status', esc(d.stateName)) +
    tile('Jumlah discharge', d.dischargeTimes === null ? '--' : d.dischargeTimes + ' kali') +
    tile('Total discharge', d.dischargeAh === null ? '--' : d.dischargeAh + ' Ah') +
    tile('Selisih tegangan sel', f(delta, 0, 'mV'), delta !== null && delta > 100 ? 'warn' : '') +
    tile('Jumlah tegangan sel', f(sum, 2, 'V')) +
    '</div>';

  h += '<h3>Sel (' + d.cellCount + ')</h3><table><tr><th>Sel</th><th>Tegangan</th><th>Suhu</th></tr>';
  d.cellVolts.forEach(function (v, i) {
    var st = '';
    if (v !== null && v === vmax && vmax !== vmin) st = ' style="color:var(--acc)"';
    if (v !== null && v === vmin && vmax !== vmin) st = ' style="color:var(--warn)"';
    var t = d.cellTemps[i];
    h += '<tr><td>' + (i + 1) + '</td><td' + st + '>' + f(v, 3, 'V') + '</td><td>' + (t === null || t === undefined ? '--' : t + ' °C') + '</td></tr>';
  });
  h += '</table>';

  var any = d.alarms.some(function (a) { return a.value !== 0; });
  h += '<h3>Alarm</h3>';
  if (!any) {
    h += '<div class="meta" style="margin-top:6px">Semua word alarm = 0, tidak ada alarm.</div>';
  } else {
    h += '<table><tr><th>Register</th><th>Nama</th><th>Nilai</th><th>Bit aktif</th></tr>';
    d.alarms.forEach(function (a) {
      var on = a.value !== 0;
      h += '<tr' + (on ? ' style="color:var(--warn)"' : ' class="dim"') + '><td><code>0x' + a.reg.toString(16).toUpperCase().padStart(4, '0') +
        '</code></td><td>' + esc(a.name) + '</td><td><code>0x' + a.value.toString(16).toUpperCase().padStart(4, '0') +
        '</code></td><td>' + (a.bits.length ? a.bits.join(', ') : '-') + '</td></tr>';
    });
    h += '</table>';
  }
  return h;
}

function renderSmu(d) {
  var p = d.psu;
  var h = '<div class="grid">' +
    tile('Tegangan AC', f(d.ac_v, 1, 'V'), 'acc') +
    tile('Frekuensi', f(d.freq_hz, 1, 'Hz')) +
    tile('Tegangan DC', f(d.dc_v, 2, 'V'), 'acc') +
    tile('Arus beban', f(d.load_a, 2, 'A')) +
    tile('PSU terpasang (ada data)', p ? p.responding : '--', p && p.count === 0 ? 'bad' : 'ok') +
    tile('Slot tertinggi terdeteksi', p ? p.count : '--') +
    tile('Arus total PSU', p ? f(p.current_total, 2, 'A') : '--') +
    tile('Output rectifier', p ? f(p.out_v, 2, 'V') : '--') +
    '</div>';
  if (p && p.count === 0) {
    h += '<div class="err" style="margin-top:8px">SMU melaporkan 0 modul rectifier.</div>';
  }
  if (p && p.modules.length) {
    h += '<h3>Modul PSU per slot</h3><table><tr><th>Slot</th><th>Arus</th><th>Suhu? (dugaan)</th><th>AC masuk? (dugaan)</th><th>Output? (dugaan)</th><th>Batas arus? (dugaan)</th></tr>';
    p.modules.forEach(function (m) {
      if (!m.valid) {
        h += '<tr class="dim"><td>' + m.slot + '</td><td colspan="5">kosong / tidak ada data</td></tr>';
      } else {
        h += '<tr><td>' + m.slot + '</td><td>' + f(m.current_a, 2, 'A') + '</td><td>' + f(m.temp_guess, 1, '°C') +
          '</td><td>' + f(m.ac_in_guess, 1, 'V') + '</td><td>' + f(m.out_v_guess, 2, 'V') +
          '</td><td>' + f(m.limit_guess, 0, 'A') + '</td></tr>';
      }
    });
    h += '</table>';
  }
  if (d.config) {
    var c = d.config;
    h += '<h3>Config / threshold (dugaan, belum dikonfirmasi)</h3><div class="grid">' +
      tile('AC atas / bawah', f(c.ac_upper_v, 1) + ' / ' + f(c.ac_lower_v, 1) + ' V') +
      tile('DC over / under', f(c.dc_overvolt, 1) + ' / ' + f(c.dc_undervolt, 1) + ' V') +
      tile('Float / equalize', f(c.batt_float_v, 1) + ' / ' + f(c.batt_equalize_v, 1) + ' V') +
      tile('Kapasitas batt', f(c.batt_capacity_pct, 0, '%')) +
      '</div>';
  }
  if (d.alarms) {
    h += '<h3>Alarm (raw bit)</h3><table><tr><th>Grup</th><th>Bytes</th></tr>';
    d.alarms.forEach(function (a) {
      h += '<tr><td>' + esc(a.name) + '</td><td><code>' + (a.bin ? esc(a.bin) : '(no resp)') + '</code></td></tr>';
    });
    h += '</table><div class="note">Makna tiap bit belum dipetakan — bandingkan perubahan saat ada alarm nyata.</div>';
  }
  return h;
}

var RENDER = { jpf: renderJpf, esm: renderEsm, smu: renderSmu };
var ORDER = ['smu', 'esm', 'jpf'];

function setOpt0(id, cur) {
  var o = $(id).options[0];
  var t = '(tidak diubah, sekarang ' + cur + ')';
  if (o.text !== t) o.text = t;
}

function tick() {
  fetch('/api/data', { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      var html = '';
      if (j.scanning) {
        html = '<section><div class="meta">Auto-deteksi port sedang berjalan — pembacaan perangkat dijeda sementara...</div></section>';
      } else {
        ORDER.forEach(function (k) {
          var dev = j.devices[k];
          if (!dev) return;
          var hd = head(dev, j.now);
          var body = '';
          if (dev.data) {
            try { body = RENDER[k](dev.data); } catch (e) { body = '<div class="err">Gagal render: ' + esc(e.message) + '</div>'; }
          } else {
            body = '<div class="meta">Menunggu data...</div>';
          }
          html += '<section>' + hd.html + '<div' + (hd.dim ? ' class="dim"' : '') + '>' + body + '</div></section>';
        });
        if (!html) html = '<section><div class="meta">Tidak ada perangkat aktif. Aktifkan dan pilih port di panel Koneksi Perangkat.</div></section>';
      }
      $('app').innerHTML = html;
      var w = j.write || {};
      $('jpfcfg').hidden = !(w.enabled && j.devices.jpf);
      $('keylbl').hidden = !w.needKey;
      $('conncfg').hidden = !w.cfgEditable;
      $('cf_keylbl').hidden = !w.needKey;
      var jd = j.devices.jpf && j.devices.jpf.data;
      if (jd) {
        $('in_l').placeholder = 'sekarang ' + jd.startTemp;
        $('in_h').placeholder = 'sekarang ' + jd.fullTemp;
        $('in_numFans').placeholder = 'sekarang ' + jd.numFans;
        $('in_relayOpenT').placeholder = 'sekarang ' + jd.relayOpenT;
        $('in_relayCloseT').placeholder = 'sekarang ' + jd.relayCloseT;
        $('in_fanSpeed').placeholder = 'sekarang ' + jd.fanSpeed;
        setOpt0('in_mode', jd.mode);
        setOpt0('in_pwmFreq', jd.pwmFreq);
      }
      $('conn').textContent = 'Terakhir refresh ' + new Date(j.now).toLocaleTimeString();
    })
    .catch(function () { $('conn').textContent = 'Server tidak terjangkau...'; });
}
var FIELDS = ['l', 'h', 'mode', 'numFans', 'pwmFreq', 'relayOpenT', 'relayCloseT', 'fanSpeed'];

function getKey() { return $('cf_key').value || $('in_key').value; }

function send(payload) {
  var msg = $('cfgmsg');
  var btns = [$('btn_apply'), $('btn_auto')];
  btns.forEach(function (b) { b.disabled = true; });
  msg.className = 'note';
  msg.textContent = 'Mengirim ke alat...';
  var headers = { 'Content-Type': 'application/json' };
  var key = getKey();
  if (key) headers['X-Key'] = key;
  fetch('/api/jpf/settings', { method: 'POST', headers: headers, body: JSON.stringify(payload) })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (j.ok) {
        var parts = j.applied.map(function (a) { return a.label + ' = ' + a.value + (a.unit ? ' ' + a.unit : ''); });
        msg.className = 'note msg-ok';
        msg.textContent = 'Berhasil (dibaca ulang dari alat): ' + parts.join('; ') + '.' +
          (j.warnings && j.warnings.length ? ' Perhatian: ' + j.warnings.join(' ') : '');
        FIELDS.forEach(function (k) { $('in_' + k).value = ''; });
        tick();
      } else {
        msg.className = 'note msg-bad';
        msg.textContent = 'Gagal: ' + j.error;
      }
    })
    .catch(function (e) {
      msg.className = 'note msg-bad';
      msg.textContent = 'Gagal menghubungi server: ' + e.message;
    })
    .then(function () { btns.forEach(function (b) { b.disabled = false; }); });
}

$('btn_apply').onclick = function () {
  var payload = {};
  var n = 0;
  FIELDS.forEach(function (k) {
    var v = $('in_' + k).value.trim();
    if (v !== '') { payload[k] = Number(v); n++; }
  });
  if (!n) {
    $('cfgmsg').className = 'note msg-bad';
    $('cfgmsg').textContent = 'Isi minimal satu kolom yang ingin diubah.';
    return;
  }
  send(payload);
};
$('btn_auto').onclick = function () { send({ fanSpeed: 'auto' }); };

/* ---------- Koneksi perangkat: port, baud, address, auto-deteksi ---------- */
var DEV = ['jpf', 'esm', 'smu'];
var DEVNAME = { jpf: 'JPF4828', esm: 'ESM-48100B1', smu: 'SMU01C' };

function api(method, url, body) {
  var headers = { 'Content-Type': 'application/json' };
  var k = getKey();
  if (k) headers['X-Key'] = k;
  return fetch(url, { method: method, headers: headers, cache: 'no-store', body: body ? JSON.stringify(body) : undefined })
    .then(function (r) { return r.json(); });
}

function fmtAddr(k, v) { return k === 'esm' ? '0x' + Number(v).toString(16).toUpperCase() : String(v); }

function fillForm(c) {
  DEV.forEach(function (k) {
    var d = c[k];
    $('cf_' + k + '_en').checked = !!d.enabled;
    $('cf_' + k + '_path').value = d.path;
    $('cf_' + k + '_baud').value = String(d.baud);
    $('cf_' + k + '_addr').value = fmtAddr(k, k === 'smu' ? d.adr : d.slave);
  });
  $('cf_esm_par').value = c.esm.parity;
}

function collectForm() {
  var o = {};
  DEV.forEach(function (k) {
    o[k] = {
      enabled: $('cf_' + k + '_en').checked,
      path: $('cf_' + k + '_path').value.trim(),
      baud: Number($('cf_' + k + '_baud').value),
      addr: $('cf_' + k + '_addr').value.trim()
    };
  });
  o.esm.parity = $('cf_esm_par').value;
  return o;
}

function loadConfig() {
  return api('GET', '/api/config').then(function (j) { if (j.config) fillForm(j.config); });
}

function loadPorts() {
  return fetch('/api/ports', { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      var ports = j.ports || [];
      var h = '';
      var names = [];
      ports.forEach(function (p) {
        var lbl = [p.manufacturer, p.serialNumber ? 'SN ' + p.serialNumber : '', p.vendorId ? p.vendorId + ':' + p.productId : ''].filter(Boolean).join(' ');
        h += '<option value="' + esc(p.path) + '" label="' + esc(lbl) + '"></option>';
        names.push(p.path + (lbl ? ' (' + lbl + ')' : ''));
      });
      $('portlist').innerHTML = h;
      $('portinfo').textContent = ports.length ? ports.length + ' port terdeteksi: ' + names.join(', ') : 'Tidak ada port serial terdeteksi (cek kabel / driver).';
    })
    .catch(function () { $('portinfo').textContent = 'Gagal membaca daftar port.'; });
}

$('btn_ports').onclick = loadPorts;

$('btn_save').onclick = function () {
  var msg = $('cfgmsg2');
  var btn = $('btn_save');
  btn.disabled = true;
  msg.className = 'note';
  msg.textContent = 'Menyimpan dan menerapkan...';
  api('POST', '/api/config', collectForm())
    .then(function (j) {
      if (j.ok) {
        fillForm(j.config);
        msg.className = 'note msg-ok';
        var names = function (a) { return (a || []).map(function (k) { return DEVNAME[k]; }).join(', '); };
        var parts = [];
        if (j.hot && j.hot.length) parts.push('diterapkan tanpa buka ulang port: ' + names(j.hot));
        if (j.restarted && j.restarted.length) parts.push('dijalankan ulang: ' + names(j.restarted));
        msg.textContent = parts.length ? 'Tersimpan; ' + parts.join('; ') + '.' : 'Tersimpan. Tidak ada perubahan yang perlu diterapkan.';
        tick();
      } else {
        msg.className = 'note msg-bad';
        msg.textContent = 'Gagal: ' + j.error;
      }
    })
    .catch(function (e) { msg.className = 'note msg-bad'; msg.textContent = 'Gagal menghubungi server: ' + e.message; })
    .then(function () { btn.disabled = false; });
};

function showScanResult(s) {
  var scanMsg = $('scanmsg');
  $('btn_scan').disabled = false;
  if (s.error) { scanMsg.className = 'note msg-bad'; scanMsg.textContent = 'Auto-deteksi gagal: ' + s.error; return; }
  var h = '<table><tr><th>Port</th><th>Hasil</th></tr>';
  var assigned = {};
  (s.results || []).forEach(function (r) {
    var txt;
    if (r.found) {
      var x = r.found;
      txt = '<span style="color:var(--ok)">' + DEVNAME[x.type] + '</span> · ' + x.baud + ' baud' +
        (x.type === 'esm' ? ' · parity ' + x.parity : '') + ' · ' + (x.type === 'smu' ? 'ADR ' : 'slave ') + fmtAddr(x.type, x.addr);
      if (!assigned[x.type]) {
        assigned[x.type] = true;
        $('cf_' + x.type + '_en').checked = true;
        $('cf_' + x.type + '_path').value = r.path;
        $('cf_' + x.type + '_baud').value = String(x.baud);
        $('cf_' + x.type + '_addr').value = fmtAddr(x.type, x.addr);
        if (x.type === 'esm') $('cf_esm_par').value = x.parity;
      } else {
        txt += ' <span class="meta">(sudah dipakai port lain, dilewati)</span>';
      }
    } else if (r.error) {
      txt = '<span style="color:var(--warn)">tidak bisa dibuka: ' + esc(r.error) + '</span>';
    } else {
      txt = '<span class="meta">tidak ada respons (kabel / power mati / address di luar kandidat)</span>';
    }
    h += '<tr><td><code>' + esc(r.path) + '</code></td><td>' + txt + '</td></tr>';
  });
  h += '</table>';
  $('scanres').innerHTML = h;
  var n = Object.keys(assigned).length;
  scanMsg.className = 'note ' + (n ? 'msg-ok' : 'msg-bad');
  scanMsg.textContent = n
    ? 'Selesai: ' + n + ' perangkat dikenali dan sudah diisi ke form. Klik "Simpan & terapkan" untuk memakainya.'
    : 'Selesai: tidak ada perangkat yang dikenali. Isi manual, atau cek kabel / address.';
  tick();
}

function pollScan() {
  fetch('/api/scan', { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (s) {
      if (s.running) {
        $('scanmsg').className = 'note';
        $('scanmsg').textContent = 'Memindai ' + s.current + ' (' + s.done + '/' + s.total + ' port)...';
        setTimeout(pollScan, 1000);
      } else {
        showScanResult(s);
      }
    })
    .catch(function () { setTimeout(pollScan, 2000); });
}

$('btn_scan').onclick = function () {
  if (!confirm('Auto-deteksi menghentikan sementara semua pembacaan dan mencoba tiap port (bisa sekitar 1 menit). Lanjut?')) return;
  $('btn_scan').disabled = true;
  $('scanres').innerHTML = '';
  $('scanmsg').className = 'note';
  $('scanmsg').textContent = 'Memulai...';
  api('POST', '/api/scan', {})
    .then(function (j) {
      if (!j.ok) {
        $('btn_scan').disabled = false;
        $('scanmsg').className = 'note msg-bad';
        $('scanmsg').textContent = 'Gagal: ' + j.error;
        return;
      }
      pollScan();
    })
    .catch(function (e) {
      $('btn_scan').disabled = false;
      $('scanmsg').className = 'note msg-bad';
      $('scanmsg').textContent = 'Gagal menghubungi server: ' + e.message;
    });
};

loadConfig();
loadPorts();
setInterval(tick, 2000);
tick();
</script>
</body>
</html>`;

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req, max = 2048) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => {
      s += c;
      if (s.length > max) { reject(new Error('Body terlalu besar')); req.destroy(); }
    });
    req.on('end', () => resolve(s));
    req.on('error', reject);
  });
}

/** Cek izin untuk endpoint yang mengubah sesuatu. Mengirim respons error sendiri, return false kalau ditolak. */
function authorize(req, res) {
  if (!CFG.write.enabled) {
    sendJson(res, 403, { ok: false, error: 'Fitur ubah setting nonaktif (--readonly)' });
    return false;
  }
  // Wajib JSON: mencegah form dari situs lain menembak endpoint ini (CSRF)
  if (!(req.headers['content-type'] || '').includes('application/json')) {
    sendJson(res, 415, { ok: false, error: 'Content-Type harus application/json' });
    return false;
  }
  if (CFG.write.key && req.headers['x-key'] !== CFG.write.key) {
    sendJson(res, 401, { ok: false, error: 'Key salah atau belum diisi' });
    return false;
  }
  return true;
}

async function handleSettings(req, res) {
  try {
    if (!CFG.write.enabled || !jpfDev) {
      return sendJson(res, 403, { ok: false, error: 'Fitur ubah setting nonaktif (--readonly atau JPF dimatikan)' });
    }
    // Wajib JSON: mencegah form dari situs lain menembak endpoint ini (CSRF)
    if (!(req.headers['content-type'] || '').includes('application/json')) {
      return sendJson(res, 415, { ok: false, error: 'Content-Type harus application/json' });
    }
    if (CFG.write.key && req.headers['x-key'] !== CFG.write.key) {
      return sendJson(res, 401, { ok: false, error: 'Key salah atau belum diisi' });
    }
    const body = JSON.parse((await readBody(req)) || '{}');
    const want = {};
    for (const k of ['l', 'h', 'fanSpeed', 'mode', 'numFans', 'pwmFreq', 'relayOpenT', 'relayCloseT']) {
      const v = body[k];
      if (v === undefined || v === null || v === '') continue;
      want[k] = v === 'auto' ? 'auto' : Number(v);
    }
    const result = await jpfDev.setParams(want);
    console.log(`[jpf] setting diubah dari web (${req.socket.remoteAddress}): ` +
      result.applied.map((a) => `${a.label}=${a.value}${a.unit ? ' ' + a.unit : ''}`).join(', '));
    sendJson(res, 200, { ok: true, ...result });
  } catch (e) {
    sendJson(res, 400, { ok: false, error: e.message });
  }
}

async function handleConfig(req, res) {
  try {
    if (!authorize(req, res)) return;
    if (busy || scan.running) return sendJson(res, 409, { ok: false, error: 'Sedang sibuk (scan / menerapkan config). Coba lagi sebentar.' });

    const body = JSON.parse((await readBody(req, 8192)) || '{}');
    const keys = Object.keys(DEVICES);
    const next = {};
    for (const key of keys) if (body[key]) next[key] = normalizeDevice(key, body[key]);

    // Satu port tidak boleh dipakai dua perangkat aktif
    const used = {};
    for (const key of keys) {
      const m = { ...CFG[key], ...(next[key] || {}) };
      if (!m.enabled) continue;
      const p = m.path.toUpperCase();
      if (used[p]) throw new Error(`Port ${m.path} dipakai dua perangkat (${used[p]} dan ${key.toUpperCase()})`);
      used[p] = key.toUpperCase();
    }

    busy = true;
    const changes = [];
    const hot = [];
    const restarted = [];
    try {
      for (const key of keys) {
        if (!next[key]) continue;
        const before = pickPersist(key);
        Object.assign(CFG[key], next[key]);
        const after = pickPersist(key);
        if (JSON.stringify(before) !== JSON.stringify(after)) changes.push({ key, before, after });
      }
      saveConfig();
      for (const c of changes) {
        if (await hotApply(c.key, c.before, c.after)) { hot.push(c.key); continue; }
        await stopDevice(c.key);
        startDevice(c.key);
        restarted.push(c.key);
      }
    } finally {
      busy = false;
    }
    const changed = changes.map((c) => c.key);
    if (changed.length) console.log(`[config] diubah dari web (${req.socket.remoteAddress}): ${changed.join(', ')}`);
    sendJson(res, 200, { ok: true, changed, hot, restarted, config: publicConfig() });
  } catch (e) {
    sendJson(res, 400, { ok: false, error: e.message });
  }
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (req.method === 'POST' && url === '/api/jpf/settings') {
    handleSettings(req, res);
  } else if (req.method === 'POST' && url === '/api/config') {
    handleConfig(req, res);
  } else if (req.method === 'POST' && url === '/api/scan') {
    if (!authorize(req, res)) return;
    if (busy || scan.running) return sendJson(res, 409, { ok: false, error: 'Sedang sibuk (scan / menerapkan config).' });
    runScan(); // jalan di latar belakang; progres lewat GET /api/scan
    sendJson(res, 200, { ok: true });
  } else if (url === '/api/scan') {
    sendJson(res, 200, scan);
  } else if (url === '/api/config') {
    sendJson(res, 200, { ok: true, config: publicConfig(), bauds: BAUDS, parities: PARITIES });
  } else if (url === '/api/ports') {
    listPorts()
      .then((ports) => sendJson(res, 200, { ok: true, ports }))
      .catch((e) => sendJson(res, 500, { ok: false, error: e.message }));
  } else if (url === '/api/data') {
    sendJson(res, 200, {
      now: Date.now(),
      devices: state,
      scanning: scan.running,
      write: { enabled: CFG.write.enabled && !!jpfDev, needKey: !!CFG.write.key, cfgEditable: CFG.write.enabled },
    });
  } else if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
});

/* ================================================================== */
/*  NOTIFIKASI TELEGRAM (api.js)                                  */
/* ================================================================== */
const NOTIF_AC_FAIL_V = Number(process.env.AC_FAIL_V || 150); // AC di bawah ini dianggap PLN padam
const NOTIF_INTERVAL = 10000;

/** Terjemahkan `state` dashboard menjadi snapshot yang dipahami api.js. Perangkat offline = tidak ada di snapshot. */
function buildSnapshot() {
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const snap = {};
  const { jpf, esm, smu } = state;

  if (esm && esm.online && esm.data) {
    const d = esm.data;
    const vs = (d.cellVolts || []).filter((v) => v !== null);
    snap.battery = {
      voltage: num(d.packV), soc: num(d.soc), temp: num(d.tMax),
      status: d.stateName,          // 'Charge' / 'Discharge' / 'Unknown'
      current: num(d.current),      // arus pack (A)
      cellDelta: vs.length > 1 ? (Math.max(...vs) - Math.min(...vs)) * 1000 : undefined,
      alarm: (d.alarms || []).filter((a) => a.value !== 0)
        .map((a) => `${a.name} 0x${a.value.toString(16).toUpperCase()} (bit ${a.bits.join(',')})`),
    };
  }

  if (jpf && jpf.online && jpf.data) {
    const d = jpf.data;
    const temps = [d.tm1, d.tm2].filter((t) => typeof t === 'number' && Number.isFinite(t));
    const fans = Array.isArray(d.fans) ? d.fans : [];
    snap.fan = {
      temp: temps.length ? Math.max(...temps) : undefined,
      startTemp: num(d.startTemp),
      rpm: fans.length ? Math.max(...fans.map((x) => Number(x.rpm) || 0)) : undefined, // 0 = semua fan diam
      alarm: fans.filter((x) => x.ok === false).map((x) => `Fan ${x.n} FAULT`),
    };
  }

  if (smu && smu.online && smu.data) {
    const d = smu.data;
    const ac = num(d.ac_v);
    snap.rectifier = {
      voltage: num(d.dc_v) ?? (d.psu ? num(d.psu.out_v) : undefined),
      arus: d.psu ? num(d.psu.current_total) : undefined,
      arusBeban: num(d.load_a), 
      modul: d.psu ? d.psu.responding : undefined,
      acFail: ac === undefined ? undefined : ac < NOTIF_AC_FAIL_V,
    };
  }
  return snap;
}

let notifier = null;
if (!has('no-notify')) {
  try {
    notifier = require('./api.js');
  } catch (e) {
    console.warn(`[notif] api.js tidak dimuat (${e.message}) - notifikasi Telegram nonaktif`);
  }
}

function startNotifier() {
  if (!notifier) return;
  notifier.mulai();
  setInterval(() => {
    if (scan.running || busy) return; // perangkat sengaja dihentikan sementara
    try { Promise.resolve(notifier.proses(buildSnapshot())).catch(() => {}); } catch (e) { console.error('[notif]', e.message); }
  }, NOTIF_INTERVAL);
}

/* ================================================================== */
/*  MAIN                                                               */
/* ================================================================== */
for (const key of Object.keys(DEVICES)) startDevice(key);
startNotifier();

server.listen(CFG.http.port, CFG.http.host, () => {
  console.log(`Dashboard: http://${CFG.http.host === '0.0.0.0' ? 'localhost' : CFG.http.host}:${CFG.http.port}`);
  for (const k of Object.keys(state)) console.log(`  ${k.toUpperCase().padEnd(4)} -> ${state[k].port}`);
  console.log(`  Config web: ${CFG.write.enabled ? (CFG.write.key ? 'AKTIF (pakai key)' : 'AKTIF') : 'nonaktif (--readonly)'}  · file: ${CONFIG_FILE}`);
  console.log(`  Notifikasi Telegram: ${notifier ? 'AKTIF (notifier.js)' : 'nonaktif'}`);
});
server.on('error', (e) => { console.error('Gagal start web server:', e.message); process.exit(1); });

process.on('SIGINT', () => { console.log('\nBerhenti...'); process.exit(0); });