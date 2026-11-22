// A stand-in for Chromium in browser_login_flow.test.ts. It speaks just enough of
// the DevTools protocol for captureBrowserLogin to run end to end without a real
// browser or a network: GET /json/version, a WebSocket on the browser target,
// Storage.getCookies and Browser.close.
//
// Like Chromium, it writes DevToolsActivePort into the profile only when asked
// for --remote-debugging-port=0 (the mode Chromium also flags as automation).
//
//   FAKE_BROWSER_LOG      JSON lines: {event:"start",pid,args} and {event:"cdp",method}
//   FAKE_BROWSER_COOKIES  JSON array of cookies; those with "late": true only
//                         appear from the second Storage.getCookies on
//   FAKE_BROWSER_MODE     "login" (default) or "never" (the late cookies never come)
import http from "node:http";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const profile = flag("user-data-dir");
const wantedPort = Number(flag("remote-debugging-port"));
const logFile = process.env.FAKE_BROWSER_LOG;
const mode = process.env.FAKE_BROWSER_MODE ?? "login";
const cookies = JSON.parse(process.env.FAKE_BROWSER_COOKIES ?? "[]");
const log = (entry) => { if (logFile) appendFileSync(logFile, JSON.stringify(entry) + "\n"); };
const BROWSER_PATH = "/devtools/browser/fake-0001";

mkdirSync(profile, { recursive: true });
writeFileSync(join(profile, "Cookies"), "the session cookies would be in here");

function sendFrame(socket, obj) {
  const data = Buffer.from(JSON.stringify(obj));
  let header;
  if (data.length < 126) {
    header = Buffer.from([0x81, data.length]);
  } else if (data.length < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  socket.write(Buffer.concat([header, data]));
}

let polls = 0;
function onCdp(socket, msg) {
  log({ event: "cdp", method: msg.method, sessionId: msg.sessionId ?? null });
  if (msg.method === "Storage.getCookies") {
    polls++;
    const visible = cookies.filter((c) => !c.late || (mode === "login" && polls >= 2)).map(({ late: _late, ...c }) => c);
    sendFrame(socket, { id: msg.id, result: { cookies: visible } });
  } else if (msg.method === "Browser.close") {
    sendFrame(socket, { id: msg.id, result: {} });
    setTimeout(() => process.exit(0), 20);
  } else {
    sendFrame(socket, { id: msg.id, error: { message: `'${msg.method}' wasn't found` } });
  }
}

const server = http.createServer((req, res) => {
  if (req.url === "/json/version") {
    const port = server.address().port;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ Browser: "FakeChrome/1.0", webSocketDebuggerUrl: `ws://127.0.0.1:${port}${BROWSER_PATH}` }));
    return;
  }
  res.writeHead(404);
  res.end();
});
server.on("upgrade", (req, socket) => {
  if (req.url !== BROWSER_PATH) {
    socket.destroy();
    return;
  }
  const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  let buf = Buffer.alloc(0);
  socket.on("error", () => undefined);
  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      const total = off + (masked ? 4 : 0) + len;
      if (buf.length < total) return;
      const mask = masked ? buf.subarray(off, off + 4) : null;
      const payload = Buffer.from(buf.subarray(off + (masked ? 4 : 0), total));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      buf = buf.subarray(total);
      if (opcode === 0x8) {
        socket.end();
        return;
      }
      if (opcode === 0x1) onCdp(socket, JSON.parse(payload.toString("utf8")));
    }
  });
});

server.listen(wantedPort, "127.0.0.1", () => {
  const port = server.address().port;
  log({ event: "start", pid: process.pid, args, port });
  if (wantedPort === 0) writeFileSync(join(profile, "DevToolsActivePort"), `${port}\n${BROWSER_PATH}\n`);
});
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => process.exit(0));
