import { Router, type ErrorRequestHandler, type Request } from "express";
import bcrypt from "bcryptjs";
import { randomInt } from "node:crypto";
import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import {
  requireAuth,
  type AuthenticatedRequest,
} from "../middlewares/auth.middleware.js";
import { configuredAdminIds } from "../lib/admin-policy.js";
import { validateWallStrokeInput } from "../lib/wall-stroke.js";

type Realtime = {
  emitRoom: (roomId: string, event: string, payload: unknown) => void;
  disconnectUser: (userId: string) => void;
};
type Dependencies = {
  db: PrismaClient;
  realtime: Realtime;
  adminIds?: () => string[];
  audit?: (entry: Record<string, unknown>) => void;
};

class AdminError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
function text(
  value: unknown,
  label: string,
  max = 200,
  optional = false,
): string {
  if (optional && (value === undefined || value === null || value === ""))
    return "";
  if (typeof value !== "string" || !value.trim() || value.trim().length > max)
    throw new AdminError(400, `${label}不能为空且不能超过 ${max} 个字符`);
  return value.trim();
}
function body(req: Request): Record<string, unknown> {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body))
    throw new AdminError(400, "请求内容无效");
  return req.body;
}
function email(value: unknown) {
  const result = text(value, "邮箱", 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result))
    throw new AdminError(400, "邮箱格式无效");
  return result;
}
function listQuery(req: Request) {
  const rawPage = req.query.page ?? "1";
  if (typeof rawPage !== "string" || !/^[1-9]\d{0,5}$/.test(rawPage))
    throw new AdminError(400, "页码无效");
  const page = Number(rawPage);
  const q = text(req.query.q, "搜索内容", 100, true);
  return { page, q, skip: (page - 1) * 25, take: 25 };
}
const userSelect = {
  id: true,
  email: true,
  name: true,
  schoolId: true,
  createdAt: true,
  school: { select: { id: true, name: true } },
  _count: {
    select: { wallStrokes: true, chatMessages: true, ownedRooms: true },
  },
} satisfies Prisma.UserSelect;
const roomSelect = {
  id: true,
  name: true,
  code: true,
  type: true,
  ownerId: true,
  createdAt: true,
  school: { select: { id: true, name: true } },
  owner: { select: { id: true, email: true } },
  _count: { select: { wallStrokes: true, chatMessages: true, members: true } },
} satisfies Prisma.RoomSelect;

export function createAdminRouter({
  db,
  realtime,
  adminIds = configuredAdminIds,
  audit = (entry) =>
    console.info(JSON.stringify({ kind: "admin-audit", ...entry })),
}: Dependencies) {
  const router = Router();
  const log = (
    req: AuthenticatedRequest,
    action: string,
    targetId: string,
    count?: number,
  ) =>
    audit({
      at: new Date().toISOString(),
      actorId: req.user!.id,
      action,
      targetId,
      ...(count === undefined ? {} : { count }),
    });
  const confirm = (req: Request, id: string) => {
    if (body(req).confirmation !== id)
      throw new AdminError(400, "请输入完整目标 ID 确认删除");
  };
  router.use(requireAuth);
  router.use(async (req: AuthenticatedRequest, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    const id = req.user?.id;
    if (typeof id !== "string" || !adminIds().includes(id))
      return res
        .status(403)
        .json({ ok: false, message: "此账号没有管理员权限" });
    if (!(await db.user.findUnique({ where: { id }, select: { id: true } })))
      return res
        .status(401)
        .json({ ok: false, message: "账号不存在，请重新登录" });
    next();
  });
  router.get("/me", (req: AuthenticatedRequest, res) =>
    res.json({ ok: true, data: { id: req.user!.id } }),
  );

  router.get("/users", async (req, res) => {
    const { page, q, skip, take } = listQuery(req);
    const where: Prisma.UserWhereInput = q
      ? {
          OR: [
            { id: q },
            { email: { contains: q, mode: "insensitive" } },
            { name: { contains: q, mode: "insensitive" } },
          ],
        }
      : {};
    const [items, total] = await Promise.all([
      db.user.findMany({
        where,
        select: userSelect,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip,
        take,
      }),
      db.user.count({ where }),
    ]);
    res.json({
      ok: true,
      data: {
        items: items.map((u) => ({ ...u, isAdmin: adminIds().includes(u.id) })),
        total,
        page,
        pageSize: take,
      },
    });
  });
  router.post("/users", async (req: AuthenticatedRequest, res) => {
    const input = body(req);
    const userEmail = email(input.email);
    const name = text(input.name, "昵称", 80, true) || null;
    const password = input.password;
    if (
      typeof password !== "string" ||
      password.length < 8 ||
      Buffer.byteLength(password, "utf8") > 72
    )
      throw new AdminError(400, "初始密码至少 8 个字符，且不超过 72 字节");
    const user = await db.user.create({
      data: {
        email: userEmail,
        name,
        passwordHash: await bcrypt.hash(password, 10),
      },
      select: userSelect,
    });
    log(req, "user.create", user.id);
    res.status(201).json({ ok: true, data: user });
  });
  router.patch("/users/:id", async (req: AuthenticatedRequest, res) => {
    const id = text(req.params.id, "用户 ID");
    const input = body(req);
    const user = await db.user.update({
      where: { id },
      data: {
        email: email(input.email),
        name: text(input.name, "昵称", 80, true) || null,
      },
      select: userSelect,
    });
    log(req, "user.update", id);
    res.json({ ok: true, data: user });
  });
  router.delete("/users/:id", async (req: AuthenticatedRequest, res) => {
    const id = text(req.params.id, "用户 ID");
    confirm(req, id);
    if (adminIds().includes(id))
      throw new AdminError(
        409,
        "不能删除管理员账号，请先在服务器移除其管理员配置",
      );
    const result = await db.$transaction(async (tx) => {
      if (!(await tx.user.findUnique({ where: { id }, select: { id: true } })))
        throw new AdminError(404, "用户不存在");
      if (await tx.room.count({ where: { ownerId: id } }))
        throw new AdminError(409, "该用户仍拥有房间，请先处理其房间再删除账号");
      const rooms = await tx.room.findMany({
        where: {
          OR: [
            { wallStrokes: { some: { authorId: id } } },
            { chatMessages: { some: { authorId: id } } },
          ],
        },
        select: { id: true },
      });
      const strokes = await tx.wallStroke.deleteMany({
        where: { authorId: id },
      });
      const messages = await tx.chatMessage.deleteMany({
        where: { authorId: id },
      });
      await tx.roomMember.deleteMany({ where: { userId: id } });
      await tx.user.delete({ where: { id } });
      return { rooms, strokes: strokes.count, messages: messages.count };
    });
    realtime.disconnectUser(id);
    for (const room of result.rooms)
      realtime.emitRoom(room.id, "room-content-changed", { roomId: room.id });
    log(req, "user.delete", id);
    res.json({
      ok: true,
      data: { id, strokes: result.strokes, messages: result.messages },
    });
  });

  router.get("/rooms", async (req, res) => {
    const { page, q, skip, take } = listQuery(req);
    const where: Prisma.RoomWhereInput = q
      ? {
          OR: [
            { id: q },
            { code: q },
            { ownerId: q },
            { name: { contains: q, mode: "insensitive" } },
            { school: { name: { contains: q, mode: "insensitive" } } },
          ],
        }
      : {};
    const [items, total] = await Promise.all([
      db.room.findMany({
        where,
        select: roomSelect,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip,
        take,
      }),
      db.room.count({ where }),
    ]);
    res.json({ ok: true, data: { items, total, page, pageSize: take } });
  });
  router.post("/rooms", async (req: AuthenticatedRequest, res) => {
    const input = body(req);
    const name = text(input.name, "房间名称", 80);
    const ownerId = text(input.ownerId, "房主用户 ID");
    if (
      !(await db.user.findUnique({
        where: { id: ownerId },
        select: { id: true },
      }))
    )
      throw new AdminError(400, "房主用户不存在");
    const password = input.password;
    if (
      password !== undefined &&
      password !== "" &&
      (typeof password !== "string" ||
        password.length < 4 ||
        Buffer.byteLength(password, "utf8") > 72)
    )
      throw new AdminError(400, "房间密码至少 4 个字符，且不超过 72 字节");
    const passwordHash =
      typeof password === "string" && password
        ? await bcrypt.hash(password, 10)
        : null;
    const room = await db.room.create({
      data: {
        name,
        ownerId,
        type: "PRIVATE",
        code: String(randomInt(100000, 1000000)),
        passwordHash,
        members: { create: { userId: ownerId } },
      },
      select: roomSelect,
    });
    log(req, "room.create", room.id);
    res.status(201).json({ ok: true, data: room });
  });
  router.patch("/rooms/:id", async (req: AuthenticatedRequest, res) => {
    const id = text(req.params.id, "房间 ID");
    const room = await db.room.update({
      where: { id },
      data: { name: text(body(req).name, "房间名称", 80) },
      select: roomSelect,
    });
    log(req, "room.update", id);
    res.json({ ok: true, data: room });
  });
  router.delete("/rooms/:id", async (req: AuthenticatedRequest, res) => {
    const id = text(req.params.id, "房间 ID");
    confirm(req, id);
    await db.$transaction(async (tx) => {
      const room = await tx.room.findUnique({
        where: { id },
        select: { type: true },
      });
      if (!room) throw new AdminError(404, "房间不存在");
      if (room.type === "SCHOOL")
        throw new AdminError(409, "学校公共房间不能删除，可单独清空画板");
      await tx.wallStroke.deleteMany({ where: { roomId: id } });
      await tx.chatMessage.deleteMany({ where: { roomId: id } });
      await tx.roomMember.deleteMany({ where: { roomId: id } });
      await tx.room.delete({ where: { id } });
    });
    realtime.emitRoom(id, "room-content-changed", { roomId: id });
    log(req, "room.delete", id);
    res.json({ ok: true, data: { id } });
  });
  router.delete(
    "/rooms/:id/strokes",
    async (req: AuthenticatedRequest, res) => {
      const id = text(req.params.id, "房间 ID");
      confirm(req, id);
      const count = await db.$transaction(async (tx) => {
        if (
          !(await tx.room.findUnique({ where: { id }, select: { id: true } }))
        )
          throw new AdminError(404, "房间不存在");
        return (await tx.wallStroke.deleteMany({ where: { roomId: id } }))
          .count;
      });
      realtime.emitRoom(id, "room-content-changed", { roomId: id });
      log(req, "board.clear", id, count);
      res.json({ ok: true, data: { roomId: id, count } });
    },
  );

  router.get("/strokes", async (req, res) => {
    const { page, q, skip, take } = listQuery(req);
    const roomId = text(req.query.roomId, "房间 ID", 200, true);
    const where: Prisma.WallStrokeWhereInput = {
      ...(roomId ? { roomId } : {}),
      ...(q
        ? {
            OR: [
              { id: q },
              { authorId: q },
              { author: { email: { contains: q, mode: "insensitive" } } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      db.wallStroke.findMany({
        where,
        select: {
          id: true,
          roomId: true,
          authorId: true,
          color: true,
          size: true,
          createdAt: true,
          author: { select: { email: true, name: true } },
          room: { select: { name: true, school: { select: { name: true } } } },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip,
        take,
      }),
      db.wallStroke.count({ where }),
    ]);
    res.json({ ok: true, data: { items, total, page, pageSize: take } });
  });
  router.get("/strokes/:id", async (req, res) => {
    const id = text(req.params.id, "笔触 ID");
    const stroke = await db.wallStroke.findUnique({
      where: { id },
      select: { id: true, roomId: true, points: true, color: true, size: true },
    });
    if (!stroke) throw new AdminError(404, "笔触不存在");
    res.json({ ok: true, data: stroke });
  });
  router.delete("/strokes/:id", async (req: AuthenticatedRequest, res) => {
    const id = text(req.params.id, "笔触 ID");
    confirm(req, id);
    const roomId = text(body(req).roomId, "房间 ID");
    const count = (await db.wallStroke.deleteMany({ where: { id, roomId } }))
      .count;
    if (!count) throw new AdminError(404, "该房间内不存在此笔触");
    realtime.emitRoom(roomId, "room-stroke-deleted", { roomId, strokeId: id });
    log(req, "stroke.delete", id);
    res.json({ ok: true, data: { id, roomId } });
  });
  router.patch("/strokes/:id", async (req: AuthenticatedRequest, res) => {
    const id = text(req.params.id, "笔触 ID");
    const input = body(req);
    const roomId = text(input.roomId, "房间 ID");
    let style;
    try {
      style = validateWallStrokeInput({
        color: input.color,
        size: input.size,
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ],
      });
    } catch {
      throw new AdminError(400, "颜色需为 #RRGGBB，粗细需为 1 到 48 的整数");
    }
    const stroke = await db.wallStroke.update({
      where: { id, roomId },
      data: { color: style.color, size: style.size },
      select: {
        id: true,
        roomId: true,
        authorId: true,
        color: true,
        size: true,
        points: true,
        createdAt: true,
      },
    });
    realtime.emitRoom(roomId, "room-stroke", stroke);
    log(req, "stroke.update", id);
    res.json({ ok: true, data: { id, roomId } });
  });
  router.get("/messages", async (req, res) => {
    const { page, q, skip, take } = listQuery(req);
    const roomId = text(req.query.roomId, "房间 ID", 200, true);
    const where: Prisma.ChatMessageWhereInput = {
      ...(roomId ? { roomId } : {}),
      ...(q
        ? {
            OR: [
              { id: q },
              { authorId: q },
              { content: { contains: q, mode: "insensitive" } },
              { author: { email: { contains: q, mode: "insensitive" } } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      db.chatMessage.findMany({
        where,
        select: {
          id: true,
          roomId: true,
          authorId: true,
          content: true,
          createdAt: true,
          author: { select: { email: true } },
          room: { select: { name: true, school: { select: { name: true } } } },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip,
        take,
      }),
      db.chatMessage.count({ where }),
    ]);
    res.json({ ok: true, data: { items, total, page, pageSize: take } });
  });
  router.patch("/messages/:id", async (req: AuthenticatedRequest, res) => {
    const id = text(req.params.id, "消息 ID");
    const input = body(req);
    const roomId = text(input.roomId, "房间 ID");
    await db.chatMessage.update({
      where: { id, roomId },
      data: { content: text(input.content, "消息内容", 1000) },
      select: { id: true },
    });
    realtime.emitRoom(roomId, "room-content-changed", { roomId });
    log(req, "message.update", id);
    res.json({ ok: true, data: { id, roomId } });
  });
  router.delete("/messages/:id", async (req: AuthenticatedRequest, res) => {
    const id = text(req.params.id, "消息 ID");
    confirm(req, id);
    const roomId = text(body(req).roomId, "房间 ID");
    const { count } = await db.chatMessage.deleteMany({
      where: { id, roomId },
    });
    if (!count) throw new AdminError(404, "该房间内不存在此消息");
    realtime.emitRoom(roomId, "room-content-changed", { roomId });
    log(req, "message.delete", id);
    res.json({ ok: true, data: { id, roomId } });
  });
  const errorHandler: ErrorRequestHandler = (
    error: unknown,
    _req,
    res,
    _next,
  ) => {
    if (error instanceof AdminError)
      return res
        .status(error.status)
        .json({ ok: false, message: error.message });
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === "P2002")
        return res
          .status(409)
          .json({ ok: false, message: "邮箱或房间邀请码已存在，请检查后重试" });
      if (error.code === "P2025")
        return res
          .status(404)
          .json({ ok: false, message: "记录不存在或已被删除" });
      if (error.code === "P2003")
        return res
          .status(409)
          .json({ ok: false, message: "关联记录发生变化，请刷新后重试" });
    }
    console.error(
      "Admin request failed",
      error instanceof Error ? error.name : "UnknownError",
    );
    return res
      .status(500)
      .json({ ok: false, message: "管理操作失败，请查看服务器日志" });
  };
  router.use(errorHandler);
  return router;
}
