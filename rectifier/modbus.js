#!/usr/bin/env node
/**
 * Huawei R4850G Rectifier / SMU02C - Modbus Register Scanner & Data Reader
 * ===========================================================================
 *
 * Huawei tidak mempublikasikan register map resmi untuk R4850G/SMU02C
 * (berbeda dengan produk solar inverter mereka yang terbuka). Script ini
 * punya dua fungsi:
 *
 * 1. SCAN    -> membaca range register mentah (raw) supaya kita bisa
 *    menemukan register mana yang berisi tegangan, arus, dll, dengan cara
 *    mencocokkan nilai yang terbaca dengan nilai riil di layar LCD
 *    rectifier (misalnya "Voltage 53.9V" yang terlihat di foto Anda).
 *
 * 2. READ    -> setelah register ditemukan & dipetakan manual, isi
 *    REGISTER_MAP di bawah supaya bisa langsung membaca nilai berlabel
 *    dan sudah di-scale ke satuan yang benar. Ada juga mode monitor
 *    untuk loop pembacaan berkala (dashboard sederhana di terminal).
 *
 * Requirement:
 *     npm install modbus-serial
 *
 * Info device dari foto Anda:
 *     - Slave / Unit ID (Modbus) : 33
 *     - Mode                     : RTU via RS485 (port "COM" di modul UIM03F1)
 *     - Baudrate                 : belum pasti -> coba 9600 dulu (default umum)
 *     - Parity / stopbit         : coba 8N1 dulu (paling umum)
 *     - Alternatif               : Modbus TCP ke 192.168.23.200:502
 *                                   (kalau RTU gagal terus, coba jalur ini)
 *
 * Cara pakai cepat:
 *     # 1. Cari register (jalankan sambil lihat layar LCD rectifier untuk
 *     #    mencocokkan nilai, misal tegangan 53.9V harus muncul sebagai
 *     #    raw 5390 (skala 100) atau 539 (skala 10) di salah satu baris)
 *     node rectifier_modbus.js --mode rtu --scan --start 0 --end 500 --fc 3
 *     node rectifier_modbus.js --mode rtu --scan --start 0 --end 500 --fc 4
 *
 *     # 2. Setelah ketemu, isi REGISTER_MAP di bawah, lalu:
 *     node rectifier_modbus.js --mode rtu --read
 *
 *     # 3. Monitoring berkala tiap 5 detik:
 *     node rectifier_modbus.js --mode rtu --monitor --interval 5
 *
 *     # 4. Kalau mau coba lewat Ethernet (Modbus TCP) bukan RS485:
 *     node rectifier_modbus.js --mode tcp --scan --start 0 --end 500
 */

const ModbusRTU = require("modbus-serial");

// ---------------------------------------------------------------------------
// KONFIGURASI - sesuaikan dengan setup Anda
// ---------------------------------------------------------------------------
const SLAVE_ID = 33;               // dari menu "Nbound ModbusProtocol" di SMU02C
const SERIAL_PORT = "COM3";        // Windows: "COM3", dst. Linux/Mac: "/dev/ttyUSB0"
const BAUDRATE = 9600;             // coba 9600 dulu, kalau gagal coba 19200 / 4800
const PARITY = "none";             // "none" | "even" | "odd"
const STOPBITS = 1;
const DATABITS = 8;

const TCP_IP = "192.168.23.200";
const TCP_PORT = 502;              // port default Modbus TCP

// ---------------------------------------------------------------------------
// REGISTER MAP - ISI SETELAH SCANNING KETEMU ALAMAT YANG BENAR
// ---------------------------------------------------------------------------
// Format: nama: { addr, fc, scale, unit }
//   fc    : 3 = Holding Register (Read Holding Registers, FC03)
//           4 = Input Register  (Read Input Registers, FC04)
//   scale : nilai_real = nilai_mentah / scale
//           (Huawei umumnya pakai skala 10 atau 100, harus dikonfirmasi
//           manual dari hasil scan)
const REGISTER_MAP = {
  // Contoh setelah ditemukan dari scan, aktifkan/isi baris di bawah:
  // output_voltage:  { addr: 0x1000, fc: 3, scale: 100, unit: "V" },
  // output_current:  { addr: 0x1002, fc: 3, scale: 100, unit: "A" },
  // battery_current: { addr: 0x1004, fc: 3, scale: 100, unit: "A" },
  // battery_voltage: { addr: 0x1006, fc: 3, scale: 100, unit: "V" },
  // input_power:     { addr: 0x1008, fc: 3, scale: 10,  unit: "kW" },
  // temperature:     { addr: 0x100A, fc: 3, scale: 10,  unit: "C" },
};

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// ---------------------------------------------------------------------------
// Koneksi
// ---------------------------------------------------------------------------
async function connectRTU() {
  const client = new ModbusRTU();
  try {
    await client.connectRTUBuffered(SERIAL_PORT, {
      baudRate: BAUDRATE,
      parity: PARITY,
      stopBits: STOPBITS,
      dataBits: DATABITS,
    });
  } catch (e) {
    console.error(`Gagal konek ke ${SERIAL_PORT} @ ${BAUDRATE}bps:`, e.message);
    console.error("Cek: kabel A/B tidak kebalik, port COM benar, driver adapter terinstall.");
    process.exit(1);
  }
  client.setID(SLAVE_ID);
  client.setTimeout(1000);
  console.log(`Terhubung RTU: ${SERIAL_PORT} @ ${BAUDRATE}bps, slave=${SLAVE_ID}`);
  return client;
}

async function connectTCP() {
  const client = new ModbusRTU();
  try {
    await client.connectTCP(TCP_IP, { port: TCP_PORT });
  } catch (e) {
    console.error(`Gagal konek ke ${TCP_IP}:${TCP_PORT}:`, e.message);
    console.error("Cek: laptop satu subnet dengan 192.168.23.x, sudah ping sukses?");
    process.exit(1);
  }
  client.setID(SLAVE_ID);
  client.setTimeout(2000);
  console.log(`Terhubung TCP: ${TCP_IP}:${TCP_PORT}, slave=${SLAVE_ID}`);
  return client;
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------
async function scanRegisters(client, start, end, fc, chunk = 10) {
  const fcName = fc === 3 ? "Holding(FC03)" : "Input(FC04)";
  console.log(`\n=== SCAN ${fcName} register ${start}-${end} (slave ${SLAVE_ID}) ===`);
  console.log(
    `${"Addr".padStart(6)} | ${"Hex".padStart(6)} | ${"Raw".padStart(8)} | /10    | /100   | /1000`
  );
  console.log("-".repeat(62));

  let addr = start;
  let foundAny = false;

  while (addr < end) {
    const n = Math.min(chunk, end - addr);
    try {
      const result =
        fc === 3
          ? await client.readHoldingRegisters(addr, n)
          : await client.readInputRegisters(addr, n);

      result.data.forEach((val, i) => {
        if (val !== 0) {
          foundAny = true;
          const a = addr + i;
          console.log(
            `${String(a).padStart(6)} | 0x${a.toString(16).toUpperCase().padStart(4, "0")} | ` +
              `${String(val).padStart(8)} | ${(val / 10).toFixed(1).padStart(6)} | ` +
              `${(val / 100).toFixed(2).padStart(6)} | ${(val / 1000).toFixed(3).padStart(6)}`
          );
        }
      });
    } catch (e) {
      // Register kosong / exception dari device -> lewati saja
    }
    addr += n;
    await sleep(50); // jeda kecil biar tidak membanjiri bus RS485
  }

  if (!foundAny) {
    console.log("  (tidak ada register non-zero ditemukan di range ini)");
    console.log("  Coba: naikkan --end, ganti --fc (3<->4), atau baudrate berbeda.");
  }
}

// ---------------------------------------------------------------------------
// Reader (pakai REGISTER_MAP)
// ---------------------------------------------------------------------------
async function readKnownValues(client) {
  const names = Object.keys(REGISTER_MAP);
  if (names.length === 0) {
    console.log("\nREGISTER_MAP masih kosong.");
    console.log("Jalankan --scan dulu untuk menemukan alamat register yang cocok,");
    console.log("lalu isi manual bagian REGISTER_MAP di bagian atas script ini.");
    return;
  }

  const now = new Date().toLocaleTimeString();
  console.log(`\n=== Data Rectifier (${now}) ===`);

  for (const name of names) {
    const { addr, fc, scale, unit } = REGISTER_MAP[name];
    try {
      const result =
        fc === 3
          ? await client.readHoldingRegisters(addr, 1)
          : await client.readInputRegisters(addr, 1);

      const raw = result.data[0];
      const value = raw / scale;
      console.log(`  ${name.padEnd(18)}: ${value.toFixed(2).padStart(10)} ${unit}`);
    } catch (e) {
      console.log(`  ${name.padEnd(18)}: ERROR - ${e.message}`);
    }
  }
}

async function monitorLoop(client, intervalSec) {
  console.log(`\nMonitoring tiap ${intervalSec} detik. Tekan Ctrl+C untuk berhenti.\n`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await readKnownValues(client);
    await sleep(intervalSec * 1000);
  }
}

// ---------------------------------------------------------------------------
// CLI arg parsing sederhana (tanpa dependency tambahan)
// ---------------------------------------------------------------------------
function parseArgs() {
  const argv = process.argv.slice(2);
  const args = {
    mode: "rtu",
    scan: false,
    start: 0,
    end: 200,
    fc: 3,
    read: false,
    monitor: false,
    interval: 5,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--mode":
        args.mode = argv[++i];
        break;
      case "--scan":
        args.scan = true;
        break;
      case "--start":
        args.start = parseInt(argv[++i], 10);
        break;
      case "--end":
        args.end = parseInt(argv[++i], 10);
        break;
      case "--fc":
        args.fc = parseInt(argv[++i], 10);
        break;
      case "--read":
        args.read = true;
        break;
      case "--monitor":
        args.monitor = true;
        break;
      case "--interval":
        args.interval = parseInt(argv[++i], 10);
        break;
      default:
        console.warn(`Argumen tidak dikenal: ${a}`);
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs();
  const client = args.mode === "tcp" ? await connectTCP() : await connectRTU();

  try {
    if (args.scan) {
      await scanRegisters(client, args.start, args.end, args.fc);
    } else if (args.monitor) {
      await monitorLoop(client, args.interval);
    } else if (args.read) {
      await readKnownValues(client);
    } else {
      // default: scan holding lalu input register di range kecil dulu
      await scanRegisters(client, 0, 100, 3);
      await scanRegisters(client, 0, 100, 4);
    }
  } finally {
    if (!args.monitor) client.close(() => {});
  }
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});