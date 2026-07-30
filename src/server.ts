import express from "express"
import cors from "cors"
import dotenv from "dotenv"
import { prisma } from "./lib/prisma.js"
import { Prisma } from "../generated/prisma/client.js"
import { schoolRouter } from "./routes/school.routes.js"
import { authRouter } from "./routes/auth.routes.js"
import { roomRouter } from "./routes/room.routes.js"
import { createServer } from "node:http"
import { Server } from "socket.io"
import { registerSocketHandlers } from "./socket.js"

dotenv.config()

const app = express()

const httpServer = createServer(app)

export const io = new Server(httpServer, {
    cors: {
        origin: "*"
    }
})

registerSocketHandlers(io)

const port = process.env.PORT || 3001

app.use(cors())
app.use(express.json())
app.use("/api/schools", schoolRouter)
app.use("/api/auth", authRouter)
app.use("/api/rooms", roomRouter)
app.get("/api/health", async (req, res) => {
    res.json({
        ok: true,
        message: "Server is running",
    })
})

httpServer.listen(port, () => {
    console.log(`Server is running on port ${port}`)
})