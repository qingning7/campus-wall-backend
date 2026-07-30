import { Router } from "express"
import { prisma } from "../lib/prisma.js"
import { Prisma } from "../../generated/prisma/client.js"

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