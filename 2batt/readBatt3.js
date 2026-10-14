const { SerialPort } = require("serialport");

// Contoh: node readBatt3.js --port COM4
// Opsional: --baud 19200 --adr 0 --ver 29 --pack 1 --interval 2000 --raw
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith("--")) acc.push([cur.slice(2), arr[i + 1] ?? true]);
    return acc;
  }, [])
);

const PORT = args.port || "COM4";
const BAUD = parseInt(args.baud || 19200);
const ADR = parseInt(args.adr || 0);
const VER = String(args.ver || "29").toUpperCase();
const PACK = parseInt(args.pack || 1);
const INTERVAL = parseInt(args.interval || 2000);
const SHOW_RAW = args.raw === true || args.raw === "true";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const H2 = (n) => n.toString(16).toUpperCase().padStart(2, "0");

function buildFrame(cid2, info = "") {
  const lenid = info.length;
  const s = (lenid & 0xf) + ((lenid >> 4) & 0xf) + ((lenid >> 8) & 0xf);
  const lchk = (~(s % 16) + 1) & 0xf;
  const lenField = ((lchk << 12) | lenid).toString(16).toUpperCase().padStart(4, "0");
  const body = VER + H2(ADR) + "46" + cid2 + lenField + info;
  let sum = 0;
  for (const ch of body) sum += ch.charCodeAt(0);
  const chk = (~(sum % 65536) + 1) & 0xffff;
  return "~" + body + chk.toString(16).toUpperCase().padStart(4, "0") + "\r";
}

function parseFrame(str) {
  const start = str.indexOf("~");
  const end = str.indexOf("\r", start);
  if (start < 0 || end < 0) throw new Error("Frame tidak lengkap");
  const s = str.slice(start, end);
  if (s.length < 17) throw new Error("Frame terlalu pendek");
  const body = s.slice(1, -4);
  const chkRx = s.slice(-4);
  let sum = 0;
  for (const ch of body) sum += ch.charCodeAt(0);
  const chkCalc = ((~(sum % 65536) + 1) & 0xffff).toString(16).toUpperCase().padStart(4, "0");
  if (chkRx !== chkCalc) throw new Error("Checksum salah");
  const rtn = body.slice(6, 8);
  if (rtn !== "00") throw new Error("Baterai membalas RTN " + rtn);
  return Buffer.from(body.slice(12), "hex");
}

let port;
let rx = "";

function openPort() {
  return new Promise((resolve, reject) => {
    const p = new SerialPort({ path: PORT, baudRate: BAUD, dataBits: 8, parity: "none", stopBits: 1, autoOpen: false });
    p.open((err) => (err ? reject(err) : resolve(p)));
  });
}

async function request(frame, timeout = 1000) {
  rx = "";
  port.write(frame);
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const i = rx.indexOf("~");
    if (i >= 0 && rx.indexOf("\r", i) >= 0) return rx;
    await sleep(20);
  }
  throw new Error("Timeout (tidak ada balasan)");
}

function decodeAnalog(b) {
  let o = 0;
  const dataFlag = b[o++];
  const packNo = b[o++];
  const nCell = b[o++];
  const cells = [];
  for (let i = 0; i < nCell; i++) { cells.push(b.readUInt16BE(o)); o += 2; }
  const nTemp = b[o++];
  const temps = [];
  for (let i = 0; i < nTemp; i++) { temps.push((b.readUInt16BE(o) - 2731) / 10); o += 2; }
  const current = b.readInt16BE(o) / 100; o += 2;   // A (asumsi satuan 10 mA)
  const voltage = b.readUInt16BE(o) / 100; o += 2;  // V (10 mV)
  const remain = b.readUInt16BE(o) / 100; o += 2;   // Ah (10 mAh)
  const userN = b[o++];
  const total = b.readUInt16BE(o) / 100; o += 2;    // Ah
  const cycles = b.readUInt16BE(o); o += 2;
  const extra = b.subarray(o);
  return { dataFlag, packNo, cells, temps, current, voltage, remain, userN, total, cycles, extra };
}

function render(d, rawHex) {
  console.clear();
  console.log(`Port ${PORT} | ${BAUD} bps | ADR ${ADR} | Pack ${PACK} | ${new Date().toLocaleTimeString()}\n`);

  const cmin = Math.min(...d.cells);
  const cmax = Math.max(...d.cells);
  const soc = d.total > 0 ? (d.remain / d.total) * 100 : NaN;

  console.table({
    "Tegangan pack (V)": d.voltage.toFixed(2),
    "Arus (A)": d.current.toFixed(2),
    "Kapasitas sisa (Ah)": d.remain.toFixed(2),
    "Kapasitas total (Ah)": d.total.toFixed(2),
    "SOC hitung (%)": soc.toFixed(1),
    "Jumlah siklus": d.cycles,
    "Sel min (mV)": `${cmin} (sel ${d.cells.indexOf(cmin) + 1})`,
    "Sel max (mV)": `${cmax} (sel ${d.cells.indexOf(cmax) + 1})`,
    "Selisih sel (mV)": cmax - cmin,
  });

  console.log("Tegangan tiap sel (mV):");
  console.table(
    Object.fromEntries(d.cells.map((v, i) => ["Sel " + String(i + 1).padStart(2, "0"), v]))
  );

  console.log("Suhu (°C):");
  console.table(
    Object.fromEntries(d.temps.map((v, i) => ["T" + (i + 1), v.toFixed(1)]))
  );

  if (d.extra.length) {
    const words = [];
    for (let i = 0; i + 1 < d.extra.length; i += 2) words.push(d.extra.readUInt16BE(i));
    console.log(`Field tambahan (belum diketahui artinya): ${d.extra.toString("hex").toUpperCase()}  -> ${words.join(", ")}`);
  }
  if (SHOW_RAW) console.log(`\nINFO mentah: ${rawHex}`);
  console.log("\nTekan Ctrl+C untuk berhenti.");
}

async function showDeviceInfo() {
  try {
    const raw = await request(buildFrame("51"));
    const b = parseFrame(raw);
    console.log("Info pabrikan:", b.toString("latin1").replace(/[^\x20-\x7e]/g, "."));
    await sleep(1500);
  } catch (e) {
    console.log("Info pabrikan: tidak tersedia (" + e.message + ")");
  }
}

async function main() {
  port = await openPort();
  port.on("data", (d) => (rx += d.toString("latin1")));

  console.log(`Terhubung ke ${PORT} @ ${BAUD} bps`);
  await showDeviceInfo();

  const frame = buildFrame("42", H2(PACK));
  while (true) {
    try {
      const raw = await request(frame);
      const b = parseFrame(raw);
      render(decodeAnalog(b), b.toString("hex").toUpperCase());
    } catch (e) {
      console.error("Gagal baca:", e.message || e);
    }
    await sleep(INTERVAL);
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});