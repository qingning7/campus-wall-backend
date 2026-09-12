import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { Prisma, RoomType } from "../../generated/prisma/client.js";
import bcrypt from "bcryptjs";
import { randomInt } from "node:crypto";

import {
  requireAuth,
  type AuthenticatedRequest,
} from "../middlewares/auth.middleware.js";

import { getIo } from "../lib/realtime.js";
import { create } from "node:domain";
import { validateWallStrokeInput } from "../lib/wall-stroke.js";

export const roomRouter = Router();
// 显示房间列表
roomRouter.get("/mine", requireAuth, async (req: AuthenticatedRequest, res) => {
  const userId = req.user!.id;

  const user = await prisma.user.findUnique({
    where: {
      id: userId,
    },
    select: {
      schoolId: true,
    },
  });

  if (!user) {
    return res.status(404).json({
      ok: false,
      message: "User not found",
    });
  }

  const orConditions: Prisma.RoomWhereInput[] = [
    { ownerId: userId }, // 用户创建的房间
    { members: { some: { userId } } }, // 用户作为成员加入过的房间
  ];

  if (user.schoolId) {
    orConditions.unshift({ schoolId: user.schoolId });
  } // 如果选择过学校，学校房间也算上

  const rooms = await prisma.room.findMany({
    where: {
      OR: orConditions,
    },
    include: {
      school: {
        select: {
          id: true,
          name: true,
        },
      },
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  res.json({
    ok: true,
    data: rooms,
  });
});
// 创建房间
roomRouter.post("/", requireAuth, async (req: AuthenticatedRequest, res) => {
  const userId = req.user!.id;
  const { name, password } = req.body;

  if (name && typeof name !== "string") {
    return res.status(400).json({
      ok: false,
      message: "Room must be a string",
    });
  }

  if (password && typeof password !== "string") {
    return res.status(400).json({
      ok: false,
      message: "Room password must be a string",
    });
  }

  if (password && password.length < 4) {
    return res.status(400).json({
      ok: false,
      message: "Room password must be at least 4 characters",
    });
  }

  const passwordHash = password ? await bcrypt.hash(password, 10) : null;
  const code = String(randomInt(100000, 1000000));

  try {
    const room = await prisma.room.create({
      data: {
        type: RoomType.PRIVATE,
        name,
        code,
        passwordHash,
        ownerId: userId,
        members: {
          create: {
            userId,
          },
        },
      },
    });

    res.status(201).json({
      ok: true,
      data: room,
    });
  } catch (error) {
    throw error;
  }
});
// 加入房间
roomRouter.post(
  "/join",
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    const userId = req.user!.id;
    const { code, password } = req.body;

    if (!code || typeof code !== "string") {
      return res.status(400).json({
        ok: false,
        message: "Room code is reqiured",
      });
    }

    const room = await prisma.room.findUnique({
      where: {
        code,
      },
    });

    if (!room || room.type !== RoomType.PRIVATE) {
      return res.status(404).json({
        ok: false,
        message: "Room not found",
      });
    }

    if (room.passwordHash) {
      if (!password || typeof password !== "string") {
        return res.status(400).json({
          ok: false,
          message: "Room password is required",
        });
      }

      const passwordMatched = await bcrypt.compare(password, room.passwordHash);

      if (!passwordMatched) {
        return res.status(401).json({
          ok: false,
          message: "Invalid room password",
        });
      }
    }

    const member = await prisma.roomMember.upsert({
      where: {
        userId_roomId: {
          userId,
          roomId: room.id,
        },
      },
      update: {},
      create: {
        userId,
        roomId: room.id,
      },
    });

    res.json({
      ok: true,
      data: {
        room,
        member,
      },
    });
  },
);
// 退出房间
roomRouter.post(
  "/:roomId/leave",
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    const userId = req.user!.id;
    const { roomId } = req.params;

    if (!roomId || typeof roomId !== "string") {
      return res.status(400).json({
        ok: false,
        message: "Room id is requires\d",
      });
    }

    const room = await prisma.room.findFirst({
      where: {
        id: roomId,
        type: RoomType.PRIVATE,
        OR: [
          {
            ownerId: userId,
          },
          {
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
        ownerId: true,
      },
    });

    if (!room) {
      return res.status(404).json({
        ok: false,
        message: "Room not found",
      });
    }

    if (room.ownerId === userId) {
      return res.status(400).json({
        ok: false,
        message: "Romm owner cannot leave room",
      });
    }

    await prisma.roomMember.delete({
      where: {
        userId_roomId: {
          userId,
          roomId,
        },
      },
    });

    res.json({
      ok: true,
      data: {
        roomId,
      },
    });
  },
);
// 删除房间
roomRouter.delete(
  "/:roomId",
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    const userId = req.user!.id;
    const { roomId } = req.params;

    if (!roomId || typeof roomId !== "string") {
      return res.status(400).json({
        ok: false,
        message: "Room id is required",
      });
    }

    const room = await prisma.room.findUnique({
      where: {
        id: roomId,
      },
      select: {
        id: true,
        ownerId: true,
        type: true,
      },
    });

    if (!room || room.type !== RoomType.PRIVATE) {
      return res.status(404).json({
        ok: false,
        message: "Room not found",
      });
    }

    if (room.ownerId !== userId) {
      return res.status(403).json({
        ok: false,
        message: "Only room owner can delete room",
      });
    }

    await prisma.$transaction([
      prisma.chatMessage.deleteMany({
        where: {
          roomId,
        },
      }),
      prisma.roomMember.deleteMany({
        where: {
          roomId,
        },
      }),
      prisma.room.delete({
        where: {
          id: roomId,
        },
      }),
    ]);

    res.json({
      ok: true,
      data: {
        roomId,
      },
    });
  },
);
//获取历史笔触
roomRouter.get(
  "/:roomId/strokes",
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    const userId = req.user!.id;
    const { roomId } = req.params;

    if (!roomId || typeof roomId !== "string") {
      return res.status(400).json({
        ok: false,
        message: "Room id is required",
      });
    }

    const user = await prisma.user.findUnique({
      where: {
        id: userId,
      },
      select: {
        schoolId: true,
      },
    });

    if (!user) {
      return res.status(404).json({
        ok: false,
        message: "User not found",
      });
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
            ownerId: userId,
          },
          {
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

    if (!room) {
      return res.status(404).json({
        ok: false,
        message: "Room not found",
      });
    }

    const strokes = await prisma.wallStroke.findMany({
      where: {
        roomId,
      },
      select: {
        id: true,
        color: true,
        size: true,
        points: true,
        createdAt: true,
        authorId: true,
        roomId: true,
      },
      orderBy: {
        createdAt: "asc",
      },
      take: 500,
    });

    res.json({
      ok: true,
      data: strokes,
    });
  },
);
// 获取历史消息
roomRouter.get(
  "/:roomId/messages",
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    const userId = req.user!.id;
    const { roomId } = req.params;
    if (!roomId || typeof roomId !== "string") {
      return res.status(400).json({
        ok: false,
        message: "Room id is required",
      });
    }

    const user = await prisma.user.findUnique({
      where: {
        id: userId,
      },
      select: {
        schoolId: true,
      },
    });

    if (!user) {
      return res.status(404).json({
        ok: false,
        message: "User not found",
      });
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
            ownerId: userId,
          },
          {
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

    if (!room) {
      return res.status(404).json({
        ok: false,
        message: "Room not found",
      });
    }

    const messages = await prisma.chatMessage.findMany({
      where: {
        roomId,
      },
      include: {
        author: {
          select: {
            id: true,
            name: true,
          },
        },
      },
      orderBy: {
        createdAt: "asc",
      },
      take: 50,
    });

    res.json({
      ok: true,
      data: messages,
    });
  },
);
// 添加笔触
roomRouter.post(
  "/:roomId/strokes",
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    const userId = req.user!.id;
    const { roomId } = req.params;

    if (!roomId || typeof roomId !== "string") {
      return res.status(400).json({
        ok: false,
        message: "Room id is required",
      });
    }

    const user = await prisma.user.findUnique({
      where: {
        id: userId,
      },
      select: {
        schoolId: true,
      },
    });

    if (!user) {
      return res.status(404).json({
        ok: false,
        message: "User not found",
      });
    }

    const room = await prisma.room.findUnique({
      where: {
        id: roomId,
        OR: [
          {
            type: RoomType.SCHOOL,
            schoolId: user.schoolId,
          },
          {
            ownerId: userId,
          },
          {
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

    if (!room) {
      return res.status(404).json({
        ok: false,
        message: "Room not found",
      });
    }

    let strokeInput;

    try {
      strokeInput = validateWallStrokeInput(req.body);
    } catch (error) {
      return res.status(400).json({
        ok: false,
        message: "Invalid stroke input",
      });
    }

    const strokeId =
      typeof req.body.strokeId === "string" ? req.body.strokeId : null;
    const stroke = await prisma.wallStroke.create({
      data: {
        roomId,
        authorId: userId,
        color: strokeInput.color,
        size: strokeInput.size,
        points: strokeInput.points,
      },
    });

    getIo()
      .to(roomId)
      .emit("room-stroke", {
        ...stroke,
        strokeId,
      });

    res.status(201).json({
      ok: true,
      data: {
        ...stroke,
        strokeId,
      },
    });
  },
);
// 删除笔触（撤销）
roomRouter.delete(
  "/:roomId/strokes/:strokeId",
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    const userId = req.user!.id;
    const { roomId, strokeId } = req.params;

    if (!roomId || typeof roomId !== "string") {
      return res.status(400).json({
        ok: false,
        message: "Room id is required",
      });
    }

    if (!strokeId || typeof strokeId !== "string") {
      return res.status(400).json({
        ok: false,
        message: "Stroke id is required",
      });
    }

    const user = await prisma.user.findUnique({
      where: {
        id: userId,
      },
      select: {
        schoolId: true,
      },
    });

    if (!user) {
      return res.status(404).json({
        ok: false,
        message: "User not found",
      });
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

    if (!room) {
      return res.status(404).json({
        ok: false,
        message: "Room not found",
      });
    }

    const stroke = await prisma.wallStroke.findFirst({
      where: {
        id: strokeId,
        roomId,
      },
      select: {
        authorId: true,
        points: true,
      },
    });

    if (!stroke) {
      return res.status(404).json({
        ok: false,
        message: "Stoke not found",
      });
    }

    if (stroke.authorId !== userId) {
      return res.status(403).json({
        ok: false,
        message: "Only stroke author can delete stroke",
      });
    }

    const deleted = await prisma.wallStroke.deleteMany({
      where: {
        id: strokeId,
        roomId,
        authorId: userId,
      },
    });

    if (deleted.count === 0) {
      return res.status(404).json({
        ok: false,
        message: "Stroke not found",
      });
    }

    getIo().to(roomId).emit("room-stroke-deleted", {
      roomId,
      strokeId,
      points: stroke.points,
    });

    res.json({
      ok: true,
      data: {
        roomId,
        strokeId,
        points: stroke.points,
      },
    });
  },
);
// 添加消息（接入socket后可删）
roomRouter.post(
  "/:roomId/messages",
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    const userId = req.user!.id;
    const roomId = req.params.roomId;
    const { content } = req.body;

    if (!roomId || typeof roomId !== "string") {
      return res.status(400).json({
        ok: false,
        message: "Room id is required",
      });
    }

    if (!content || typeof content !== "string" || !content.trim()) {
      return res.status(400).json({
        ok: false,
        message: "Message content is required",
      });
    }

    const user = await prisma.user.findUnique({
      where: {
        id: userId,
      },
      select: {
        schoolId: true,
      },
    });

    if (!user) {
      return res.status(404).json({
        ok: false,
        message: "User not found",
      });
    }

    const orConditions: Prisma.RoomWhereInput[] = [
      {
        type: RoomType.SCHOOL,
        schoolId: user.schoolId,
      },
      { ownerId: userId },
      { members: { some: { userId } } },
    ];

    const room = await prisma.room.findFirst({
      where: {
        id: roomId,
        OR: orConditions,
      },
      select: {
        id: true,
      },
    });

    if (!room) {
      return res.status(404).json({
        ok: false,
        message: "Room not found",
      });
    }

    const message = await prisma.chatMessage.create({
      data: {
        content: content.trim(),
        authorId: userId,
        roomId,
      },
      include: {
        author: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    getIo().to(roomId).emit("room-message", message);

    res.status(201).json({
      ok: true,
      data: message,
    });
  },
);
