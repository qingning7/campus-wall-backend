import { Router } from "express"
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