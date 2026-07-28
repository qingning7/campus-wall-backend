import { Router } from "express"
import { Prisma } from "../../generated/prisma/client.js"
import { prisma } from "../lib/prisma.js"

export const schoolRouter = Router()

schoolRouter.get("/", async (req, res) => {
    const schools = await prisma.school.findMany({
        orderBy: {
            createdAt: "desc"
        }
    })
    res.json({
        ok: true,
        data: schools
    })
})

schoolRouter.post("/", async (req, res) => {
    const { name } = req.body

    if (!name) {
        return res.status(400).json({
            ok: false,
            message: "School name is required"
        })
    }

    try {
        const school = await prisma.school.create({
            data: {
                name
            }
        })

        res.status(201).json({
            ok: true,
            data: school
        })
    } catch (error) {
        if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === "P2002"
        ) {
            return res.status(409).json({
                ok: false,
                message: "School name already exists"
            })
        }

        throw error
    }
})