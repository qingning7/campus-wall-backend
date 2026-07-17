import express from "express"
import cors from "cors"
import dotenv from "dotenv"
import { prisma } from "./lib/prisma.js"
import { Prisma } from "../generated/prisma/client.js"

dotenv.config()

const app = express()

const port = process.env.PORT || 3001

app.use(cors())
app.use(express.json())

app.get("/api/health", async (req, res) => {
    res.json({
        ok: true,
        message: "Server is running",
    })
})

app.get("/api/schools", async (req, res) => {
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

app.post("/api/schools", async (req, res) => {
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

app.listen(port, () => {
    console.log(`Server is running on port ${port}`)
})