import jwt from "jsonwebtoken";
import type { Server, Socket } from "socket.io";
import { prisma } from "./lib/prisma.js";
import { RoomType } from "../generated/prisma/client.js";

type JwtPayload = {
  userId: string;
};

type AuthedSocket = Socket & {
  user?: {
    id: string;
  };
};

type StrokePoint = {
  x: number;
  y: number;
  pressure?: number;
};

export function registerSocketHandlers(io: Server) {
  io.use((socket: AuthedSocket, next) => {
    const token = socket.handshake.auth.token;

    if (!token || typeof token !== "string") {
      return next(new Error("Authentication token is required"));
    }

    const jwtSecret = process.env.JWT_SECRET;

    if (!jwtSecret) {
      return next(new Error("JWT_SECRET is not set"));
    }

    try {
      const payload = jwt.verify(token, jwtSecret) as JwtPayload;

      socket.user = {
        id: payload.userId,
      };

      next();
    } catch {
      next(new Error("Invalid or expired token"));
    }
  });
  async function canAccessRoom(roomId: string, userId: string) {
    const user = await prisma.user.findUnique({
      where: {
        id: userId,
      },
      select: {
        schoolId: true,
      },
    });

    if (!user) {
      return false;
    }

    const room = await prisma.room.findFirst({
      where: {
        id: roomId,
        OR: [
          {
            type: RoomType.SCHOOL,
            schoolId: user.schoolId,
          },
          {
            type: RoomType.PRIVATE,
            ownerId: userId,
          },
          {
            type: RoomType.PRIVATE,
            members: {
              some: {
                userId,
              },
            },
          },
        ],
      },
      select: {
        id: true,
      },
    });

    return !!room;
  }

  io.on("connection", (socket: AuthedSocket) => {
    console.log(`Socket connected: ${socket.id}, user: ${socket.user!.id}`);

    socket.on("join-room", async ({ roomId }: { roomId: string }) => {
      const allowed = await canAccessRoom(roomId, socket.user!.id);

      if (!allowed) {
        socket.emit("room-error", {
          message: "Room not found",
        });
        return;
      }

      socket.join(roomId);
      socket.emit("room-joined", { roomId });
    });

    socket.on(
      "room-stroke-point",
      ({
        roomId,
        strokeId,
        point,
      }: {
        roomId: string;
        strokeId: string;
        point: StrokePoint;
      }) => {
        if (!socket.rooms.has(roomId)) {
          return;
        }

        socket.to(roomId).emit("room-stroke-point", {
          roomId,
          authorId: socket.user!.id,
          strokeId,
          point,
        });
      },
    );
  });
}
