const { SerialPort } = require("serialport");

// ======================================================
// CONFIG
// ======================================================

const PORT = "COM4";
const BAUD = 9600;
const SLAVE_ID = 214;

const START_REGISTER = 0;
const END_REGISTER = 300;

// Modbus FC03 maksimal 125 register dalam satu request
const MAX_REGISTERS_PER_REQUEST = 125;

const RESPONSE_TIMEOUT = 1000;


// ======================================================
// MODBUS CRC16
// ======================================================

function modbusCRC(buffer) {
    let crc = 0xFFFF;

    for (const byte of buffer) {
        crc ^= byte;

        for (let i = 0; i < 8; i++) {
            if (crc & 0x0001) {
                crc >>= 1;
                crc ^= 0xA001;
            } else {
                crc >>= 1;
            }
        }
    }

    return crc;
}


// ======================================================
// BUILD FC03 REQUEST
// ======================================================

function buildRequest(slave, startRegister, quantity) {

    const frame = Buffer.from([
        slave,
        0x03,

        // Start register
        (startRegister >> 8) & 0xFF,
        startRegister & 0xFF,

        // Quantity
        (quantity >> 8) & 0xFF,
        quantity & 0xFF
    ]);

    const crc = modbusCRC(frame);

    return Buffer.concat([
        frame,
        Buffer.from([
            crc & 0xFF,
            (crc >> 8) & 0xFF
        ])
    ]);
}


// ======================================================
// HEX FORMAT
// ======================================================

function hex(buffer) {
    return [...buffer]
        .map(b => b.toString(16).padStart(2, "0").toUpperCase())
        .join(" ");
}


// ======================================================
// READ ONE REQUEST
// ======================================================

function readRegisters(port, startRegister, quantity) {

    return new Promise((resolve, reject) => {

        const request = buildRequest(
            SLAVE_ID,
            startRegister,
            quantity
        );

        console.log("");
        console.log("--------------------------------------------------");

        console.log(
            `Request register ${startRegister} - ${startRegister + quantity - 1}`
        );

        console.log("TX :", hex(request));

        let rx = Buffer.alloc(0);

        const timeout = setTimeout(() => {

            port.removeListener("data", onData);

            reject(
                new Error(
                    `Timeout menunggu response register ${startRegister}`
                )
            );

        }, RESPONSE_TIMEOUT);


        function onData(data) {

            rx = Buffer.concat([rx, data]);

            // Response normal:
            //
            // Slave
            // Function
            // Byte count
            // Data
            // CRC
            //
            const expectedLength = 5 + quantity * 2;

            if (rx.length < expectedLength) {
                return;
            }

            clearTimeout(timeout);

            port.removeListener("data", onData);

            resolve(rx);
        }

        port.on("data", onData);

        port.write(request, (err) => {

            if (err) {

                clearTimeout(timeout);
                port.removeListener("data", onData);

                reject(err);
            }
        });
    });
}


// ======================================================
// PARSE RESPONSE
// ======================================================

function parseResponse(response, startRegister, quantity) {

    console.log("RX :", hex(response));

    if (response.length < 5) {
        throw new Error("Response terlalu pendek");
    }


    // --------------------------------------------------
    // Check slave
    // --------------------------------------------------

    if (response[0] !== SLAVE_ID) {

        throw new Error(
            `Slave ID salah: ${response[0]}`
        );
    }


    // --------------------------------------------------
    // Check function
    // --------------------------------------------------

    if (response[1] === 0x83) {

        const exceptionCode = response[2];

        throw new Error(
            `Modbus Exception FC03: ${exceptionCode}`
        );
    }


    if (response[1] !== 0x03) {

        throw new Error(
            `Function code tidak sesuai: 0x${response[1].toString(16)}`
        );
    }


    // --------------------------------------------------
    // Byte count
    // --------------------------------------------------

    const byteCount = response[2];

    const expectedByteCount = quantity * 2;

    if (byteCount !== expectedByteCount) {

        throw new Error(
            `Byte count salah. Expected ${expectedByteCount}, received ${byteCount}`
        );
    }


    // --------------------------------------------------
    // CRC
    // --------------------------------------------------

    const dataWithoutCRC =
        response.subarray(0, response.length - 2);

    const receivedCRC =
        response[response.length - 2] |
        (response[response.length - 1] << 8);

    const calculatedCRC =
        modbusCRC(dataWithoutCRC);

    if (receivedCRC !== calculatedCRC) {

        throw new Error(
            `CRC ERROR. RX=${receivedCRC.toString(16)} CALC=${calculatedCRC.toString(16)}`
        );
    }


    // --------------------------------------------------
    // Extract registers
    // --------------------------------------------------

    const registers = [];

    for (let i = 0; i < quantity; i++) {

        const high = response[3 + i * 2];
        const low = response[4 + i * 2];

        const value =
            (high << 8) | low;

        registers.push({
            register: startRegister + i,
            value: value
        });
    }

    return registers;
}


// ======================================================
// MAIN
// ======================================================

async function main() {

    console.log("==============================================");
    console.log("       BATTERY 6618 MODBUS READER");
    console.log("==============================================");

    console.log(`COM        : ${PORT}`);
    console.log(`Baudrate   : ${BAUD}`);
    console.log(`Format     : 8N1`);
    console.log(`Slave ID   : ${SLAVE_ID}`);
    console.log(`Function   : FC03`);
    console.log(`Registers  : ${START_REGISTER} - ${END_REGISTER}`);

    console.log("==============================================");


    const port = new SerialPort({
        path: PORT,
        baudRate: BAUD,
        dataBits: 8,
        parity: "none",
        stopBits: 1,
        autoOpen: false
    });


    await new Promise((resolve, reject) => {

        port.open(err => {

            if (err) {
                reject(err);
            } else {
                resolve();
            }

        });

    });


    console.log("Status     : CONNECTED");


    let allRegisters = [];


    try {

        let currentRegister = START_REGISTER;


        while (currentRegister <= END_REGISTER) {

            const remaining =
                END_REGISTER - currentRegister + 1;

            const quantity =
                Math.min(
                    MAX_REGISTERS_PER_REQUEST,
                    remaining
                );


            try {

                const response =
                    await readRegisters(
                        port,
                        currentRegister,
                        quantity
                    );


                const registers =
                    parseResponse(
                        response,
                        currentRegister,
                        quantity
                    );


                allRegisters =
                    allRegisters.concat(registers);


                console.log(
                    `Berhasil membaca ${registers.length} register`
                );


            } catch (err) {

                console.log(
                    `ERROR register ${currentRegister}: ${err.message}`
                );

            }


            currentRegister += quantity;


            // Jeda antar request
            await new Promise(
                resolve => setTimeout(resolve, 200)
            );
        }


        // ==================================================
        // DISPLAY RESULT
        // ==================================================

        console.log("");
        console.log("");
        console.log("==============================================");
        console.log("             HASIL PEMBACAAN");
        console.log("==============================================");

        console.log(
            "REGISTER".padEnd(12) +
            "HEX".padEnd(12) +
            "DECIMAL"
        );

        console.log("----------------------------------------------");


        for (const reg of allRegisters) {

            const hexValue =
                "0x" +
                reg.value
                    .toString(16)
                    .toUpperCase()
                    .padStart(4, "0");

            console.log(
                String(reg.register).padEnd(12) +
                hexValue.padEnd(12) +
                reg.value
            );
        }


        console.log("----------------------------------------------");

        console.log(
            `Total register berhasil dibaca: ${allRegisters.length}`
        );

    } finally {

        port.close();

    }
}


// ======================================================
// RUN
// ======================================================

main().catch(err => {

    console.error("");
    console.error("ERROR:");
    console.error(err.message || err);

    process.exit(1);
});