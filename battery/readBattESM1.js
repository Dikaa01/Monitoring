const { ModbusMaster } = require('modbus-serial'); // Atau sesuaikan dengan library modbus lokal Anda
const ModbusRTU = require("modbus-serial");
const client = new ModbusRTU();

// Konfigurasi koneksi Serial
const COM_PORT = "COM4";
const BAUD_RATE = 9600;
const SLAVE_ID = 214;

async function readBMS() {
    try {
        await client.connectRTUBuffered(COM_PORT, { baudRate: BAUD_RATE, parity: 'none' });
        client.setSlaveId(SLAVE_ID);
        client.setTimeout(1000);

        console.log(`\n==========================================`);
        console.log(`   READING BMS DATA (Port: ${COM_PORT}, Slave: ${SLAVE_ID})   `);
        console.log(`==========================================\n`);

        // Read Register Block 1 (Alamat 66 - 70)
        const resBlock1 = await client.readHoldingRegisters(66, 5);
        const rawV_pack_alt = resBlock1.data[3]; // Reg 69

        // Read Register Block 2 (Alamat 257 - 280)
        const resBlock2 = await client.readHoldingRegisters(257, 25);
        const data = resBlock2.data;

        // Decoding Field Data berdasarkan Pemetaan Register
        const packVoltage  = (data[0] / 10).toFixed(1);          // Reg 257 (0x0101)
        const packCurrent  = (data[1] / 10).toFixed(1);          // Reg 258 (0x0102)
        const soc          = data[2];                             // Reg 259 (0x0103)
        const temperature  = (data[5] / 10).toFixed(1);          // Reg 262 (0x0106)
        const cellCount    = data[14];                            // Reg 271 (0x010F)
        const statusState  = data[18];                            // Reg 275 (0x0113)
        const remCapacity  = (data[19] / 100).toFixed(2);        // Reg 276 (0x0114)
        const maxCapacity  = (data[20] / 100).toFixed(2);        // Reg 277 (0x0115)

        // Tampilkan Hasil Parameter Langsung Terbaca
        console.log(`[STATUS PARAMETER BATERAI / ESM]`);
        console.log(`------------------------------------------`);
        console.log(`Tegangan Pack (Voltage) : ${packVoltage} V`);
        console.log(`Arus System (Current)   : ${packCurrent} A`);
        console.log(`Kapasitas Tersisa (SOC) : ${soc} %`);
        console.log(`Kapasitas Sisa (Ah)     : ${remCapacity} Ah`);
        console.log(`Kapasitas Maksimal      : ${maxCapacity} Ah`);
        console.log(`Suhu Baterai (Temp)     : ${temperature} °C`);
        console.log(`Jumlah Cell Series      : ${cellCount} S`);
        console.log(`State / Duty Flag       : ${statusState}`);
        console.log(`------------------------------------------\n`);

    } catch (err) {
        console.error("Error membaca Modbus BMS:", err.message);
    } finally {
        client.close();
    }
}

readBMS();