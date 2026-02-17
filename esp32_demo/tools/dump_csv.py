#!/usr/bin/env python3
import sys
import time

try:
    import serial
except ImportError:
    print("pyserial missing. Install with: pip install pyserial")
    sys.exit(1)


def usage():
    print("Usage: dump_csv.py <serial_port> <output_csv>")


def main():
    if len(sys.argv) < 3:
        usage()
        sys.exit(1)
    port = sys.argv[1]
    out_path = sys.argv[2]
    ser = serial.Serial(port, 115200, timeout=1)
    time.sleep(0.2)
    ser.reset_input_buffer()
    ser.write(b"CSV_DUMP\n")
    ser.flush()

    collecting = False
    lines = []
    start_time = time.time()
    while True:
        line = ser.readline()
        if not line:
            if time.time() - start_time > 20:
                break
            continue
        text = line.decode(errors="ignore").strip()
        if text == "CSV_BEGIN":
            collecting = True
            continue
        if text.startswith("CSV_SIZE:"):
            continue
        if text == "CSV_END":
            break
        if collecting:
            lines.append(text)
        start_time = time.time()

    ser.close()
    if not lines:
        print("No CSV received.")
        sys.exit(1)

    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"Wrote {len(lines)} lines to {out_path}")


if __name__ == "__main__":
    main()
