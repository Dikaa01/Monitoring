// smu-scan.js
// Mencoba kombinasi parity, stop bit, dan fungsi Modbus untuk mencari respon dari SMU.
// Jalankan: node smu-scan.js COM3
//           node smu-scan.js COM3 --baud 19200 --id 1

const ModbusRTU = require("modbus-serial");

const args = process.argv.slice(2);
const getOpt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};

const PORT = args[0] && !args[0].startsWith("--") ? args[0] : "COM3";
const BAUD = parseInt(getOpt("baud", "19200"), 10);
const ID = parseInt(getOpt("id", "1"), 10);

const parities = ["none", "even", "odd"];
const stopBits = [1, 2];
const tests = [
  ["holding reg 0", (c) => c.readHoldingRegisters(0, 1)],
  ["holding reg 1", (c) => c.readHoldingRegisters(1, 1)],
  ["input reg 0", (c) => c.readInputRegisters(0, 1)],
  ["coil 0", (c) => c.readCoils(0, 1)],
  ["discrete 0", (c) => c.readDiscreteInputs(0, 1)],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let found = false;
  console.log(`Scan ${PORT} @ ${BAUD} baud, slave ID ${ID}\n`);

  for (const parity of parities) {
    for (const sb of stopBits) {
      const client = new ModbusRTU();
      try {
        await client.connectRTUBuffered(PORT, {
          baudRate: BAUD,
          dataBits: 8,
          stopBits: sb,
          parity,
        });
      } catch (e) {
        console.error("Gagal buka port:", e.message);
        process.exit(1);
      }
      client.setID(ID);
      client.setTimeout(600);

      process.stdout.write(`8-${parity}-${sb}: `);
      let ok = false;

      for (const [name, fn] of tests) {
        try {
          const r = await fn(client);
          console.log(`\n  BERHASIL  ${name} =`, r.data);
          ok = found = true;
          break;
        } catch (err) {
          // Exception Modbus (mis. illegal address) = perangkat HIDUP dan membalas
          if (err.modbusCode) {
            console.log(`\n  ADA RESPON (exception ${err.modbusCode}) di ${name} -> setting ini BENAR`);
            ok = found = true;
            break;
          }
        }
      }
      if (!ok) console.log("tidak ada respon");

      await new Promise((r) => client.close(r));
      await sleep(200);
    }
  }

  if (!found) {
    console.log(
      "\nTidak ada respon di semua kombinasi.\n" +
        "Cek: 1) tukar kabel A/B  2) pin RJ45  3) COM port  4) ID/baud di LCD\n" +
        "     5) coba ID lain: node smu-scan.js COM3 --id 0 (atau 2,3,...)"
    );
  }
}

main();