const { SerialPort } = require("serialport");

// Contoh: node probe-battery.js --port COM4
//         node probe-battery.js --port COM4 --listen 15   (hanya mendengarkan 15 detik)
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith("--")) acc.push([cur.slice(2), arr[i + 1] ?? true]);
    return acc;
  }, [])
);

const PORT = args.port || "COM4";
const LISTEN = args.listen ? parseInt(args.listen) : 0;
const BAUDS = args.baud ? [parseInt(args.baud)] : [9600, 19200, 115200, 38400];
const ADDRS = args.adr ? [parseInt(args.adr)] : [0, 1, 2, 3, 4, 5, 15];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const H2 = (n) => n.toString(16).toUpperCase().padStart(2, "0");

// Frame gaya Pylontech: ~ VER ADR CID1 CID2 LENGTH INFO CHKSUM \r
function buildFrame(adr, cid2, info = "") {
  const ver = "20";
  const cid1 = "46";
  const lenid = info.length;
  const s = (lenid & 0xf) + ((lenid >> 4) & 0xf) + ((lenid >> 8) & 0xf);
  const lchk = (~(s % 16) + 1) & 0xf;
  const lenField = ((lchk << 12) | lenid).toString(16).toUpperCase().padStart(4, "0");
  const body = ver + H2(adr) + cid1 + cid2 + lenField + info;
  let sum = 0;
  for (const ch of body) sum += ch.charCodeAt(0);
  const chk = (~(sum % 65536) + 1) & 0xffff;
  return "~" + body + chk.toString(16).toUpperCase().padStart(4, "0") + "\r";
}

function show(buf) {
  const printable = buf.toString("latin1").replace(/[^\x20-\x7e]/g, ".");
  console.log(`   HEX  : ${buf.toString("hex").toUpperCase().match(/.{1,2}/g).join(" ")}`);
  console.log(`   ASCII: ${printable}`);
}

function openPort(baud) {
  return new Promise((resolve, reject) => {
    const p = new SerialPort({ path: PORT, baudRate: baud, dataBits: 8, parity: "none", stopBits: 1, autoOpen: false });
    p.open((err) => (err ? reject(err) : resolve(p)));
  });
}
const closePort = (p) => new Promise((r) => (p.isOpen ? p.close(() => r()) : r()));

async function listen(baud, seconds) {
  const p = await openPort(baud);
  console.log(`Mendengarkan ${PORT} @ ${baud} bps selama ${seconds} detik...`);
  p.on("data", (d) => { console.log(`[${new Date().toLocaleTimeString()}] ${d.length} byte`); show(d); });
  await sleep(seconds * 1000);
  await closePort(p);
}

async function probe() {
  let found = false;
  for (const baud of BAUDS) {
    let p;
    try { p = await openPort(baud); }
    catch (e) { console.error(`Gagal buka ${PORT}: ${e.message}`); return; }

    let rx = Buffer.alloc(0);
    p.on("data", (d) => (rx = Buffer.concat([rx, d])));

    for (const adr of ADDRS) {
      const cmds = [
        ["4F (versi protokol)", buildFrame(adr, "4F")],
        ["42 (data analog)", buildFrame(adr, "42", H2(adr))],
      ];
      for (const [name, frame] of cmds) {
        rx = Buffer.alloc(0);
        p.write(frame);
        await sleep(500);
        if (rx.length) {
          found = true;
          console.log(`\n✔ RESPON! baud ${baud}, ADR ${adr}, perintah ${name}`);
          console.log(`   Kirim : ${frame.trim()}`);
          show(rx);
        } else {
          process.stdout.write(`. baud ${baud} adr ${adr} cmd ${name}      \r`);
        }
      }
    }
    await closePort(p);
  }
  console.log(found ? "\nSelesai. Ada respons di atas." : "\nSelesai. Tidak ada respons sama sekali.");
}

(async () => {
  try {
    if (LISTEN) await listen(parseInt(args.baud || 9600), LISTEN);
    else await probe();
  } catch (e) {
    console.error(e.message || e);
  }
  process.exit(0);
})();