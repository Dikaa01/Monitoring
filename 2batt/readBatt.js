const ModbusRTU = require("modbus-serial");
const { SerialPort } = require("serialport");

// ===== KONFIGURASI (bisa di-override lewat argumen CLI) =====
// Contoh: node read-battery.js --port COM3 --baud 9600 --id 1 --start 0 --count 20 --fc 3
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith("--")) acc.push([cur.slice(2), arr[i + 1] ?? true]);
    return acc;
  }, [])
);

const cfg = {
  port: args.port || "COM3",
  baud: parseInt(args.baud || 9600),
  id: parseInt(args.id || 1),
  start: parseInt(args.start || 0),
  count: parseInt(args.count || 20),
  fc: parseInt(args.fc || 3), // 3 = holding register, 4 = input register
  interval: parseInt(args.interval || 2000),
  scan: args.scan === true || args.scan === "true",
  list: args.list === true || args.list === "true",
};

const client = new ModbusRTU();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const toS16 = (v) => (v > 0x7fff ? v - 0x10000 : v);
const hex = (v) => "0x" + v.toString(16).toUpperCase().padStart(4, "0");

async function readOnce() {
  const res =
    cfg.fc === 4
      ? await client.readInputRegisters(cfg.start, cfg.count)
      : await client.readHoldingRegisters(cfg.start, cfg.count);

  console.clear();
  console.log(
    `Port ${cfg.port} | ${cfg.baud} bps | ID ${cfg.id} | FC${cfg.fc} | ${new Date().toLocaleTimeString()}`
  );
  console.table(
    res.data.map((v, i) => ({
      Alamat: cfg.start + i,
      Hex: hex(v),
      Unsigned: v,
      Signed: toS16(v),
    }))
  );
}

async function scanMode() {
  const bauds = [9600, 19200, 115200, 4800, 38400];
  const ids = [1, 2, 3, 0x10, 0xff];
  for (const baud of bauds) {
    try {
      if (client.isOpen) await new Promise((r) => client.close(r));
    } catch {}
    await client.connectRTUBuffered(cfg.port, {
      baudRate: baud,
      dataBits: 8,
      parity: "none",
      stopBits: 1,
    });
    client.setTimeout(500);
    for (const id of ids) {
      client.setID(id);
      for (const fc of [3, 4]) {
        try {
          const r =
            fc === 4
              ? await client.readInputRegisters(0, 2)
              : await client.readHoldingRegisters(0, 2);
          console.log(`\n✔ DITEMUKAN -> baud ${baud}, id ${id}, FC${fc}, data:`, r.data);
        } catch (e) {
          process.stdout.write(
            `. (baud ${baud}, id ${id}, FC${fc}: ${e.message || e.errno})\r`
          );
        }
        await sleep(100);
      }
    }
  }
  console.log("\nScan selesai.");
  process.exit(0);
}

async function main() {
  if (cfg.list) {
    const ports = await SerialPort.list();
    console.log("Port serial terdeteksi:");
    ports.forEach((p) =>
      console.log(` - ${p.path}  ${p.manufacturer || ""} ${p.serialNumber || ""}`)
    );
    return;
  }

  if (cfg.scan) return scanMode();

  await client.connectRTUBuffered(cfg.port, {
    baudRate: cfg.baud,
    dataBits: 8,
    parity: "none",
    stopBits: 1,
  });
  client.setID(cfg.id);
  client.setTimeout(1000);

  console.log("Terhubung. Tekan Ctrl+C untuk berhenti.");
  while (true) {
    try {
      await readOnce();
    } catch (e) {
      console.error("Gagal baca:", e.message || e);
    }
    await sleep(cfg.interval);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});