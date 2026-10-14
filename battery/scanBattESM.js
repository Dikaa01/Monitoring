const { SerialPort } = require("serialport");

// Pemakaian:
//   node scanBatt.js                      -> scan semua port COM yang terdeteksi
//   node scanBatt.js --port COM4          -> scan satu port
//   node scanBatt.js --port COM3,COM4     -> scan beberapa port
// Opsi:
//   --bauds 9600,19200,115200   daftar baudrate (default: 9600,19200,115200,38400,4800)
//   --adrs 0-15                 daftar alamat, mis. "0-3" atau "0,1,2" (default 0-15)
//   --wait 300                  waktu tunggu balasan (ms)
//   --deep                      coba juga versi protokol lain (25,28,29,2A,21,22,26)
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith("--")) {
      const next = arr[i + 1];
      acc.push([cur.slice(2), next && !next.startsWith("--") ? next : true]);
    }
    return acc;
  }, [])
);

const BAUDS = args.bauds && args.bauds !== true
  ? String(args.bauds).split(",").map(Number)
  : [9600, 19200, 115200, 38400, 4800];

function parseRange(s, dflt) {
  if (!s || s === true) return dflt;
  const out = [];
  for (const part of String(s).split(",")) {
    if (part.includes("-")) {
      const [a, b] = part.split("-").map(Number);
      for (let i = a; i <= b; i++) out.push(i);
    } else out.push(Number(part));
  }
  return out;
}
const ADRS = parseRange(args.adrs, Array.from({ length: 16 }, (_, i) => i));
const WAIT = parseInt(args.wait || 800);
const DEEP = args.deep === true || args.deep === "true";
const VERS = DEEP ? ["20", "25", "28", "29", "2A", "21", "22", "26"] : ["20"];
const MODBUS_IDS = parseRange(args.mbids, [1, 2, 3, 4, 5]);
const MB_FCS = parseRange(args.mbfcs, [3]);
const MB_REGS = parseRange(args.mbregs, [0]); // boleh hex, mis. 0,0x1000
const MB_WAIT = parseInt(args.mbwait || 400);
const NO_ASCII = args.noascii === true || args.noascii === "true";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const H2 = (n) => n.toString(16).toUpperCase().padStart(2, "0");

// ---------- ASCII (gaya Pylontech) ----------
function buildFrame(ver, adr, cid2, info = "") {
  const lenid = info.length;
  const s = (lenid & 0xf) + ((lenid >> 4) & 0xf) + ((lenid >> 8) & 0xf);
  const lchk = (~(s % 16) + 1) & 0xf;
  const lenField = ((lchk << 12) | lenid).toString(16).toUpperCase().padStart(4, "0");
  const body = ver + H2(adr) + "46" + cid2 + lenField + info;
  let sum = 0;
  for (const ch of body) sum += ch.charCodeAt(0);
  const chk = (~(sum % 65536) + 1) & 0xffff;
  return "~" + body + chk.toString(16).toUpperCase().padStart(4, "0") + "\r";
}

function parseAscii(buf) {
  const str = buf.toString("latin1");
  const start = str.indexOf("~");
  if (start < 0) return null;
  const end = str.indexOf("\r", start);
  if (end < 0) return null;
  const s = str.slice(start, end);
  if (s.length < 17) return null;
  const body = s.slice(1, -4);
  let sum = 0;
  for (const ch of body) sum += ch.charCodeAt(0);
  const chkCalc = ((~(sum % 65536) + 1) & 0xffff).toString(16).toUpperCase().padStart(4, "0");
  if (!/^[0-9A-F]+$/i.test(body)) return null;
  return {
    ver: body.slice(0, 2),
    adr: body.slice(2, 4),
    cid1: body.slice(4, 6),
    rtn: body.slice(6, 8),
    info: Buffer.from(body.slice(12).length % 2 === 0 ? body.slice(12) : "", "hex"),
    chkOk: s.slice(-4).toUpperCase() === chkCalc,
  };
}

function tryDecodeAnalog(b) {
  try {
    let o = 0;
    const dataFlag = b[o++];
    const packNo = b[o++];
    const nCell = b[o++];
    if (nCell < 1 || nCell > 32) return null;
    const cells = [];
    for (let i = 0; i < nCell; i++) { cells.push(b.readUInt16BE(o)); o += 2; }
    const nTemp = b[o++];
    if (nTemp > 16) return null;
    const temps = [];
    for (let i = 0; i < nTemp; i++) { temps.push((b.readUInt16BE(o) - 2731) / 10); o += 2; }
    const current = b.readInt16BE(o) / 100; o += 2;
    const voltage = b.readUInt16BE(o) / 100; o += 2;
    const remain = b.readUInt16BE(o) / 100; o += 2;
    const userN = b[o++];
    const total = b.readUInt16BE(o) / 100; o += 2;
    const cycles = b.readUInt16BE(o); o += 2;
    const sumCells = cells.reduce((a, c) => a + c, 0) / 1000;
    return { dataFlag, packNo, nCell, cells, temps, current, voltage, remain, userN, total, cycles, extra: b.subarray(o), sumCells };
  } catch {
    return null;
  }
}

// ---------- Modbus RTU ----------
function crc16(buf) {
  let crc = 0xffff;
  for (const b of buf) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >> 1) ^ 0xa001 : crc >> 1;
  }
  return crc;
}
function modbusReq(id, fc, addr, count) {
  const b = Buffer.from([id, fc, addr >> 8, addr & 0xff, count >> 8, count & 0xff]);
  const c = crc16(b);
  return Buffer.concat([b, Buffer.from([c & 0xff, c >> 8])]);
}
function modbusResp(buf, id) {
  if (buf.length < 5 || buf[0] !== id) return null;
  const len = buf[1] & 0x80 ? 5 : 3 + buf[2] + 2;
  if (buf.length < len) return null;
  const f = buf.subarray(0, len);
  return crc16(f.subarray(0, len - 2)) === f.readUInt16LE(len - 2) ? f : null;
}

// ---------- Serial ----------
async function openLink(path, baud) {
  const p = await new Promise((res, rej) => {
    const sp = new SerialPort({ path, baudRate: baud, dataBits: 8, parity: "none", stopBits: 1, autoOpen: false });
    sp.open((e) => (e ? rej(e) : res(sp)));
  });
  const link = { p, rx: Buffer.alloc(0) };
  p.on("data", (d) => (link.rx = Buffer.concat([link.rx, d])));
  return link;
}
const closeLink = (link) => new Promise((r) => (link.p.isOpen ? link.p.close(() => r()) : r()));

async function ask(link, data, wait = WAIT) {
  link.rx = Buffer.alloc(0);
  link.p.write(data);
  const t0 = Date.now();
  while (Date.now() - t0 < wait) {
    await sleep(20);
    const i = link.rx.indexOf(0x7e);
    if (i >= 0 && link.rx.indexOf(0x0d, i) >= 0) { await sleep(30); break; }
  }
  return link.rx;
}

// ---------- Pemeriksaan rinci setelah ada respons ASCII ----------
async function inspectAscii(link, res) {
  const { adr, ver } = res;
  const infos = [...new Set(["01", "00", "02", H2(adr), "FF"])];
  for (const info of infos) {
    const r = parseAscii(await ask(link, buildFrame(ver, adr, "42", info), 800));
    if (r && r.chkOk && r.rtn === "00" && r.info.length) {
      res.pack = info;
      console.log(`   Data analog OK dengan INFO=${info} (${r.info.length} byte)`);
      const d = tryDecodeAnalog(r.info);
      if (d) {
        console.log(`   Sel: ${d.nCell} | Tegangan pack: ${d.voltage.toFixed(2)} V (jumlah sel ${d.sumCells.toFixed(2)} V)`);
        console.log(`   Arus: ${d.current.toFixed(2)} A | Sisa/Total: ${d.remain.toFixed(2)}/${d.total.toFixed(2)} Ah | Siklus: ${d.cycles}`);
        console.log(`   Suhu: ${d.temps.map((t) => t.toFixed(1)).join(", ")} °C`);
        if (d.extra.length) console.log(`   Field tambahan: ${d.extra.toString("hex").toUpperCase()}`);
        const ok = Math.abs(d.sumCells - d.voltage) < 0.5;
        res.decoded = ok;
        console.log(ok
          ? "   Susunan data cocok dengan readBatt3.js (tegangan pack = jumlah sel)."
          : "   PERHATIAN: tegangan pack tidak cocok dengan jumlah sel, susunan data mungkin berbeda.");
      } else {
        console.log(`   Susunan data berbeda dari dugaan. INFO mentah: ${r.info.toString("hex").toUpperCase()}`);
      }
      break;
    }
    console.log(`   INFO ${info}: ${r ? "RTN " + r.rtn : "tidak ada balasan"}`);
  }
  const d51 = parseAscii(await ask(link, buildFrame(ver, adr, "51"), 800));
  if (d51 && d51.chkOk && d51.info.length) {
    console.log(`   Info pabrikan: ${d51.info.toString("latin1").replace(/[^\x20-\x7e]/g, ".")}`);
  }
}

// ---------- Scan satu port ----------
async function scanPort(path) {
  const results = [];
  console.log(`\n=== ${path} ===`);
  for (const baud of BAUDS) {
    let link;
    try {
      link = await openLink(path, baud);
    } catch (e) {
      console.log(`Gagal membuka ${path}: ${e.message}`);
      return results;
    }
    let hitHere = false;

    for (const adr of NO_ASCII ? [] : ADRS) {
      process.stdout.write(`\r${path} @ ${baud} bps, ASCII alamat ${adr}     `);
      let hit = null;
      for (const ver of VERS) {
        let r = parseAscii(await ask(link, buildFrame(ver, adr, "4F")));
        if (!r) r = parseAscii(await ask(link, buildFrame(ver, adr, "42", "01")));
        if (r) { hit = r; break; }
      }
      if (hit) {
        hitHere = true;
        console.log(`\n✔ ASCII terdeteksi: ${path}, ${baud} bps, alamat ${adr}, versi protokol ${hit.ver}, checksum ${hit.chkOk ? "OK" : "SALAH"}, RTN ${hit.rtn}`);
        const res = { path, type: "ascii", baud, adr, ver: hit.ver, pack: null };
        await inspectAscii(link, res);
        results.push(res);
      }
    }

    for (const id of MODBUS_IDS) {
      let idHit = false;
      for (const fc of MB_FCS) {
        for (const reg of MB_REGS) {
          process.stdout.write(`\r${path} @ ${baud} bps, Modbus ID ${id} FC${fc} reg 0x${reg.toString(16)}     `);
          const f = modbusResp(await ask(link, modbusReq(id, fc, reg, 1), MB_WAIT), id);
          if (f) {
            const exc = f[1] & 0x80;
            console.log(
              `\n✔ Modbus terdeteksi: ${path}, ${baud} bps, ID ${id}, FC${fc}, reg 0x${reg.toString(16).toUpperCase()}` +
                (exc ? ` (balasan exception kode ${f[2]}, protokol tetap Modbus)` : ` (nilai ${f.readUInt16BE(3)})`)
            );
            if (!idHit) results.push({ path, type: "modbus", baud, id, fc, reg, exc: !!exc });
            idHit = true;
            hitHere = true;
          }
        }
      }
    }

    await closeLink(link);
    if (hitHere) break; // baudrate sudah ketemu, tidak perlu mencoba baudrate lain
  }
  process.stdout.write("\r" + " ".repeat(60) + "\r");
  return results;
}

(async () => {
  let ports;
  if (args.port && args.port !== true) ports = String(args.port).split(",");
  else ports = (await SerialPort.list()).map((p) => p.path);

  if (!ports.length) { console.log("Tidak ada port serial terdeteksi."); return; }
  console.log(`Port yang akan di-scan: ${ports.join(", ")}`);
  console.log(`Baudrate: ${BAUDS.join(", ")} | Alamat: ${ADRS[0]}..${ADRS[ADRS.length - 1]} | Versi: ${VERS.join(", ")}`);
  console.log("Scan bisa memakan waktu beberapa menit per port. Tekan Ctrl+C untuk berhenti.");

  const all = [];
  for (const path of ports) all.push(...(await scanPort(path)));

  console.log("\n\n========== RINGKASAN ==========");
  if (!all.length) {
    console.log("Tidak ada respons dari port mana pun.");
    console.log("Cek: 1) kabel ke port RJ45 berlabel RS485 (bukan CAN), 2) tukar kabel A dan B,");
    console.log("     3) baterai menyala, 4) GND tersambung, 5) coba --deep, 6) coba --adrs 0-31.");
    process.exit(0);
  }
  for (const r of all) {
    if (r.type === "ascii") {
      console.log(`\n[ASCII] ${r.path} | ${r.baud} bps | alamat ${r.adr} | versi ${r.ver} | INFO pack ${r.pack ?? "belum ketemu"}`);
      console.log(`  Jalankan: node readBatt3.js --port ${r.path} --baud ${r.baud} --adr ${r.adr} --ver ${r.ver} --pack ${r.pack ? parseInt(r.pack, 16) : 1}`);
      if (r.decoded === false) console.log("  (readBatt3.js mungkin menampilkan angka yang keliru, kirim keluaran scan ini ke Claude untuk disesuaikan)");
    } else {
      console.log(`\n[Modbus] ${r.path} | ${r.baud} bps | ID ${r.id} | FC${r.fc} | reg 0x${r.reg.toString(16).toUpperCase()}${r.exc ? " (exception)" : ""}`);
      console.log(`  Jalankan: node readBatt.js --port ${r.path} --baud ${r.baud} --id ${r.id} --start ${r.reg} --count 20 --fc ${r.fc}`);
    }
  }
  process.exit(0);
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});