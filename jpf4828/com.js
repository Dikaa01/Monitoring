/**
 * power_comm.js
 * Alat eksplorasi komunikasi untuk SMU/rectifier lewat RS485, mendukung 2 mode:
 *
 *  1) --protocol modbus   -> baca holding register satu-per-satu (lanjutan probe.js)
 *  2) --protocol ydt1363  -> kirim frame YD/T1363.3 (protokol monitoring daya
 *     telekomunikasi Cina, dipakai banyak SMU Huawei-style/ZTE/dll)
 *
 * ============================================================
 * TENTANG YD/T1363.3
 * ============================================================
 * Bukan Modbus. Struktur frame (semua field selain SOI/EOI adalah ASCII-HEX,
 * artinya tiap byte data ditulis sebagai 2 karakter hex):
 *
 *   SOI(1B=0x7E) VER(2B) ADR(2B) CID1(2B) CID2(2B) LENGTH(4B) INFO(2*N B) CHKSUM(4B) EOI(1B=0x0D)
 *
 * - VER   : versi protokol (umumnya 0x21)
 * - ADR   : alamat device (1-254; 0xFF broadcast)
 * - CID1  : tipe device (0x40=power system paling umum)
 * - CID2  : kode perintah. Umum dipakai untuk eksplorasi:
 *             0x4D = GET_PROTOCOL_VERSION (paling "aman" buat tes koneksi)
 *             0x41 = GET_ANALOG_DATA (data ukur: tegangan, arus, dst)
 *             0x44 = GET_SYSTEM_PARAMETER
 *             0x43 = GET_ALARM_STATUS
 * - LENGTH: panjang INFO (12 bit) + checksum 4-bit dari panjang itu sendiri
 * - CHKSUM: checksum 16-bit dari seluruh field VER..INFO (two's complement)
 *
 * Kode CID1/CID2 di atas adalah yang paling umum dipakai lintas vendor,
 * TAPI bisa beda tergantung firmware. --scan akan coba beberapa kombinasi.
 *
 * ============================================================
 * CONTOH PAKAI
 * ============================================================
 *   # Mode modbus (sama seperti probe.js)
 *   node power_comm.js --protocol modbus --port COM5 --baud 9600 --parity none \
 *        --stopbits 1 --id 33 --start 1 --length 10 --target 53.8 --tol 0.3
 *
 *   # Mode YD/T1363.3, coba banyak kombinasi ADR/CID1/CID2 otomatis
 *   node power_comm.js --protocol ydt1363 --port COM5 --baud 9600 --parity none \
 *        --stopbits 1 --scan
 *
 *   # Mode YD/T1363.3, kirim 1 perintah spesifik
 *   node power_comm.js --protocol ydt1363 --port COM5 --baud 9600 --parity none \
 *        --stopbits 1 --adr 1 --cid1 0x40 --cid2 0x41
 *
 * Butuh: npm install modbus-serial serialport
 */

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    protocol: 'modbus',
    port: null,
    baud: 9600,
    parity: 'none',
    stopbits: 1,
    timeout: 1000,
    delay: 250,
    // modbus
    id: 1,
    start: 1,
    length: 10,
    target: null,
    tol: 0.3,
    retries: 2,
    // ydt1363
    ver: 0x21,
    adr: 1,
    cid1: 0x40,
    cid2: 0x4d,
    info: '',
    scan: false,
  };
  for (let i = 0; i < args.length; i++) {
    const key = args[i].replace(/^--/, '');
    if (key === 'scan') { opts.scan = true; continue; }
    const val = args[++i];
    if (key === 'protocol') opts.protocol = val;
    else if (key === 'port') opts.port = val;
    else if (key === 'baud') opts.baud = Number(val);
    else if (key === 'parity') opts.parity = val;
    else if (key === 'stopbits') opts.stopbits = Number(val);
    else if (key === 'timeout') opts.timeout = Number(val);
    else if (key === 'delay') opts.delay = Number(val);
    else if (key === 'id') opts.id = Number(val);
    else if (key === 'start') opts.start = Number(val);
    else if (key === 'length') opts.length = Number(val);
    else if (key === 'target') opts.target = Number(val);
    else if (key === 'tol') opts.tol = Number(val);
    else if (key === 'retries') opts.retries = Number(val);
    else if (key === 'ver') opts.ver = Number(val);
    else if (key === 'adr') opts.adr = Number(val);
    else if (key === 'cid1') opts.cid1 = Number(val);
    else if (key === 'cid2') opts.cid2 = Number(val);
    else if (key === 'info') opts.info = val;
  }
  if (!opts.port) {
    console.error('Error: --port wajib diisi.');
    process.exit(1);
  }
  return opts;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ======================================================================
 * MODE 1: MODBUS (baca holding register satu-satu, dengan retry timeout)
 * ====================================================================== */
async function runModbus(opts) {
  const ModbusRTU = require('modbus-serial');
  const client = new ModbusRTU();

  await new Promise((resolve, reject) => {
    client.connectRTUBuffered(
      opts.port,
      { baudRate: opts.baud, dataBits: 8, parity: opts.parity, stopBits: opts.stopbits },
      (err) => (err ? reject(err) : resolve())
    );
  });
  client.setID(opts.id);
  client.setTimeout(opts.timeout);

  function toSigned16(u) { return u > 0x7fff ? u - 0x10000 : u; }
  function near(val, target, tol) { return target !== null && Math.abs(val - target) <= tol; }

  console.log(`\n=== [MODBUS] Membaca holding register ${opts.start} s/d ${opts.start + opts.length - 1} (id=${opts.id}) ===`);
  console.log('Reg#'.padEnd(6) + 'raw'.padEnd(8) + '/10'.padEnd(10) + '/100'.padEnd(10) + 'signed/10'.padEnd(12) + 'signed/100');
  console.log('-'.repeat(70));

  const ok = [];
  for (let i = 0; i < opts.length; i++) {
    const addr = opts.start + i;
    let lastErr = null, done = false;
    for (let attempt = 0; attempt <= opts.retries && !done; attempt++) {
      try {
        const r = await client.readHoldingRegisters(addr, 1);
        const v = r.data[0];
        ok.push(addr);
        const d10 = v / 10, d100 = v / 100, s10 = toSigned16(v) / 10, s100 = toSigned16(v) / 100;
        let flags = '';
        if (near(d10, opts.target, opts.tol)) flags += ' ⭐/10';
        if (near(d100, opts.target, opts.tol)) flags += ' ⭐/100';
        if (near(s10, opts.target, opts.tol)) flags += ' ⭐signed/10';
        if (near(s100, opts.target, opts.tol)) flags += ' ⭐signed/100';
        console.log(String(addr).padEnd(6) + String(v).padEnd(8) + d10.toFixed(2).padEnd(10) + d100.toFixed(3).padEnd(10) + s10.toFixed(2).padEnd(12) + s100.toFixed(3) + flags);
        done = true;
      } catch (err) {
        lastErr = err;
        if (!/timed out/i.test(err.message)) break;
        if (attempt < opts.retries) await sleep(opts.delay * 2);
      }
    }
    if (!done) console.log(String(addr).padEnd(6) + `(gagal: ${lastErr.message})`);
    await sleep(opts.delay);
  }
  console.log(ok.length ? `\n  -> Berhasil dibaca: ${ok.join(', ')}` : '\n  -> Tidak ada yang berhasil.');
  client.close(() => process.exit(0));
}

/* ======================================================================
 * MODE 2: YD/T1363.3
 * ====================================================================== */
function hex(byteVal, digits) {
  return (byteVal & ((1 << (digits * 4)) - 1)).toString(16).toUpperCase().padStart(digits, '0');
}

function calcLengthField(lenid) {
  if (lenid === 0) return '0000';
  const d = lenid & 0xfff;
  const n1 = (d >> 8) & 0xf, n2 = (d >> 4) & 0xf, n3 = d & 0xf;
  const sum = (n1 + n2 + n3) & 0xf;
  const lchk = ((~sum) + 1) & 0xf;
  return hex((lchk << 12) | d, 4);
}

function calcChksum(str) {
  let sum = 0;
  for (let i = 0; i < str.length; i++) sum += str.charCodeAt(i);
  sum &= 0xffff;
  return hex(((~sum) + 1) & 0xffff, 4);
}

function buildFrame({ ver, adr, cid1, cid2, infoBytes }) {
  const verStr = hex(ver, 2), adrStr = hex(adr, 2), cid1Str = hex(cid1, 2), cid2Str = hex(cid2, 2);
  const lengthStr = calcLengthField(infoBytes.length);
  let infoStr = '';
  for (const b of infoBytes) infoStr += hex(b, 2);
  const body = verStr + adrStr + cid1Str + cid2Str + lengthStr + infoStr;
  const chk = calcChksum(body);
  return Buffer.from('~' + body + chk + '\r', 'ascii');
}

function parseFrame(buf) {
  // cari SOI (0x7E) dan EOI (0x0D) pertama
  const soi = buf.indexOf(0x7e);
  const eoi = buf.indexOf(0x0d, soi + 1);
  if (soi === -1 || eoi === -1) return null;
  const body = buf.slice(soi + 1, eoi).toString('ascii'); // VER..CHKSUM
  if (body.length < 16) return null;
  const ver = body.slice(0, 2), adr = body.slice(2, 4), cid1 = body.slice(4, 6), cid2 = body.slice(6, 8);
  const length = body.slice(8, 12);
  const lenid = parseInt(length, 16) & 0xfff;
  const infoStr = body.slice(12, 12 + lenid * 2);
  const chksum = body.slice(12 + lenid * 2, 12 + lenid * 2 + 4);
  const expectedChk = calcChksum(body.slice(0, 12 + lenid * 2));
  const infoBytes = Buffer.from(infoStr, 'hex');
  return { ver, adr, cid1, cid2, lenid, infoBytes, chksumOk: chksum === expectedChk, raw: buf.slice(soi, eoi + 1) };
}

async function sendAndReceive(port, frameBuf, timeoutMs) {
  return new Promise((resolve) => {
    let recvBuf = Buffer.alloc(0);
    let done = false;
    const onData = (chunk) => {
      recvBuf = Buffer.concat([recvBuf, chunk]);
      if (recvBuf.includes(0x0d)) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    function finish() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      port.removeListener('data', onData);
      resolve(recvBuf.length ? recvBuf : null);
    }
    port.on('data', onData);
    port.write(frameBuf);
  });
}

async function runYdt1363(opts) {
  const { SerialPort } = require('serialport');
  const port = new SerialPort({
    path: opts.port,
    baudRate: opts.baud,
    dataBits: 8,
    parity: opts.parity,
    stopBits: opts.stopbits,
    autoOpen: false,
  });
  await new Promise((resolve, reject) => port.open((err) => (err ? reject(err) : resolve())));
  await sleep(300); // jeda settle setelah port dibuka, sebelum kirim apapun

  const infoBytes = opts.info ? Buffer.from(opts.info.replace(/\s+/g, ''), 'hex') : Buffer.alloc(0);

  async function tryOne(adr, cid1, cid2, label) {
    const frame = buildFrame({ ver: opts.ver, adr, cid1, cid2, infoBytes });
    let resp = null;
    for (let attempt = 0; attempt <= opts.retries && !resp; attempt++) {
      if (attempt > 0) {
        process.stdout.write(`    (retry ${attempt}/${opts.retries}...)\n`);
        await sleep(opts.delay * 2);
      }
      process.stdout.write(`ADR=${hex(adr,2)} CID1=${hex(cid1,2)} CID2=${hex(cid2,2)} ${label ? '(' + label + ') ' : ''}-> TX: ${frame.toString('ascii').replace(/[\r]/g,'<CR>')}  `);
      resp = await sendAndReceive(port, frame, opts.timeout);
      if (!resp) console.log('(tidak ada respons / timeout)');
    }
    if (!resp) return null;
    // selalu tampilkan RAW dulu (byte mentah + ascii mentah) -- ini yang paling bisa dipercaya
    console.log(`\n    RX RAW BYTES (hex) = ${resp.toString('hex')}`);
    console.log(`    RX RAW ASCII       = ${resp.toString('ascii').replace(/[\r\n]/g, (c)=>c==='\r'?'<CR>':'<LF>')}`);
    const parsed = parseFrame(resp);
    if (!parsed) { console.log('    (gagal parse sbg frame YD/T1363 -- lihat raw di atas)'); return null; }
    console.log(
      `    Parsed -> VER=${parsed.ver} ADR=${parsed.adr} CID1(echo)=${parsed.cid1} CID2(rtn)=${parsed.cid2} ` +
      `LENID(decoded)=${parsed.lenid} checksum=${parsed.chksumOk ? 'OK' : 'SALAH(cek raw manual)'} INFO(hex)=${parsed.infoBytes.toString('hex')}`
    );
    return parsed;
  }

  if (opts.scan) {
    console.log('\n=== [YD/T1363.3] Mode scan: mencoba kombinasi umum ADR/CID1/CID2 ===');
    console.log('(CID2=0x4D = get protocol version, biasanya paling "aman" untuk tes koneksi)\n');
    const adrList = [1, opts.adr, 33].filter((v, i, a) => a.indexOf(v) === i);
    const cid1List = [0x40, 0x41, 0x42, 0x43, 0x44, 0x46];
    const cid2List = [0x4d, 0x41, 0x44, 0x43];
    let anyOk = false;
    for (const adr of adrList) {
      for (const cid1 of cid1List) {
        for (const cid2 of cid2List) {
          const r = await tryOne(adr, cid1, cid2);
          if (r) anyOk = true;
          await sleep(opts.delay);
        }
      }
    }
    if (!anyOk) console.log('\nTidak ada satupun kombinasi yang dapat respons valid.');
  } else {
    console.log('\n=== [YD/T1363.3] Kirim satu perintah ===');
    await tryOne(opts.adr, opts.cid1, opts.cid2);
  }

  port.close(() => process.exit(0));
}

async function main() {
  const opts = parseArgs();
  if (opts.protocol === 'modbus') await runModbus(opts);
  else if (opts.protocol === 'ydt1363') await runYdt1363(opts);
  else { console.error('Error: --protocol harus "modbus" atau "ydt1363"'); process.exit(1); }
}

main().catch((err) => {
  console.error('Gagal:', err.message);
  process.exit(1);
});