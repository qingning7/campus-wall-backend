import express from "express"
import cors from "cors"
import dotenv from "dotenv"
import { prisma } from "./lib/prisma.js"
import { Prisma } from "../generated/prisma/client.js"
import { schoolRouter } from "./routes/school.routes.js"
import { authRouter } from "./routes/auth.routes.js"

dotenv.config()

const app = express()

const port = process.env.PORT || 3001

app.use(cors())
app.use(express.json())
app.use("/api/schools", schoolRouter)
app.use("/api/auth", authRouter)

app.get("/api/health", async (req, res) => {
    res.json({
        ok: true,
        message: "Server is running",
    })
})

app.listen(port, () => {
    console.log(`Server is running on port ${port}`)
})