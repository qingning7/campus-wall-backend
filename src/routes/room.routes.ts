import { Router } from "express"
import { prisma } from "../lib/prisma.js"

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

    const rooms = await prisma.room.findMany({
        where: {
            OR: [
                {
                    schoolId: user.schoolId
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