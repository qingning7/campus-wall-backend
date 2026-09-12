import type { Server } from "socket.io";

let io: Server | null = null;

export function setIo(nextIo: Server) {
  io = nextIo;
}

export function getIo() {
  if (!io) {
    throw new Error("Socket.io has not been initialized");
  }

  return io;
}
