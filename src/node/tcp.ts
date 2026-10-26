// TCP connections for the IMAP connection test, on Node's sockets.

import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { Readable, Writable } from "node:stream";
import type { TcpSocket } from "../runtime.ts";

export function connectTcp(host: string, port: number, tls: boolean): TcpSocket {
  const socket = tls ? tlsConnect({ host, port, servername: host }) : netConnect({ host, port });
  socket.on("error", () => {}); // the streams below report it to whoever is reading
  return {
    readable: Readable.toWeb(socket) as unknown as ReadableStream<Uint8Array>,
    writable: Writable.toWeb(socket) as unknown as WritableStream<Uint8Array>,
    async close() {
      socket.destroy();
    },
  };
}
