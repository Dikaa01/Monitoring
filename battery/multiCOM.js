#!/usr/bin/env node
'use strict';

/*
 * Pembaca register baterai Huawei ESM-48100B1 (Modbus RTU / RS485)
 * VERSI MULTI-PORT: membaca beberapa port serial (mis. 4 COM) SECARA BERSAMAAN
 * ---------------------------------------------------------------------------
 * - Hanya membaca (function code 0x03). Tidak ada perintah tulis.
 * - Tiap port punya koneksi + loop polling sendiri (async paralel), jadi satu
 *   port yang lambat / mati / dicabut TIDAK menghambat port lain.
 * - Default: 9600 baud, 8N1, slave address 0xD6 (214).
 * - Peta register berdasarkan capture bus nyata pada ESM-48100B1
 *   (github.com/GImDX/huawei-esm48100, PROTOCOL.md). Firmware/model lain
 *   bisa berbeda, jadi verifikasi hasilnya dengan tampilan di baterai/BMS.
 *
 * Instalasi : npm install serialport
 * Contoh    : node multiCOM.js --list
 *             node multiCOM.js --ports COM3,COM4,COM5,COM6
 *             node multiCOM.js -p COM3 -p COM4 -p COM5 -p COM6
 *             node multiCOM.js --ports COM3,COM4@0xD7,COM5,COM6 --view detail
 *             node multiCOM.js --ports /dev/ttyUSB0,/dev/ttyUSB1 --once
 *             node multiCOM.js --ports COM3,COM4 --scan
 *             node multiCOM.js --ports COM3,COM4 --read 0x0000 --count 7
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let SerialPort = null; // di-load di main() supaya file ini tetap bisa di-require tanpa serialport

/* ------------------------------------------------------------------ */
/*  Argumen CLI                                                        */
/* ------------------------------------------------------------------ */
const DEFAULTS = {
  baud: 9600,
  parity: 'none',   // none | even | odd  (coba 'even' jika tidak ada respons)
  slave: 0xd6,      // 214 (default untuk semua port, bisa di-override per port dengan @)
  interval: 5,      // detik antar pembacaan (jaga baterai tetap "bangun")
  timeout: 1500,    // ms menunggu respons per request
  wake: 60,         // detik maksimal menunggu baterai bangun
};

function usage() {
  console.log(`
Pemakaian: node multiCOM.js --ports COM3,COM4,COM5,COM6 [opsi]

  --list                 Tampilkan daftar port serial lalu keluar
  --ports <a,b,c,d>      Daftar port dipisah koma (jumlah bebas, tidak harus 4)
  --port, -p <path>      Tambah satu port (boleh diulang: -p COM3 -p COM4 ...)
                         Tiap port boleh diberi slave sendiri: COM4@0xD7
  --slave, -s <addr>     Slave default utk semua port, desimal atau 0x..  [0xD6 = 214]
  --baud <n>             Baud rate                                        [${DEFAULTS.baud}]
  --parity <p>           none | even | odd                                [${DEFAULTS.parity}]
  --interval, -i <detik> Jeda antar pembacaan per port                    [${DEFAULTS.interval}]
  --timeout <ms>         Timeout respons per request                      [${DEFAULTS.timeout}]
  --wake <detik>         Maks. waktu menunggu baterai bangun              [${DEFAULTS.wake}]
  --view <table|detail>  table  = satu tabel ringkas semua port (default)
                         detail = cetak lengkap per port (default utk --once)
  --once                 Baca sekali lalu keluar
  --scan                 Cari baterai di alamat 0xD6-0xDD dan 0xE0-0xE7 (tiap port)
  --read <reg> --count n Dump register mentah (function 0x03) dari tiap port
  --debug                Tampilkan byte TX/RX (otomatis memakai view detail)
  --help, -h             Bantuan
`);
}

function parseNum(s) {
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error(`Angka tidak valid: ${s}`);
  return n;
}

/** "COM4" atau "COM4@0xD7" -> { path, slave|null } */
function parseTarget(spec) {
  const at = spec.lastIndexOf('@');
  if (at > 0) return { path: spec.slice(0, at), slave: parseNum(spec.slice(at + 1)) };
  return { path: spec, slave: null };
}

function parseArgs(argv) {
  const o = {
    ...DEFAULTS, targets: [], view: null,
    list: false, scan: false, once: false, debug: false, read: null, count: 1, help: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Opsi ${a} membutuhkan nilai`);
      return argv[++i];
    };
    switch (a) {
      case '--port': case '-p': o.targets.push(parseTarget(next())); break;
      case '--ports':
        next().split(',').map((s) => s.trim()).filter(Boolean).forEach((s) => o.targets.push(parseTarget(s)));
        break;
      case '--slave': case '-s': o.slave = parseNum(next()); break;
      case '--baud': o.baud = parseNum(next()); break;
      case '--parity': o.parity = next().toLowerCase(); break;
      case '--interval': case '-i': o.interval = parseNum(next()); break;
      case '--timeout': o.timeout = parseNum(next()); break;
      case '--wake': o.wake = parseNum(next()); break;
      case '--view': o.view = next().toLowerCase(); break;
      case '--read': o.read = parseNum(next()); break;
      case '--count': o.count = parseNum(next()); break;
      case '--once': o.once = true; break;
      case '--scan': o.scan = true; break;
      case '--list': o.list = true; break;
      case '--debug': o.debug = true; break;
      case '--help': case '-h': o.help = true; break;
      default: throw new Error(`Opsi tidak dikenal: ${a}`);
    }
  }

  if (o.view !== null && !['table', 'detail'].includes(o.view)) throw new Error('--view harus "table" atau "detail"');
  if (!['none', 'even', 'odd'].includes(o.parity)) throw new Error('--parity harus none | even | odd');

  const seen = new Set();
  for (const t of o.targets) {
    if (t.slave === null) t.slave = o.slave;
    if (!Number.isInteger(t.slave) || t.slave < 1 || t.slave > 247) {
      throw new Error(`Alamat slave tidak valid untuk ${t.path}: ${t.slave}`);
    }
    const key = t.path.toLowerCase();
    if (seen.has(key)) throw new Error(`Port ${t.path} disebut lebih dari sekali`);
    seen.add(key);
  }

  if (!o.view) o.view = o.once || o.debug ? 'detail' : 'table';
  if (o.debug) o.view = 'detail'; // debug + tabel yang di-refresh = tidak terbaca
  return o;
}

/* ------------------------------------------------------------------ */
/*  Modbus RTU (satu instance per port)                                */
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
  constructor(port, { timeout = 1500, debug = false, label = '' } = {}) {
    this.port = port;
    this.timeout = timeout;
    this.debug = debug;
    this.label = label;
    this.buf = Buffer.alloc(0);
    this.waiter = null;
    this.lastEnd = 0;
    port.on('data', (d) => {
      if (this.debug) console.log(`  [${this.label}] RX`, d.toString('hex').match(/../g).join(' '));
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
    if (this.debug) console.log(`  [${this.label}] TX`, req.toString('hex').match(/../g).join(' '));
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

/** Tampilan lengkap satu baterai. Dicetak dengan satu console.log agar tidak tercampur port lain. */
function printSnapshot(s, slave, label = '') {
  const out = [];
  const line = (k, v) => out.push(`${pad(k, 24)}: ${v}`);
  out.push(`\n=== Huawei ESM-48100B1 | ${label ? label + ' | ' : ''}slave ${hex(slave, 2)} (${slave}) | ${s.time.toLocaleString()} ===`);
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

  out.push('\n  Sel   Tegangan    Suhu');
  s.cellVolts.forEach((v, i) => {
    out.push(`  ${String(i + 1).padStart(2)}    ${pad(fmt(v, 3, 'V'), 10)}  ${s.cellTemps[i] ?? 'n/a'} °C`);
  });

  out.push('\n  Alarm:');
  let any = false;
  s.alarms.forEach((w, i) => {
    const bits = [];
    for (let b = 0; b < 16; b++) if (w & (1 << b)) bits.push(b);
    if (w) any = true;
    out.push(`  ${hex(ALARM_WORDS[i][0])} ${pad(ALARM_WORDS[i][1], 22)} ${hex(w)}${bits.length ? '  bit aktif: ' + bits.join(',') : ''}`);
  });
  if (!any) out.push('  (semua word alarm = 0, tidak ada alarm)');
  console.log(out.join('\n'));
}

/** Tabel ringkas: satu baris per port + total. */
function tableString(devices, once = false) {
  const now = Date.now();
  const cols = [
    ['Port', 14, 'l'], ['Slv', 4, 'l'], ['Vpack', 8, 'r'], ['Arus', 9, 'r'], ['Daya', 10, 'r'],
    ['SOC', 4, 'r'], ['SOH', 4, 'r'], ['Suhu', 9, 'r'], ['Mode', 9, 'l'], ['dV sel', 7, 'r'],
    ['Alarm', 5, 'l'], ['Status', 0, 'l'],
  ];
  const fit = (v, w, al) => {
    if (!w) return String(v);
    let s = String(v);
    if (s.length > w) s = s.slice(0, w);
    return al === 'r' ? s.padStart(w) : s.padEnd(w);
  };
  const render = (cells) => cells.map((c, i) => fit(c, cols[i][1], cols[i][2])).join('  ').trimEnd();

  const lines = [];
  lines.push(`=== Huawei ESM-48100B1 | ${devices.length} port | ${new Date().toLocaleTimeString()}${once ? '' : ' | Ctrl+C untuk berhenti'} ===`);
  lines.push(render(cols.map((c) => c[0])));
  lines.push('-'.repeat(96));

  for (const d of devices) {
    const s = d.phase === 'ok' ? d.snap : null;
    const age = d.lastOk ? Math.round((now - d.lastOk) / 1000) : null;
    let dv = '-';
    if (s) {
      const vs = s.cellVolts.filter((v) => v !== null);
      if (vs.length) dv = `${Math.round((Math.max(...vs) - Math.min(...vs)) * 1000)} mV`;
    }
    const status = d.phase === 'ok'
      ? (once ? 'OK' : `OK (${age} dtk lalu)`)
      : `${d.text}${age !== null ? ` [data terakhir ${age} dtk lalu]` : ''}`;
    lines.push(render([
      d.label,
      hex(d.slave, 2),
      s ? fmt(s.packV, 2, 'V') : '-',
      s ? fmt(s.current, 2, 'A') : '-',
      s ? fmt(s.power, 1, 'W') : '-',
      s ? (s.soc === null ? 'n/a' : `${s.soc}%`) : '-',
      s ? (s.soh === null ? 'n/a' : `${s.soh}%`) : '-',
      s ? `${s.tMax ?? 'n/a'}/${s.tMin ?? 'n/a'}°C` : '-',
      s ? (STATE_NAMES[s.state] ?? `? (${s.state})`) : '-',
      dv,
      s ? (s.alarms.some(Boolean) ? 'ALARM' : 'OK') : '-',
      status,
    ]));
  }

  const ok = devices.filter((d) => d.phase === 'ok' && d.snap);
  if (ok.length) {
    const totI = ok.reduce((a, d) => a + (d.snap.current ?? 0), 0);
    const totP = ok.reduce((a, d) => a + (d.snap.power ?? 0), 0);
    const socs = ok.map((d) => d.snap.soc).filter((v) => v !== null);
    const avg = socs.length ? socs.reduce((a, b) => a + b, 0) / socs.length : null;
    lines.push('-'.repeat(96));
    lines.push(`Total (${ok.length}/${devices.length} online): arus ${totI.toFixed(2)} A | daya ${totP.toFixed(1)} W | SOC rata-rata ${avg === null ? 'n/a' : avg.toFixed(0) + ' %'}`);
  }

  for (const d of ok) {
    d.snap.alarms.forEach((w, i) => {
      if (!w) return;
      const bits = [];
      for (let b = 0; b < 16; b++) if (w & (1 << b)) bits.push(b);
      lines.push(`  ! ${d.label}: ${hex(ALARM_WORDS[i][0])} ${ALARM_WORDS[i][1]} = ${hex(w)} (bit ${bits.join(',')})`);
    });
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/*  UI: mengatur apa yang dicetak                                      */
/* ------------------------------------------------------------------ */
class Ui {
  constructor(o, devices) {
    this.o = o;
    this.devices = devices;
    this.mode = o.view;
    // live = cetak pesan progres/error langsung (prefix [port])
    this.live = o.view === 'detail' || o.once || o.scan || o.read !== null;
    // tabel hidup hanya untuk monitor kontinu (bukan --once/--scan/--read)
    this.table = o.view === 'table' && !o.once && !o.scan && o.read === null;
    this.isTty = Boolean(process.stdout.isTTY);
    this.debounce = null;
    this.tick = null;
  }
  message(dev, text) { if (this.live) console.log(`[${dev.label}] ${text}`); }
  snapshot(dev, snap) {
    if (this.mode === 'detail' && !this.o.once) printSnapshot(snap, dev.slave, dev.label);
  }
  changed() {
    if (!this.table || this.debounce) return;
    this.debounce = setTimeout(() => { this.debounce = null; this.render(); }, 100);
  }
  render() {
    process.stdout.write((this.isTty ? '\x1b[2J\x1b[H' : '\n') + tableString(this.devices) + '\n');
  }
  start() {
    if (!this.table) return;
    if (this.isTty) this.tick = setInterval(() => this.render(), 1000);
    this.render();
  }
  stop() {
    clearInterval(this.tick);
    clearTimeout(this.debounce);
  }
}

/* ------------------------------------------------------------------ */
/*  Device = satu port serial + satu baterai (slave)                   */
/* ------------------------------------------------------------------ */
function openPort(path, o) {
  return new Promise((resolve, reject) => {
    const p = new SerialPort(
      { path, baudRate: o.baud, dataBits: 8, stopBits: 1, parity: o.parity },
      (err) => (err ? reject(err) : resolve(p)),
    );
  });
}

class Device {
  constructor(target, o, ui) {
    this.path = target.path;
    this.slave = target.slave;
    this.label = target.path.replace(/^\/dev\//, '');
    this.o = o;
    this.ui = ui;
    this.port = null;
    this.mb = null;
    this.cache = {};
    this.phase = 'init';  // init | opening | waking | ok | error
    this.text = 'Menunggu...';
    this.snap = null;
    this.lastOk = 0;
    this.stopping = false;
  }

  setStatus(phase, text, print = false) {
    this.phase = phase;
    this.text = text;
    if (print && !this.stopping) this.ui.message(this, text);
    this.ui.changed();
  }

  async open() {
    this.setStatus('opening', 'Membuka port...');
    let p;
    try {
      p = await openPort(this.path, this.o);
    } catch (e) {
      let msg = `Gagal membuka ${this.path}: ${e.message}`;
      if (process.platform === 'linux' && /permission/i.test(e.message)) msg += ' (coba: sudo usermod -aG dialout $USER, lalu login ulang)';
      throw new Error(msg);
    }
    p.on('error', (e) => { if (!this.stopping) this.setStatus('error', `Port error: ${e.message}`, true); });
    p.on('close', () => { if (!this.stopping) this.setStatus('error', 'Port tertutup (kabel dicabut?)', true); });
    this.port = p;
    this.mb = new ModbusRtu(p, { timeout: this.o.timeout, debug: this.o.debug, label: this.label });
    this.cache = {};
    this.ui.message(this, `Port terbuka: ${this.o.baud} baud, 8${this.o.parity[0].toUpperCase()}1, slave ${hex(this.slave, 2)}`);
  }

  /** Baterai bisa "tidur" bila bus sepi; beberapa request pertama bisa tanpa respons. */
  async wakeUp() {
    const maxMs = this.o.wake * 1000;
    const start = Date.now();
    for (let attempt = 1; Date.now() - start < maxMs && !this.stopping; attempt++) {
      if (!this.port || !this.port.isOpen) throw new Error('Port tertutup');
      try {
        await this.mb.readRegisters(this.slave, 0x0000, 1, 1500);
        if (attempt > 1) this.ui.message(this, `baterai merespons pada percobaan ke-${attempt}`);
        return;
      } catch (e) {
        if (e.code === 'EXCEPTION') throw e;
        this.setStatus('waking', `Menunggu respons baterai... percobaan ${attempt} (${Math.round((Date.now() - start) / 1000)} dtk)`,
          attempt === 1 || attempt % 5 === 0);
        await sleep(3000);
      }
    }
    throw new Error(`Baterai ${hex(this.slave, 2)} tidak merespons dalam ${this.o.wake} detik. Cek wiring A/B, port, baud/parity, dan alamat slave.`);
  }

  /** Loop polling untuk port ini. Berjalan mandiri; error di sini tidak mempengaruhi port lain. */
  async run() {
    let needWake = true;
    let fails = 0;
    while (!this.stopping) {
      try {
        if (!this.port || !this.port.isOpen) { await this.open(); needWake = true; }
        if (needWake) { await this.wakeUp(); needWake = false; }
        const snap = await readSnapshot(this.mb, this.slave, this.cache);
        this.snap = snap;
        this.lastOk = Date.now();
        fails = 0;
        this.setStatus('ok', 'OK');
        this.ui.snapshot(this, snap);
      } catch (e) {
        if (this.stopping) break;
        fails++;
        this.setStatus('error', e.message, true);
        if (fails >= 3) { needWake = true; fails = 0; } // gagal berulang -> bangunkan lagi
      }
      if (this.o.once) break;
      await sleep(this.o.interval * 1000);
    }
  }

  close() {
    this.stopping = true;
    return new Promise((res) => {
      if (this.port && this.port.isOpen) this.port.close(() => res());
      else res();
    });
  }
}

/* ------------------------------------------------------------------ */
/*  Fitur bantu: scan, dump (per port)                                 */
/* ------------------------------------------------------------------ */
async function scan(mb, label, windowMs = 60000) {
  const log = (m) => console.log(`[${label}] ${m}`);
  const addrs = [];
  for (let a = 0xd6; a <= 0xdd; a++) addrs.push(a);
  for (let a = 0xe0; a <= 0xe7; a++) addrs.push(a);
  const found = new Set();
  const start = Date.now();
  log(`Scan ${addrs.length} alamat (0xD6-0xDD, 0xE0-0xE7), maks ${windowMs / 1000} detik...`);
  while (Date.now() - start < windowMs) {
    for (const a of addrs) {
      if (found.has(a)) continue;
      try {
        const [v] = await mb.readRegisters(a, 0x0000, 1, 500);
        found.add(a);
        log(`  Ditemukan: slave ${hex(a, 2)} (${a}), reg 0x0000 = ${v}`);
      } catch (e) { /* belum merespons */ }
    }
    if (found.size === addrs.length) break;
    await sleep(3000);
  }
  log(found.size ? `Selesai: ${found.size} perangkat.` : 'Tidak ada perangkat yang merespons.');
}

/** Mengembalikan baris teks (dicetak berurutan per port di akhir supaya tidak tercampur). */
async function dump(mb, slave, addr, count, label) {
  const regs = await mb.read(slave, addr, count);
  const out = [`[${label}] Slave ${hex(slave, 2)}, register ${hex(addr)} .. ${hex(addr + count - 1)}`];
  regs.forEach((v, i) => {
    out.push(`  ${hex(addr + i)}  dec=${String(v).padStart(5)}  s16=${String(v & 0x8000 ? v - 0x10000 : v).padStart(6)}  hex=${hex(v)}`);
  });
  return out;
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */
async function main() {
  let o;
  try { o = parseArgs(process.argv); } catch (e) { console.error(e.message); usage(); process.exit(1); }
  if (o.help) return usage();

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

  if (!o.targets.length) {
    console.error('Belum ada port. Contoh: --ports COM3,COM4,COM5,COM6  (cek port dengan --list)');
    process.exit(1);
  }

  const devices = [];
  const ui = new Ui(o, devices);
  o.targets.forEach((t) => devices.push(new Device(t, o, ui)));
  const closeAll = () => Promise.all(devices.map((d) => d.close()));

  // --- Mode utilitas: scan / dump, semua port paralel ---
  if (o.scan || o.read !== null) {
    const results = await Promise.all(devices.map(async (d) => {
      try {
        await d.open();
        if (o.scan) { await scan(d.mb, d.label); return []; }
        await d.wakeUp();
        return await dump(d.mb, d.slave, o.read, o.count, d.label);
      } catch (e) {
        process.exitCode = 1;
        return [`[${d.label}] Error: ${e.message}`];
      }
    }));
    results.forEach((lines) => lines.forEach((l) => console.log(l)));
    await closeAll();
    return;
  }

  // --- Mode monitor: semua port dibaca paralel ---
  process.on('SIGINT', async () => {
    ui.stop();
    console.log('\nBerhenti...');
    await closeAll();
    process.exit(0);
  });

  ui.start();
  await Promise.all(devices.map((d) => d.run())); // pada mode kontinu tidak pernah selesai (sampai Ctrl+C)

  // Hanya tercapai pada --once: cetak hasil berurutan sesuai urutan port
  ui.stop();
  if (o.view === 'table') {
    console.log('\n' + tableString(devices, true));
  } else {
    devices.forEach((d) => { if (d.snap) printSnapshot(d.snap, d.slave, d.label); });
  }
  if (devices.some((d) => d.phase !== 'ok')) process.exitCode = 1;
  await closeAll();
}

module.exports = { crc16, buildReadRequest, findFrame, ModbusRtu, readSnapshot, printSnapshot, tableString, parseArgs };

if (require.main === module) main();