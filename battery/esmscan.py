#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
esm_scan.py - Pemindai RS485 (READ-ONLY) untuk baterai Huawei ESM-48100B1

Perintah:
  ports   daftar port serial yang terdeteksi
  scan    cari kombinasi baudrate / parity / slave ID yang menjawab Modbus RTU
  yd      probe protokol YDN1363 (frame ASCII diawali '~', diakhiri CR)
  ident   minta info perangkat (FC 0x11 dan FC 0x2B/0x0E)
  dump    baca register (FC03 / FC04) dan simpan ke CSV

Semua fungsi Modbus yang dipakai hanya BACA. Tidak ada perintah tulis (write),
jadi aman untuk parameter proteksi BMS.

Butuh: pip install pyserial

Contoh:
  python esm_scan.py ports
  python esm_scan.py -p COM5 scan                       # 9600, parity N/E/O, ID 1-247
  python esm_scan.py -p COM5 scan --baud all --parity N,E,O
  python esm_scan.py -p COM5 yd
  python esm_scan.py -p COM5 dump --baud 9600 --parity E --slave 214 --end 300
"""
import argparse
import csv
import struct
import sys
import time

try:
    import serial
    from serial.tools import list_ports
except ImportError:
    sys.exit("pyserial belum terpasang. Jalankan: pip install pyserial")

PARITY = {"N": serial.PARITY_NONE, "E": serial.PARITY_EVEN, "O": serial.PARITY_ODD}
ALL_BAUDS = [9600, 19200, 4800, 2400, 1200, 38400, 57600, 115200]
EXC = {
    1: "Illegal Function",
    2: "Illegal Data Address",
    3: "Illegal Data Value",
    4: "Slave Device Failure",
    5: "Acknowledge",
    6: "Slave Busy",
}


# --------------------------------------------------------------------------
# Lapisan serial
# --------------------------------------------------------------------------
class Link:
    def __init__(self, port, baud=9600, parity="N", timeout=0.15):
        self.ser = serial.Serial(
            port=port, baudrate=baud, bytesize=8, parity=PARITY[parity],
            stopbits=1, timeout=0, write_timeout=1,
        )
        self.timeout = timeout
        self.baud = baud
        self.parity = parity
        self.gap = max(0.02, 44.0 / baud)  # jeda ~4 karakter = akhir frame
        self.set(baud, parity)

    def set(self, baud, parity):
        self.ser.baudrate = baud
        self.ser.parity = PARITY[parity]
        self.baud, self.parity = baud, parity
        self.gap = max(0.02, 44.0 / baud)
        time.sleep(0.05)

    def txrx(self, frame):
        """Kirim frame, kembalikan bytes balasan (echo adaptor dibuang)."""
        s = self.ser
        s.reset_input_buffer()
        s.write(frame)
        s.flush()
        deadline = time.monotonic() + self.timeout
        buf = bytearray()
        last = 0.0
        while True:
            now = time.monotonic()
            n = s.in_waiting
            if n:
                buf += s.read(n)
                last = now
            elif buf and now - last > self.gap:
                # kalau baru echo dari adaptor, tunggu balasan sungguhan
                if bytes(buf) == frame[:len(buf)] and now < deadline:
                    time.sleep(0.001)
                else:
                    break
            elif not buf and now > deadline:
                break
            else:
                time.sleep(0.001)
        data = bytes(buf)
        if data.startswith(frame):
            data = data[len(frame):]
        return data

    def close(self):
        self.ser.close()


# --------------------------------------------------------------------------
# Modbus RTU
# --------------------------------------------------------------------------
def crc16(data: bytes) -> int:
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = ((crc >> 1) ^ 0xA001) if (crc & 1) else (crc >> 1)
    return crc


def mb_frame(slave: int, fc: int, payload: bytes = b"") -> bytes:
    body = bytes([slave, fc]) + payload
    return body + struct.pack("<H", crc16(body))


def parse_mb(data: bytes, slave: int, fc: int):
    """Return (status, value): (None,None)=kosong, ok=payload, exc=kode, bad=tidak valid."""
    if not data:
        return None, None
    if len(data) < 5:
        return "bad", None
    if crc16(data[:-2]) != struct.unpack("<H", data[-2:])[0]:
        return "bad", None
    if data[0] != slave:
        return "bad", None
    if data[1] == fc:
        return "ok", data[2:-2]
    if data[1] == (fc | 0x80):
        return "exc", data[2]
    return "bad", None


def read_regs(link: Link, sid: int, fc: int, addr: int, qty: int):
    data = link.txrx(mb_frame(sid, fc, struct.pack(">HH", addr, qty)))
    st, val = parse_mb(data, sid, fc)
    if st == "ok":
        if len(val) == qty * 2 + 1 and val[0] == qty * 2:
            return "ok", list(struct.unpack(f">{qty}H", val[1:]))
        return "bad", None
    return st, val


# --------------------------------------------------------------------------
# YDN1363 (YD/T 1363.3) - frame ASCII
# --------------------------------------------------------------------------
def yd_lchk(lenid: int) -> int:
    s = ((lenid >> 8) & 0xF) + ((lenid >> 4) & 0xF) + (lenid & 0xF)
    return ((~(s % 16)) + 1) & 0xF


def yd_frame(adr: int, cid1: int, cid2: int, info: bytes = b"", ver: int = 0x20) -> bytes:
    lenid = len(info)
    length = (yd_lchk(lenid) << 12) | lenid
    body = f"{ver:02X}{adr:02X}{cid1:02X}{cid2:02X}{length:04X}".encode() + info
    chk = (~sum(body) + 1) & 0xFFFF
    return b"~" + body + f"{chk:04X}".encode() + b"\r"


# --------------------------------------------------------------------------
# Util
# --------------------------------------------------------------------------
def hexs(b: bytes) -> str:
    return " ".join(f"{x:02X}" for x in b)


def printable(b: bytes) -> str:
    return "".join(chr(x) if 32 <= x < 127 else "." for x in b)


def parse_bauds(s: str):
    return list(ALL_BAUDS) if s.lower() == "all" else [int(x) for x in s.split(",")]


def parse_parities(s: str):
    p = [x.strip().upper() for x in s.split(",")]
    for x in p:
        if x not in PARITY:
            sys.exit(f"Parity tidak dikenal: {x} (pakai N, E, atau O)")
    return p


def combos(a):
    return [(b, p) for b in parse_bauds(a.baud) for p in parse_parities(a.parity)]


def ordered_ids(lo: int, hi: int):
    pref = [i for i in (214, 1, 2, 3, 4, 5, 16, 17) if lo <= i <= hi]
    return pref + [i for i in range(lo, hi + 1) if i not in pref]


# --------------------------------------------------------------------------
# Perintah
# --------------------------------------------------------------------------
def cmd_ports(_a):
    ports = list(list_ports.comports())
    if not ports:
        print("Tidak ada port serial terdeteksi.")
    for p in ports:
        print(f"{p.device:<15} {p.description}")


def cmd_scan(a):
    link = Link(a.port, timeout=a.timeout)
    probes = [(0x03, struct.pack(">HH", a.probe_addr, 1))]
    if not a.fast:
        probes.append((0x04, struct.pack(">HH", a.probe_addr, 1)))
    ids = ordered_ids(a.id_min, a.id_max)
    found = []
    try:
        for baud, par in combos(a):
            link.set(baud, par)
            print(f"\n[{baud} baud, 8{par}1] scan slave ID {a.id_min}-{a.id_max} "
                  f"({len(probes)} probe/ID, timeout {a.timeout}s)")
            hit_here = False
            noisy = 0
            for sid in ids:
                print(f"\r  cek ID {sid:3d} ...", end="", flush=True)
                for fc, pl in probes:
                    data = link.txrx(mb_frame(sid, fc, pl))
                    st, val = parse_mb(data, sid, fc)
                    if st == "ok":
                        print(f"\r  >> ID {sid}: FC{fc:02X} addr {a.probe_addr} "
                              f"BALAS DATA: {hexs(val)}      ")
                        found.append((baud, par, sid, fc, "data"))
                        hit_here = True
                        break
                    if st == "exc":
                        print(f"\r  >> ID {sid}: FC{fc:02X} BALAS EXCEPTION "
                              f"{val} ({EXC.get(val, '?')}) -> perangkat ADA      ")
                        found.append((baud, par, sid, fc, f"exc{val}"))
                        hit_here = True
                        break
                    if st == "bad":
                        noisy += 1
                        if noisy <= 10:
                            print(f"\r  ?  ID {sid}: balasan tidak valid: {hexs(data)}      "
                                  f"(bisa jadi baud/parity salah, atau bukan Modbus)")
            print("\r" + " " * 40)
            if hit_here and not a.all_combos:
                print("Ada respons pada kombinasi ini, berhenti (pakai --all-combos untuk lanjut).")
                break
    except KeyboardInterrupt:
        print("\nDihentikan.")
    finally:
        link.close()

    print("\n=== RINGKASAN ===")
    if not found:
        print("Tidak ada balasan Modbus yang valid. Coba: --baud all, kabel A/B ditukar,")
        print("jumper pin 1+4 dan 2+5 (lihat catatan), atau jalankan perintah 'yd'.")
    for baud, par, sid, fc, res in found:
        print(f"baud={baud} parity={par} slave={sid} FC{fc:02X} ({res})")
    if found:
        baud, par, sid, _, _ = found[0]
        print(f"\nLanjut: python esm_scan.py -p {a.port} dump --baud {baud} "
              f"--parity {par} --slave {sid} --end 300")


def cmd_yd(a):
    link = Link(a.port, timeout=a.timeout)
    cid1 = int(a.cid1, 0)
    ver = int(a.ver, 0)
    any_reply = False
    try:
        for baud, par in combos(a):
            link.set(baud, par)
            print(f"\n[{baud} baud, 8{par}1] probe YDN1363 ADR {a.adr_min}-{a.adr_max}, "
                  f"CID1=0x{cid1:02X}, VER=0x{ver:02X}")
            for adr in range(a.adr_min, a.adr_max + 1):
                for cid2, name in ((0x4F, "versi protokol"), (0x51, "info pabrikan")):
                    fr = yd_frame(adr, cid1, cid2, ver=ver)
                    data = link.txrx(fr)
                    if not data:
                        continue
                    any_reply = True
                    if data[:1] == b"~" and data[-1:] == b"\r":
                        rtn = data[7:9].decode(errors="replace")
                        print(f"  >> ADR {adr} CID2=0x{cid2:02X} ({name}) RTN={rtn}\n"
                              f"     {data!r}")
                    else:
                        print(f"  ?  ADR {adr} CID2=0x{cid2:02X} balasan bukan frame YDN1363:\n"
                              f"     {hexs(data)}  |{printable(data)}|")
    except KeyboardInterrupt:
        print("\nDihentikan.")
    finally:
        link.close()
    if not any_reply:
        print("\nTidak ada balasan sama sekali.")


def cmd_ident(a):
    link = Link(a.port, a.baud, a.parity, a.timeout)
    try:
        for fc, pl, name in ((0x11, b"", "Report Slave ID"),
                             (0x2B, bytes([0x0E, 0x01, 0x00]), "Read Device Identification")):
            data = link.txrx(mb_frame(a.slave, fc, pl))
            st, val = parse_mb(data, a.slave, fc)
            print(f"FC{fc:02X} {name}: ", end="")
            if st == "ok":
                print(f"{hexs(val)}  |{printable(val)}|")
            elif st == "exc":
                print(f"exception {val} ({EXC.get(val, '?')})")
            elif st == "bad":
                print(f"balasan tidak valid: {hexs(data)}")
            else:
                print("tidak ada balasan")
    finally:
        link.close()


def cmd_dump(a):
    link = Link(a.port, a.baud, a.parity, a.timeout)
    rows = []
    fcs = [int(x) for x in a.fc.split(",")]

    def emit(fc, addr, v):
        s16 = v - 0x10000 if v & 0x8000 else v
        rows.append((fc, addr, v, s16))
        print(f"  FC{fc:02d}  {addr:5d}  0x{addr:04X}   {v:5d}  {s16:6d}  0x{v:04X}   "
              f"{v / 10:9.1f}  {v / 100:9.2f}")

    try:
        for fc in fcs:
            print(f"\n== FC{fc:02d} | slave {a.slave} | {a.baud} 8{a.parity}1 | "
                  f"register {a.start}-{a.end} | block {a.block}")
            print("  FC     addr  addr_hex   uint    sint   hex        /10       /100")
            addr = a.start
            while addr <= a.end:
                qty = min(a.block, a.end - addr + 1)
                st, vals = read_regs(link, a.slave, fc, addr, qty)
                if st == "ok":
                    for i, v in enumerate(vals):
                        emit(fc, addr + i, v)
                elif qty > 1:
                    for i in range(qty):  # blok gagal -> cek satu per satu
                        st1, v1 = read_regs(link, a.slave, fc, addr + i, 1)
                        if st1 == "ok":
                            emit(fc, addr + i, v1[0])
                addr += qty
    except KeyboardInterrupt:
        print("\nDihentikan.")
    finally:
        link.close()

    if a.csv:
        with open(a.csv, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["fc", "address", "uint16", "int16"])
            w.writerows(rows)
        print(f"\n{len(rows)} register terbaca -> {a.csv}")
    else:
        print(f"\n{len(rows)} register terbaca.")


# --------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description="Pemindai RS485 read-only untuk Huawei ESM-48100B1")
    ap.add_argument("-p", "--port", help="contoh: COM5 atau /dev/ttyUSB0")
    ap.add_argument("--timeout", type=float, default=None, help="timeout balasan (detik); default 0.15, untuk yd 0.4")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("ports", help="daftar port serial")

    s = sub.add_parser("scan", help="cari baud/parity/slave ID Modbus")
    s.add_argument("--baud", default="9600", help="mis. 9600 atau 9600,19200 atau all")
    s.add_argument("--parity", default="N,E,O")
    s.add_argument("--id-min", type=int, default=1)
    s.add_argument("--id-max", type=int, default=247)
    s.add_argument("--probe-addr", type=int, default=0)
    s.add_argument("--fast", action="store_true", help="hanya FC03 (2x lebih cepat)")
    s.add_argument("--all-combos", action="store_true", help="lanjut walau sudah ada hit")

    y = sub.add_parser("yd", help="probe protokol YDN1363")
    y.add_argument("--baud", default="9600")
    y.add_argument("--parity", default="N,E,O")
    y.add_argument("--adr-min", type=int, default=0)
    y.add_argument("--adr-max", type=int, default=15)
    y.add_argument("--cid1", default="0x46")
    y.add_argument("--ver", default="0x20")

    for name in ("ident", "dump"):
        d = sub.add_parser(name)
        d.add_argument("--baud", type=int, default=9600)
        d.add_argument("--parity", default="N", choices=list(PARITY))
        d.add_argument("--slave", type=int, required=True)
        if name == "dump":
            d.add_argument("--fc", default="3,4", help="function code, mis. 3 atau 3,4")
            d.add_argument("--start", type=int, default=0)
            d.add_argument("--end", type=int, default=300)
            d.add_argument("--block", type=int, default=16, help="jumlah register per baca (1-100)")
            d.add_argument("--csv", help="simpan hasil ke file CSV")

    a = ap.parse_args()
    if a.cmd != "ports" and not a.port:
        ap.error("butuh -p/--port (lihat: python esm_scan.py ports)")
    if a.timeout is None:
        a.timeout = 0.4 if a.cmd == "yd" else 0.15
    if a.cmd == "dump" and not (1 <= a.block <= 100):
        ap.error("--block harus 1-100")

    {"ports": cmd_ports, "scan": cmd_scan, "yd": cmd_yd,
     "ident": cmd_ident, "dump": cmd_dump}[a.cmd](a)


if __name__ == "__main__":
    main()