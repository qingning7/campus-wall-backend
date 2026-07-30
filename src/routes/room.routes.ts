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