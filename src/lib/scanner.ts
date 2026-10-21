import net from "node:net";
import type { Readable } from "node:stream";

export type ScanResult = { clean: true } | { clean: false; signature: string };

const CHUNK_SIZE = 64 * 1024;
const SCAN_TIMEOUT_MS = 2 * 60 * 1000;

function scannerMode() {
  const mode = process.env.MALWARE_SCANNER || "clamav";
  if (mode === "disabled" && process.env.NODE_ENV === "production") {
    throw new Error("MALWARE_SCANNER=disabled is not allowed in production.");
  }
  return mode;
}

// Streams the file to clamd using its INSTREAM protocol: length-prefixed chunks, then a zero-length chunk.
function scanWithClamd(stream: Readable): Promise<ScanResult> {
  const host = process.env.CLAMAV_HOST || "127.0.0.1";
  const port = Number(process.env.CLAMAV_PORT || 3310);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let reply = "";
    const fail = (error: Error) => {
      socket.destroy();
      stream.destroy();
      reject(error);
    };
    socket.setTimeout(SCAN_TIMEOUT_MS, () => fail(new Error("clamd timed out")));
    socket.on("error", fail);
    socket.on("data", data => { reply += data.toString("utf8"); });
    socket.on("end", () => {
      const text = reply.replace(/\0/g, "").trim();
      if (/^stream: OK$/.test(text)) return resolve({ clean: true });
      const found = text.match(/^stream: (.+) FOUND$/);
      if (found) return resolve({ clean: false, signature: found[1] });
      reject(new Error(`Unexpected clamd reply: ${text || "(empty)"}`));
    });
    socket.on("connect", async () => {
      try {
        socket.write("zINSTREAM\0");
        for await (const data of stream) {
          const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
          for (let offset = 0; offset < buffer.length; offset += CHUNK_SIZE) {
            const chunk = buffer.subarray(offset, offset + CHUNK_SIZE);
            const size = Buffer.alloc(4);
            size.writeUInt32BE(chunk.length);
            if (!socket.write(Buffer.concat([size, chunk]))) await new Promise(resume => socket.once("drain", resume));
          }
        }
        socket.end(Buffer.alloc(4));
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

export async function scanFile(stream: Readable): Promise<ScanResult> {
  if (scannerMode() === "disabled") {
    stream.destroy();
    console.warn("MALWARE_SCANNER=disabled: marking attachment clean without scanning (development only).");
    return { clean: true };
  }
  return scanWithClamd(stream);
}
