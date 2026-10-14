#!/usr/bin/env node
/**
 * esm_scan.js - Pemindai RS485 (READ-ONLY) untuk baterai Huawei ESM-48100B1
 *
 * Perintah:
 *   ports   daftar port serial yang terdeteksi
 *   scan    cari kombinasi baudrate / parity / slave ID yang menjawab Modbus RTU
 *   yd      probe protokol YDN1363 (frame ASCII diawali '~', diakhiri CR)
 *   ident   minta info perangkat (FC 0x11 dan FC 0x2B/0x0E)
 *   dump    baca register (FC03 / FC04) dan simpan ke CSV
 *   watch   pantau register, tampilkan hanya yang berubah
 *   monitor dashboard live dari map.json (nama, skala, satuan)
 *   find    cocokkan nilai asli (display/BMS) ke register di CSV hasil dump
 *
 * Semua fungsi Modbus yang dipakai hanya BACA. Tidak ada perintah tulis (write).
 *
 * Butuh Node.js >= 18 dan:  npm install serialport
 *
 * Contoh:
 *   node esm_scan.js ports
 *   node esm_scan.js -p COM5 scan
 *   node esm_scan.js -p COM5 scan --baud all --parity N,E,O
 *   node esm_scan.js -p COM5 yd
 *   node esm_scan.js -p COM5 dump --baud 9600 --parity E --slave 214 --end 300 --csv reg.csv
 */
'use strict';

const fs = require('fs');
const { parseArgs } = require('util');

let SerialPort;
try {
  ({ SerialPort } = require('serialport'));
} catch {
  console.error('Paket serialport belum terpasang. Jalankan: npm install serialport');
  process.exit(1);
}

const PARITY = { N: 'none', E: 'even', O: 'odd' };
const ALL_BAUDS = [9600, 19200, 4800, 2400, 1200, 38400, 57600, 115200];
const EXC = {
  1: 'Illegal Function', 2: 'Illegal Data Address', 3: 'Illegal Data Value',
  4: 'Slave Device Failure', 5: 'Acknowledge', 6: 'Slave Busy',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Number(process.hrtime.bigint() / 1000000n); // ms

// --------------------------------------------------------------------------
// Lapisan serial
// --------------------------------------------------------------------------
class Link {
  constructor(path, timeoutMs, delayMs = 0) {
    this.path = path;
    this.timeout = timeoutMs;
    this.delay = delayMs; // jeda minimum antar request (ms)
    this.lastEnd = 0;
    this.port = null;
    this.buf = Buffer.alloc(0);
    this.last = 0;
    this.baud = 9600;
    this.parity = 'N';
    this.gap = 20;
  }

  async open(baud, parity) {
    this.baud = baud;
    this.parity = parity;
    this.gap = Math.max(20, Math.ceil(44000 / baud)); // ~4 karakter = akhir frame (ms)
    this.buf = Buffer.alloc(0);
    this.port = new SerialPort({
      path: this.path, baudRate: baud, dataBits: 8, stopBits: 1,
      parity: PARITY[parity], autoOpen: false,
    });
    this.port.on('data', (d) => {
      this.buf = Buffer.concat([this.buf, d]);
      this.last = now();
    });
    await new Promise((res, rej) => this.port.open((e) => (e ? rej(e) : res())));
    await sleep(50);
  }

  // node-serialport hanya bisa ganti baudRate lewat update(), jadi buka ulang
  async set(baud, parity) {
    await this.close();
    await this.open(baud, parity);
  }

  async txrx(frame) {
    const p = this.port;
    const wait = this.delay - (now() - this.lastEnd);
    if (wait > 0) await sleep(wait);
    this.buf = Buffer.alloc(0);
    await new Promise((res, rej) => p.write(frame, (e) => (e ? rej(e) : res())));
    await new Promise((res, rej) => p.drain((e) => (e ? rej(e) : res())));
    const deadline = now() + this.timeout;
    for (;;) {
      const t = now();
      const b = this.buf;
      if (b.length && t - this.last > this.gap) {
        // kalau baru echo dari adaptor, tunggu balasan sungguhan
        if (b.equals(frame.subarray(0, b.length)) && t < deadline) {
          await sleep(1);
          continue;
        }
        break;
      }
      if (!b.length && t > deadline) break;
      await sleep(1);
    }
    let data = Buffer.from(this.buf);
    if (data.length >= frame.length && data.subarray(0, frame.length).equals(frame)) {
      data = data.subarray(frame.length); // buang echo adaptor
    }
    this.lastEnd = now();
    return data;
  }

  async close() {
    if (this.port && this.port.isOpen) {
      await new Promise((res) => this.port.close(() => res()));
    }
  }
}

// --------------------------------------------------------------------------
// Modbus RTU
// --------------------------------------------------------------------------
function crc16(buf) {
  let crc = 0xffff;
  for (const b of buf) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >> 1) ^ 0xa001 : crc >> 1;
  }
  return crc;
}

function mbFrame(slave, fc, payload = Buffer.alloc(0)) {
  const body = Buffer.concat([Buffer.from([slave, fc]), payload]);
  const crc = Buffer.alloc(2);
  crc.writeUInt16LE(crc16(body));
  return Buffer.concat([body, crc]);
}

const u16pair = (a, b) => {
  const x = Buffer.alloc(4);
  x.writeUInt16BE(a, 0);
  x.writeUInt16BE(b, 2);
  return x;
};

/** Return [status, value]: [null,null]=kosong, ok=payload, exc=kode, bad=tidak valid. */
function parseMb(data, slave, fc) {
  if (!data.length) return [null, null];
  if (data.length < 5) return ['bad', null];
  if (crc16(data.subarray(0, -2)) !== data.readUInt16LE(data.length - 2)) return ['bad', null];
  if (data[0] !== slave) return ['bad', null];
  if (data[1] === fc) return ['ok', data.subarray(2, -2)];
  if (data[1] === (fc | 0x80)) return ['exc', data[2]];
  return ['bad', null];
}

async function readRegs(link, sid, fc, addr, qty) {
  const data = await link.txrx(mbFrame(sid, fc, u16pair(addr, qty)));
  const [st, val] = parseMb(data, sid, fc);
  if (st === 'ok') {
    if (val.length === qty * 2 + 1 && val[0] === qty * 2) {
      const out = [];
      for (let i = 0; i < qty; i++) out.push(val.readUInt16BE(1 + i * 2));
      return ['ok', out];
    }
    return ['bad', null];
  }
  return [st, val];
}

// --------------------------------------------------------------------------
// YDN1363 (YD/T 1363.3) - frame ASCII
// --------------------------------------------------------------------------
function ydLchk(lenid) {
  const s = ((lenid >> 8) & 0xf) + ((lenid >> 4) & 0xf) + (lenid & 0xf);
  return (~(s % 16) + 1) & 0xf;
}

function ydFrame(adr, cid1, cid2, info = Buffer.alloc(0), ver = 0x20) {
  const hex = (n, w) => n.toString(16).toUpperCase().padStart(w, '0');
  const lenid = info.length;
  const length = (ydLchk(lenid) << 12) | lenid;
  const body = Buffer.concat([
    Buffer.from(hex(ver, 2) + hex(adr, 2) + hex(cid1, 2) + hex(cid2, 2) + hex(length, 4), 'ascii'),
    info,
  ]);
  let sum = 0;
  for (const b of body) sum += b;
  const chk = (~sum + 1) & 0xffff;
  return Buffer.concat([Buffer.from('~'), body, Buffer.from(hex(chk, 4), 'ascii'), Buffer.from('\r')]);
}

// --------------------------------------------------------------------------
// Util
// --------------------------------------------------------------------------
const hexs = (b) => [...b].map((x) => x.toString(16).toUpperCase().padStart(2, '0')).join(' ');
const printable = (b) => [...b].map((x) => (x >= 32 && x < 127 ? String.fromCharCode(x) : '.')).join('');
const pad = (v, w) => String(v).padStart(w, ' ');

function parseBauds(s) {
  return s.toLowerCase() === 'all' ? [...ALL_BAUDS] : s.split(',').map((x) => parseInt(x, 10));
}

function parseParities(s) {
  const p = s.split(',').map((x) => x.trim().toUpperCase());
  for (const x of p) if (!PARITY[x]) die(`Parity tidak dikenal: ${x} (pakai N, E, atau O)`);
  return p;
}

function combos(o) {
  const out = [];
  for (const b of parseBauds(o.baud)) for (const p of parseParities(o.parity)) out.push([b, p]);
  return out;
}

function orderedIds(lo, hi) {
  const pref = [214, 1, 2, 3, 4, 5, 16, 17].filter((i) => i >= lo && i <= hi);
  const rest = [];
  for (let i = lo; i <= hi; i++) if (!pref.includes(i)) rest.push(i);
  return [...pref, ...rest];
}

function die(msg) {
  console.error(msg);
  process.exit(1);
}

let stopping = false;
process.on('SIGINT', () => {
  if (stopping) process.exit(130);
  stopping = true;
  console.log('\nDihentikan (tunggu sebentar)...');
});

// --------------------------------------------------------------------------
// Perintah
// --------------------------------------------------------------------------
async function cmdPorts() {
  const list = await SerialPort.list();
  if (!list.length) return console.log('Tidak ada port serial terdeteksi.');
  for (const p of list) {
    console.log(`${p.path.padEnd(18)} ${[p.manufacturer, p.friendlyName, p.pnpId].filter(Boolean).join(' | ')}`);
  }
}

async function cmdScan(o) {
  const link = new Link(o.port, o.timeout, o.delay);
  const probes = [[0x03, u16pair(o.probeAddr, 1)]];
  if (!o.fast) probes.push([0x04, u16pair(o.probeAddr, 1)]);
  const ids = orderedIds(o.idMin, o.idMax);
  const found = [];
  try {
    for (const [baud, par] of combos(o)) {
      if (stopping) break;
      await link.set(baud, par);
      console.log(`\n[${baud} baud, 8${par}1] scan slave ID ${o.idMin}-${o.idMax} ` +
        `(${probes.length} probe/ID, timeout ${o.timeout}ms)`);
      let hit = false;
      let noisy = 0;
      for (const sid of ids) {
        if (stopping) break;
        process.stdout.write(`\r  cek ID ${pad(sid, 3)} ...`);
        for (const [fc, pl] of probes) {
          const data = await link.txrx(mbFrame(sid, fc, pl));
          const [st, val] = parseMb(data, sid, fc);
          const fch = fc.toString(16).toUpperCase().padStart(2, '0');
          if (st === 'ok') {
            console.log(`\r  >> ID ${sid}: FC${fch} addr ${o.probeAddr} BALAS DATA: ${hexs(val)}      `);
            found.push([baud, par, sid, fc, 'data']);
            hit = true;
            break;
          }
          if (st === 'exc') {
            console.log(`\r  >> ID ${sid}: FC${fch} BALAS EXCEPTION ${val} (${EXC[val] || '?'}) -> perangkat ADA      `);
            found.push([baud, par, sid, fc, `exc${val}`]);
            hit = true;
            break;
          }
          if (st === 'bad') {
            noisy++;
            if (noisy <= 10) {
              console.log(`\r  ?  ID ${sid}: balasan tidak valid: ${hexs(data)}      ` +
                '(bisa jadi baud/parity salah, atau bukan Modbus)');
            }
          }
        }
      }
      console.log('\r' + ' '.repeat(40));
      if (hit && !o.allCombos) {
        console.log('Ada respons pada kombinasi ini, berhenti (pakai --all-combos untuk lanjut).');
        break;
      }
    }
  } finally {
    await link.close();
  }

  console.log('\n=== RINGKASAN ===');
  if (!found.length) {
    console.log('Tidak ada balasan Modbus yang valid. Coba: --baud all, kabel A/B ditukar,');
    console.log("jumper pin 1+4 dan 2+5, atau jalankan perintah 'yd'.");
  }
  for (const [baud, par, sid, fc, res] of found) {
    console.log(`baud=${baud} parity=${par} slave=${sid} FC${fc.toString(16).toUpperCase().padStart(2, '0')} (${res})`);
  }
  if (found.length) {
    const [baud, par, sid] = found[0];
    console.log(`\nLanjut: node esm_scan.js -p ${o.port} dump --baud ${baud} --parity ${par} --slave ${sid} --end 300`);
  }
}

async function cmdYd(o) {
  const link = new Link(o.port, o.timeout, o.delay);
  const cid1 = Number(o.cid1);
  const ver = Number(o.ver);
  let any = false;
  try {
    for (const [baud, par] of combos(o)) {
      if (stopping) break;
      await link.set(baud, par);
      console.log(`\n[${baud} baud, 8${par}1] probe YDN1363 ADR ${o.adrMin}-${o.adrMax}, ` +
        `CID1=0x${cid1.toString(16).toUpperCase()}, VER=0x${ver.toString(16).toUpperCase()}`);
      for (let adr = o.adrMin; adr <= o.adrMax && !stopping; adr++) {
        for (const [cid2, name] of [[0x4f, 'versi protokol'], [0x51, 'info pabrikan']]) {
          const data = await link.txrx(ydFrame(adr, cid1, cid2, Buffer.alloc(0), ver));
          if (!data.length) continue;
          any = true;
          const c2 = cid2.toString(16).toUpperCase();
          if (data[0] === 0x7e && data[data.length - 1] === 0x0d) {
            const rtn = data.subarray(7, 9).toString('latin1');
            console.log(`  >> ADR ${adr} CID2=0x${c2} (${name}) RTN=${rtn}\n     ${JSON.stringify(data.toString('latin1'))}`);
          } else {
            console.log(`  ?  ADR ${adr} CID2=0x${c2} balasan bukan frame YDN1363:\n     ${hexs(data)}  |${printable(data)}|`);
          }
        }
      }
    }
  } finally {
    await link.close();
  }
  if (!any) console.log('\nTidak ada balasan sama sekali.');
}

async function cmdIdent(o) {
  const link = new Link(o.port, o.timeout, o.delay);
  try {
    await link.open(parseInt(o.baud, 10), o.parity.toUpperCase());
    const items = [
      [0x11, Buffer.alloc(0), 'Report Slave ID'],
      [0x2b, Buffer.from([0x0e, 0x01, 0x00]), 'Read Device Identification'],
    ];
    for (const [fc, pl, name] of items) {
      const data = await link.txrx(mbFrame(o.slave, fc, pl));
      const [st, val] = parseMb(data, o.slave, fc);
      const label = `FC${fc.toString(16).toUpperCase().padStart(2, '0')} ${name}: `;
      if (st === 'ok') console.log(`${label}${hexs(val)}  |${printable(val)}|`);
      else if (st === 'exc') console.log(`${label}exception ${val} (${EXC[val] || '?'})`);
      else if (st === 'bad') console.log(`${label}balasan tidak valid: ${hexs(data)}`);
      else console.log(`${label}tidak ada balasan`);
    }
  } finally {
    await link.close();
  }
}

async function cmdDump(o) {
  const link = new Link(o.port, o.timeout, o.delay);
  const rows = [];
  const fcs = o.fc.split(',').map((x) => parseInt(x, 10));

  const emit = (fc, addr, v) => {
    const s16 = v & 0x8000 ? v - 0x10000 : v;
    rows.push([fc, addr, v, s16]);
    console.log(`  FC${String(fc).padStart(2, '0')}  ${pad(addr, 5)}  0x${addr.toString(16).toUpperCase().padStart(4, '0')}   ` +
      `${pad(v, 5)}  ${pad(s16, 6)}  0x${v.toString(16).toUpperCase().padStart(4, '0')}   ` +
      `${pad((v / 10).toFixed(1), 9)}  ${pad((v / 100).toFixed(2), 9)}`);
  };

  try {
    await link.open(parseInt(o.baud, 10), o.parity.toUpperCase());
    for (const fc of fcs) {
      console.log(`\n== FC${String(fc).padStart(2, '0')} | slave ${o.slave} | ${o.baud} 8${o.parity.toUpperCase()}1 | ` +
        `register ${o.start}-${o.end} | block ${o.block}`);
      console.log('  FC     addr  addr_hex   uint    sint   hex        /10       /100');
      let addr = o.start;
      while (addr <= o.end && !stopping) {
        const qty = Math.min(o.block, o.end - addr + 1);
        const [st, vals] = await readRegs(link, o.slave, fc, addr, qty);
        if (st === 'ok') {
          vals.forEach((v, i) => emit(fc, addr + i, v));
        } else if (qty > 1) {
          for (let i = 0; i < qty && !stopping; i++) { // blok gagal -> cek satu per satu
            const [st1, v1] = await readRegs(link, o.slave, fc, addr + i, 1);
            if (st1 === 'ok') emit(fc, addr + i, v1[0]);
          }
        }
        addr += qty;
      }
    }
  } finally {
    await link.close();
  }

  if (o.csv) {
    const lines = ['fc,address,uint16,int16', ...rows.map((r) => r.join(','))];
    fs.writeFileSync(o.csv, lines.join('\n') + '\n');
    console.log(`\n${rows.length} register terbaca -> ${o.csv}`);
  } else {
    console.log(`\n${rows.length} register terbaca.`);
  }
}


// --------------------------------------------------------------------------
// Bantuan baca banyak register + pemetaan
// --------------------------------------------------------------------------
const hex4 = (n) => '0x' + n.toString(16).toUpperCase().padStart(4, '0');

/** Baca start..end dengan blok; blok gagal dicek satu-satu. Return Map(addr -> uint16). */
async function readRange(link, sid, fc, start, end, block) {
  const out = new Map();
  let addr = start;
  while (addr <= end && !stopping) {
    const qty = Math.min(block, end - addr + 1);
    const [st, vals] = await readRegs(link, sid, fc, addr, qty);
    if (st === 'ok') {
      vals.forEach((v, i) => out.set(addr + i, v));
    } else if (qty > 1) {
      for (let i = 0; i < qty && !stopping; i++) {
        const [st1, v1] = await readRegs(link, sid, fc, addr + i, 1);
        if (st1 === 'ok') out.set(addr + i, v1[0]);
      }
    }
    addr += qty;
  }
  return out;
}

/** Alamat terurut -> daftar run berurutan [[start, len], ...] */
function toRuns(addrs, maxLen) {
  const runs = [];
  for (const a of addrs) {
    const r = runs[runs.length - 1];
    if (r && a === r[0] + r[1] && r[1] < maxLen) r[1]++;
    else runs.push([a, 1]);
  }
  return runs;
}

async function readRuns(link, sid, fc, runs) {
  const out = new Map();
  for (const [start, len] of runs) {
    if (stopping) break;
    const [st, vals] = await readRegs(link, sid, fc, start, len);
    if (st === 'ok') {
      vals.forEach((v, i) => out.set(start + i, v));
    } else {
      for (let i = 0; i < len; i++) {
        const [s1, v1] = await readRegs(link, sid, fc, start + i, 1);
        if (s1 === 'ok') out.set(start + i, v1[0]);
      }
    }
  }
  return out;
}

function parseRanges(s) {
  return s.split(',').map((r) => {
    const [a, b] = r.split('-').map((x) => parseInt(x, 10));
    return [a, Number.isNaN(b) ? a : b];
  });
}

const wordsOf = (r) => (r.type === 'u32' || r.type === 's32' ? 2 : r.type === 'ascii' ? r.len || 1 : 1);
const decimalsOf = (r) => r.decimals ?? Math.max(0, Math.round(-Math.log10(r.scale ?? 1)));

function decode(r, words) {
  const t = r.type || 'u16';
  const scale = r.scale ?? 1;
  const s16 = (w) => (w & 0x8000 ? w - 0x10000 : w);
  if (t === 'u16') return words[0] * scale;
  if (t === 's16') return s16(words[0]) * scale;
  if (t === 'u32' || t === 's32') {
    let [a, b] = words;
    if (r.wordOrder === 'le') [a, b] = [b, a];
    let v = a * 65536 + b;
    if (t === 's32' && v >= 2 ** 31) v -= 2 ** 32;
    return v * scale;
  }
  if (t === 'ascii') {
    const bytes = words.flatMap((w) => [w >> 8, w & 255]);
    return Buffer.from(bytes).toString('latin1').replace(/[^\x20-\x7e]/g, '.').trim();
  }
  throw new Error(`type tidak dikenal: ${t}`);
}

// --------------------------------------------------------------------------
// watch: pantau register, tampilkan yang berubah (untuk cari arus, tegangan, dst)
// --------------------------------------------------------------------------
async function cmdWatch(o) {
  const link = new Link(o.port, o.timeout, o.delay);
  const fc = parseInt(o.fc.split(',')[0], 10);
  const first = new Map();
  const last = new Map();
  const stat = new Map();
  try {
    await link.open(parseInt(o.baud, 10), o.parity.toUpperCase());
    console.log(`Discovery register ${o.ranges} (FC${fc})...`);
    let cur = new Map();
    for (const [a, b] of parseRanges(o.ranges)) {
      for (const [k, v] of await readRange(link, o.slave, fc, a, b, o.block)) cur.set(k, v);
    }
    if (!cur.size) return console.log('Tidak ada register yang terbaca.');
    const runs = toRuns([...cur.keys()].sort((x, y) => x - y), o.block);
    console.log(`${cur.size} register aktif. Hanya perubahan yang ditampilkan. ` +
      'Ctrl+C untuk berhenti dan lihat ringkasan.\n');
    let cycle = 0;
    for (;;) {
      const t0 = now();
      for (const [k, v] of cur) {
        if (!first.has(k)) {
          first.set(k, v);
          last.set(k, v);
          stat.set(k, { min: v, max: v, changes: 0 });
          continue;
        }
        const st = stat.get(k);
        st.min = Math.min(st.min, v);
        st.max = Math.max(st.max, v);
        if (last.get(k) !== v) {
          st.changes++;
          console.log(`[${new Date().toLocaleTimeString()}] reg ${pad(k, 4)} (${hex4(k)}): ${last.get(k)} -> ${v}`);
          last.set(k, v);
        }
      }
      cycle++;
      if (stopping || (o.samples > 0 && cycle >= o.samples)) break;
      const rest = o.interval - (now() - t0);
      if (rest > 0) await sleep(rest);
      if (stopping) break;
      cur = await readRuns(link, o.slave, fc, runs);
    }
    console.log('\n=== RINGKASAN register yang berubah ===');
    const changed = [...stat].filter(([, st]) => st.changes > 0).sort((a, b) => a[0] - b[0]);
    if (!changed.length) {
      console.log('Tidak ada register yang berubah selama pemantauan.');
    } else {
      console.log('  addr  addr_hex   awal    min    max  jml_perubahan');
      for (const [k, st] of changed) {
        console.log(`  ${pad(k, 4)}  ${hex4(k)}  ${pad(first.get(k), 6)} ${pad(st.min, 6)} ${pad(st.max, 6)}  ${st.changes}`);
      }
    }
  } finally {
    await link.close();
  }
}

// --------------------------------------------------------------------------
// monitor: dashboard terminal (nama, skala, satuan dari map.json)
// --------------------------------------------------------------------------
function expandRegs(list) {
  const out = [];
  for (const r of list) {
    if (r.count > 1) {
      const step = r.stride || wordsOf(r);
      for (let i = 0; i < r.count; i++) {
        const n = String(i + 1).padStart(2, '0');
        const base = r.name || 'Reg';
        out.push({ ...r, addr: r.addr + i * step, name: base.includes('{n}') ? base.replace('{n}', n) : `${base} ${n}` });
      }
    } else {
      out.push(r);
    }
  }
  return out;
}

/** Tidur yang bisa diputus Ctrl+C */
async function nap(ms) {
  const end = now() + ms;
  while (!stopping && now() < end) await sleep(Math.min(100, end - now()));
}

async function showDeviceInfo(link, sid) {
  const tries = [
    [0x2b, Buffer.from([0x0e, 0x01, 0x00])],
    [0x11, Buffer.alloc(0)],
  ];
  for (const [fc, pl] of tries) {
    const [st, val] = parseMb(await link.txrx(mbFrame(sid, fc, pl)), sid, fc);
    if (st === 'ok') {
      console.log(`Info perangkat (FC${fc.toString(16).toUpperCase().padStart(2, '0')}): ${printable(val)}`);
      await nap(1500);
      return;
    }
  }
  console.log('Info perangkat: tidak tersedia');
}

function renderDash(o, res, extra, prevExtra, clear) {
  if (clear) console.clear();
  const par = o.parity.toUpperCase();
  console.log(`Port ${o.port} | ${o.baud} bps 8${par}1 | Slave ${o.slave} | ${new Date().toLocaleTimeString()}`);
  console.log(`Map: ${o.map} | refresh ${o.interval > 0 ? `${o.interval} ms` : 'sekali'}\n`);

  const rowOf = ({ r, st, val }) => {
    if (st !== 'ok') return { Nilai: `tidak terbaca${st === 'exc' ? ` (exc ${val})` : ''}`, Reg: r.addr, Raw: '-' };
    const d = decode(r, val);
    const nilai = typeof d === 'number' ? `${d.toFixed(decimalsOf(r))} ${r.unit || ''}`.trim() : `"${d}"`;
    return { Nilai: nilai, Reg: r.addr, Raw: val.join(',') };
  };

  // tabel per grup; yang terverifikasi di atas, kandidat dipisah
  const groups = new Map();
  for (const x of res) {
    const key = `${x.r.verified ? 1 : 0}|${x.r.group || 'Ringkasan'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(x);
  }
  const keys = [...groups.keys()].sort((a, b) => Number(b[0]) - Number(a[0]));
  for (const key of keys) {
    const ver = key[0] === '1';
    const name = key.slice(2);
    console.log(ver ? `${name}:` : `${name} - KANDIDAT, belum terverifikasi:`);
    const rows = {};
    for (const x of groups.get(key)) rows[x.r.name || `Reg ${x.r.addr}`] = rowOf(x);
    console.table(rows);
  }

  // nilai turunan (hanya kalau role-nya ada di map)
  const byRole = (role) => res.filter((x) => x.r.role === role && x.st === 'ok').map((x) => ({ ...x, v: decode(x.r, x.val) }));
  const q = (...xs) => (xs.some((x) => !x.r.verified) ? ' ?' : '');
  const derived = {};
  const [vv] = byRole('voltage');
  const [aa] = byRole('current');
  if (vv && aa && vv.r.unit === 'V' && aa.r.unit === 'A') {
    derived[`Daya (W)${q(vv, aa)}`] = { Nilai: (vv.v * aa.v).toFixed(1) };
  }
  const [rem] = byRole('remain');
  const [tot] = byRole('total');
  if (rem && tot && tot.v > 0 && rem.r.unit === tot.r.unit) {
    derived[`SOC hitung (%)${q(rem, tot)}`] = { Nilai: ((rem.v / tot.v) * 100).toFixed(1) };
  }
  const cells = byRole('cell');
  if (cells.length > 1) {
    const vals = cells.map((c) => c.v);
    const cmin = Math.min(...vals);
    const cmax = Math.max(...vals);
    const u = cells[0].r.unit || '';
    const f = (x) => x.toFixed(decimalsOf(cells[0].r));
    derived[`Sel min (${u})${q(...cells)}`] = { Nilai: `${f(cmin)} (sel ${vals.indexOf(cmin) + 1})` };
    derived[`Sel max (${u})${q(...cells)}`] = { Nilai: `${f(cmax)} (sel ${vals.indexOf(cmax) + 1})` };
    derived[`Selisih sel (${u})${q(...cells)}`] = { Nilai: f(cmax - cmin) };
  }
  if (Object.keys(derived).length) {
    console.log('Turunan:');
    console.table(derived);
  }

  // register lain yang aktif tapi belum ada di map
  if (extra.size) {
    console.log('Register aktif lain (belum diketahui artinya, * = berubah sejak refresh sebelumnya):');
    const items = [...extra].sort((a, b) => a[0] - b[0]).map(([k, v]) => {
      const ch = prevExtra.has(k) && prevExtra.get(k) !== v ? '*' : ' ';
      return `${String(k).padStart(4)}=${String(v).padEnd(5)}${ch}`;
    });
    for (let i = 0; i < items.length; i += 6) console.log('  ' + items.slice(i, i + 6).join('  '));
  }
  console.log('\nTekan Ctrl+C untuk berhenti.');
}

async function cmdMonitor(o) {
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(o.map, 'utf8'));
  } catch (e) {
    die(`Gagal membaca ${o.map}: ${e.message}`);
  }
  const regs = expandRegs(cfg.registers || []);
  if (!regs.length) die(`${o.map} tidak punya entri "registers"`);
  const mapped = new Set();
  for (const r of regs) {
    if ((r.fc || 3) === 3) for (let i = 0; i < wordsOf(r); i++) mapped.add(r.addr + i);
  }
  const link = new Link(o.port, o.timeout, o.delay);
  const par = o.parity.toUpperCase();
  const clear = process.stdout.isTTY && !o.noClear;
  const prevExtra = new Map();
  let extraRuns = null;
  try {
    await link.open(parseInt(o.baud, 10), par);
    console.log(`Terhubung ke ${o.port} @ ${o.baud} bps 8${par}1`);
    await showDeviceInfo(link, o.slave);
    if (o.all) {
      console.log(`Mencari register aktif ${o.ranges} (sekali saja, bisa agak lama)...`);
      const found = new Map();
      for (const [a, b] of parseRanges(o.ranges)) {
        for (const [k, v] of await readRange(link, o.slave, 3, a, b, o.block)) found.set(k, v);
      }
      const addrs = [...found.keys()].filter((k) => !mapped.has(k)).sort((x, y) => x - y);
      extraRuns = toRuns(addrs, o.block);
    }
    while (!stopping) {
      const t0 = now();
      const res = [];
      for (const r of regs) {
        if (stopping) break;
        const [st, val] = await readRegs(link, o.slave, r.fc || 3, r.addr, wordsOf(r));
        res.push({ r, st, val });
      }
      const extra = extraRuns ? await readRuns(link, o.slave, 3, extraRuns) : new Map();
      if (stopping) break;
      renderDash(o, res, extra, prevExtra, clear);
      for (const [k, v] of extra) prevExtra.set(k, v);
      if (!(o.interval > 0)) break;
      await nap(Math.max(0, o.interval - (now() - t0)));
    }
  } finally {
    await link.close();
  }
}

// --------------------------------------------------------------------------
// find: cocokkan nilai asli (dari display/BMS) ke register di file CSV hasil dump
// --------------------------------------------------------------------------
function cmdFind(o) {
  if (!o.csv) die('Butuh --csv reg.csv (hasil dump)');
  if (!o.valueStrs.length || o.valueStrs.some((x) => Number.isNaN(Number(x)))) {
    die('Butuh --value <angka> (boleh diulang), mis. --value 51.7 --value 66');
  }
  let text;
  try {
    text = fs.readFileSync(o.csv, 'utf8');
  } catch (e) {
    die(`Gagal membaca ${o.csv}: ${e.message}`);
  }
  const byFc = new Map();
  for (const line of text.trim().split(/\r?\n/).slice(1)) {
    const [fc, addr, u] = line.split(',').map(Number);
    if (!byFc.has(fc)) byFc.set(fc, new Map());
    byFc.get(fc).set(addr, u);
  }
  const scales = [1, 0.1, 0.01, 0.001];
  const kindRank = { u16: 0, s16: 1, u32: 2, 'u32-swap': 3 };
  for (const str of o.valueStrs) {
    const target = Number(str);
    const dec = (str.split('.')[1] || '').length;
    const unit = 10 ** -dec;
    const tol = unit * o.tol;
    const hits = [];
    for (const [fc, m] of byFc) {
      for (const [addr, u] of m) {
        const cands = [['u16', u]];
        if (u & 0x8000) cands.push(['s16', u - 0x10000]);
        if (m.has(addr + 1)) {
          const w = m.get(addr + 1);
          if (u > 0) cands.push(['u32', u * 65536 + w]);
          if (w > 0) cands.push(['u32-swap', w * 65536 + u]);
        }
        for (const [kind, raw] of cands) {
          if (raw === 0 && target !== 0) continue;
          for (const sc of scales) {
            const val = raw * sc;
            const diff = Math.abs(val - target);
            if (diff <= tol + 1e-9) hits.push({ fc, addr, kind, sc, raw, val, diff });
          }
        }
      }
    }
    hits.sort((a, b) => a.diff - b.diff || kindRank[a.kind] - kindRank[b.kind] || b.sc - a.sc || a.addr - b.addr);
    console.log(`\nNilai ${str} (toleransi ±${tol.toFixed(dec + 1)}): ${hits.length} kandidat`);
    for (const h of hits.slice(0, 12)) {
      console.log(`  FC${String(h.fc).padStart(2, '0')} reg ${pad(h.addr, 4)} (${hex4(h.addr)}) ${h.kind.padEnd(8)} ` +
        `raw ${h.raw} x${h.sc} = ${h.val.toFixed(Math.max(dec, 3))}`);
    }
    if (hits.length > 12) console.log(`  ... dan ${hits.length - 12} lagi (persempit dengan --tol 0.5 atau nilai lebih presisi)`);
  }
  console.log('\nCatatan: kecocokan angka belum tentu benar. Ambil beberapa nilai berbeda / kondisi berbeda untuk memastikan.');
}

// --------------------------------------------------------------------------
const HELP = `Pemindai RS485 read-only untuk Huawei ESM-48100B1

Pemakaian: node esm_scan.js [-p PORT] [--timeout MS] <perintah> [opsi]

  ports                       daftar port serial
  scan   [--baud 9600|all|a,b] [--parity N,E,O] [--id-min 1] [--id-max 247]
         [--probe-addr 0] [--fast] [--all-combos]
  yd     [--baud] [--parity] [--adr-min 0] [--adr-max 15] [--cid1 0x46] [--ver 0x20]
  ident  --slave N [--baud 9600] [--parity N]
  dump   --slave N [--baud 9600] [--parity N] [--fc 3,4] [--start 0] [--end 300]
         [--block 16] [--csv file.csv]
  watch  --slave N [--ranges 64-80,256-300] [--interval 1000] [--samples 0] [--fc 3]
         tampilkan hanya register yang berubah (Ctrl+C = ringkasan)
  monitor --slave N [--map map.json] [--interval 1000] [--all] [--ranges 0-300] [--no-clear]
         dashboard live: nilai bernama dari map.json; --interval 0 = baca sekali;
         --all = tampilkan juga register aktif lain yang belum ada di map
  find   --csv reg.csv --value 51.7 [--value 66 ...] [--tol 1]
         cari register yang cocok dengan nilai asli (tanpa -p, offline)

Opsi umum: --timeout ms (default 150; yd 400), --delay ms jeda antar request (default 0).`;

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        port: { type: 'string', short: 'p' },
        timeout: { type: 'string' },
        baud: { type: 'string' },
        parity: { type: 'string' },
        'id-min': { type: 'string' },
        'id-max': { type: 'string' },
        'probe-addr': { type: 'string' },
        fast: { type: 'boolean' },
        'all-combos': { type: 'boolean' },
        'adr-min': { type: 'string' },
        'adr-max': { type: 'string' },
        cid1: { type: 'string' },
        ver: { type: 'string' },
        slave: { type: 'string' },
        fc: { type: 'string' },
        start: { type: 'string' },
        end: { type: 'string' },
        block: { type: 'string' },
        csv: { type: 'string' },
        delay: { type: 'string' },
        map: { type: 'string' },
        interval: { type: 'string' },
        samples: { type: 'string' },
        ranges: { type: 'string' },
        value: { type: 'string', multiple: true },
        tol: { type: 'string' },
        all: { type: 'boolean' },
        'no-clear': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (e) {
    die(`${e.message}\n\n${HELP}`);
  }
  const v = parsed.values;
  const cmd = parsed.positionals[0];
  if (v.help || !cmd) return console.log(HELP);
  if (cmd !== 'ports' && cmd !== 'find' && !v.port) die('Butuh -p/--port (lihat: node esm_scan.js ports)');

  const int = (x, d) => (x === undefined ? d : parseInt(x, 10));
  const o = {
    port: v.port,
    timeout: int(v.timeout, cmd === 'yd' ? 400 : 150),
    baud: v.baud || '9600',
    parity: v.parity || (cmd === 'scan' || cmd === 'yd' ? 'N,E,O' : 'N'),
    idMin: int(v['id-min'], 1),
    idMax: int(v['id-max'], 247),
    probeAddr: int(v['probe-addr'], 0),
    fast: !!v.fast,
    allCombos: !!v['all-combos'],
    adrMin: int(v['adr-min'], 0),
    adrMax: int(v['adr-max'], 15),
    cid1: v.cid1 || '0x46',
    ver: v.ver || '0x20',
    slave: int(v.slave, NaN),
    fc: v.fc || '3,4',
    start: int(v.start, 0),
    end: int(v.end, 300),
    block: int(v.block, 16),
    csv: v.csv,
    delay: int(v.delay, 0),
    map: v.map || 'map.json',
    interval: int(v.interval, cmd === 'watch' || cmd === 'monitor' ? 1000 : 0),
    samples: int(v.samples, 0),
    ranges: v.ranges || '0-300',
    valueStrs: v.value || [],
    tol: v.tol === undefined ? 1 : Number(v.tol),
    all: !!v.all,
    noClear: !!v['no-clear'],
  };

  if (['ident', 'dump', 'watch', 'monitor'].includes(cmd) && Number.isNaN(o.slave)) die('Butuh --slave N');
  if (cmd === 'dump' && !(o.block >= 1 && o.block <= 100)) die('--block harus 1-100');

  const table = {
    ports: cmdPorts, scan: cmdScan, yd: cmdYd, ident: cmdIdent, dump: cmdDump,
    watch: cmdWatch, monitor: cmdMonitor, find: cmdFind,
  };
  if (!table[cmd]) die(`Perintah tidak dikenal: ${cmd}\n\n${HELP}`);
  await table[cmd](o);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  });
} else {
  module.exports = { crc16, mbFrame, ydFrame };
}
