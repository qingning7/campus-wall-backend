import { Router } from "express"
import { prisma } from "../lib/prisma.js"
import { Prisma, RoomType } from "../../generated/prisma/client.js"
import bcrypt from "bcryptjs"
import { randomInt } from "node:crypto"

import {
    requireAuth,
    type AuthenticatedRequest
} from "../middlewares/auth.middleware.js"

export const roomRouter = Router()
// 显示房间列表
roomRouter.get("/mine", requireAuth, async (req: AuthenticatedRequest, res) => {
    const userId = req.user!.id

    const user = await prisma.user.findUnique({
        where: {
            id: userId
        },
        select: {
            schoolId: true
        }
    })

    if (!user) {
        return res.status(404).json({
            ok: false,
            message: "User not found"
        })
    }

    const orConditions: Prisma.RoomWhereInput[] = [
        { ownerId: userId }, // 用户创建的房间
        { members: { some: { userId }}} // 用户作为成员加入过的房间
    ]

    if (user.schoolId) {
        orConditions.unshift({ schoolId: user.schoolId })
    } // 如果选择过学校，学校房间也算上

    const rooms = await prisma.room.findMany({
        where: {
            OR: orConditions
        },
        include: {
            school: {
                select: {
                    id: true,
                    name: true
                }
            }
        },
        orderBy: {
            createdAt: "desc"
        }
    })

    res.json({
        ok: true,
        data: rooms
    })
})
// 创建房间
roomRouter.post("/", requireAuth, async (req: AuthenticatedRequest, res) => {
    const userId = req.user!.id
    const { name, password } = req.body

    if (name && typeof name !== "string") {
        return res.status(400).json({
            ok: false,
            message: "Room must be a string"
        })
    }

    if (password && typeof password !== "string") {
        return res.status(400).json({
            ok: false,
            message: "Room password must be a string"
        })
    }

    if (password && password.length < 4) {
        return res.status(400).json({
            ok: false,
            message: "Room password must be at least 4 characters"
        })
    }

    const passwordHash = password ? await bcrypt.hash(password, 10) : null
    const code = String(randomInt(100000, 1000000))

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
                        userId
                    }
                }
            }
        })

        res.status(201).json({
            ok: true,
            data: room
        })
    } catch (error) {
        throw error
    }
})
// 加入房间
roomRouter.post("/join", requireAuth, async (req: AuthenticatedRequest, res) => {
    const userId = req.user!.id
    const { code, password } = req.body

    if (!code || typeof code !== "string") {
        return res.status(400).json({
            ok: false,
            message: "Room code is reqiured"
        })
    }

    const room = await prisma.room.findUnique({
        where: {
            code
        }
    })

    if (!room || room.type !== RoomType.PRIVATE) {
        return res.status(404).json({
            ok: false,
            message: "Room not found"
        })
    }

    if (room.passwordHash) {
        if (!password || typeof password !== "string") {
            return res.status(400).json({
                ok: false,
                message: "Room password is required"
            })
        }

        const passwordMatched = await bcrypt.compare(password, room.passwordHash)

        if (!passwordMatched) {
            return res.status(401).json({
                ok: false,
                message: "Invalid room password"
            })
        }
    }

    const member = await prisma.roomMember.upsert({
        where: {
            userId_roomId: {
                userId,
                roomId: room.id
            }
        },
        update: {},
        create: {
            userId,
            roomId: room.id
        }
    })

    res.json({
        ok: true,
        data: {
            room,
            member
        }
    })
})
// 获取历史消息
roomRouter.get(
    "/:roomId/messages",
    requireAuth,
    async (req: AuthenticatedRequest, res) => {
        const userId = req.user!.id
        const { roomId } = req.params
        if (!roomId || typeof roomId !== "string") {
            return res.status(400).json({
                ok: false,
                message: "Room id is required"
            })
        }

        const room = await prisma.room.findFirst({
            where: {
                id: roomId,
                OR: [
                    {
                        type: RoomType.SCHOOL
                    },
                    {
                        ownerId: userId
                    },
                    {
                        members: {
                            some: {
                                userId
                            }
                        }
                    }
                ]
            },
            select: {
                id: true
            }
        })

        if (!room) {
            return res.status(404).json({
                ok: false,
                message: "Room not found"
            })
        }

        const messages = await prisma.chatMessage.findMany({
            where: {
                roomId
            },
            include: {
                author: {
                    select: {
                        id: true,
                        name: true
                    }
                }
            },
            orderBy: {
                createdAt: "asc"
            },
            take: 50
        })

        res.json({
            ok: true,
            data: messages
        })
    }
)
// 添加消息
roomRouter.post(
    "/:roomId/messages",
    requireAuth,
    async (req: AuthenticatedRequest, res) => {
        const userId = req.user!.id
        const roomId = req.params.roomId
        const { content } = req.body

        if (!roomId || typeof roomId !== "string") {
            return res.status(400).json({
                ok: false,
                message: "Room id is required"
            })
        }

        if (!content || typeof content !== "string" || !content.trim()) {
            return res.status(400).json({
                ok: false,
                message: "Message content is required"
            })
        }

        const user = await prisma.user.findUnique({
            where: {
                id: userId
            },
            select: {
                schoolId: true
            }
        })

        if (!user) {
            return res.status(404).json({
                ok: false,
                message: "User not found"
            })
        }

        const orConditions: Prisma.RoomWhereInput[] = [
            { ownerId: userId },
            { members: { some: { userId } } }
        ]

        if (user.schoolId) {
            orConditions.unshift({ schoolId: user.schoolId })
        }

        const room = await prisma.room.findFirst({
            where: {
                id: roomId,
                OR: orConditions
            },
            select: {
                id: true
            }
        })

        if (!room) {
            return res.status(404).json({
                ok: false,
                message: "Room not found"
            })
        }

        const message = await prisma.chatMessage.create({
            data: {
                content: content.trim(),
                authorId: userId,
                roomId
            },
            include: {
                author: {
                    select: {
                        id: true,
                        name: true
                    }
                }
            }
        })

        res.status(201).json({
            ok: true,
            data: message
        })
    }
)