import jwt from "jsonwebtoken"
import type { Server, Socket } from "socket.io"

type JwtPayload = {
    userId: string
}

type AuthedSocket = Socket & {
    user?: {
        id: string
    }
}

export function registerSocketHandlers(io: Server) {
    io.use((socket: AuthedSocket, next) => {
        const token = socket.handshake.auth.token

        if (!token || typeof token !== "string") {
            return next(new Error("Authentication token is required"))
        }

        const jwtSecret = process.env.JWT_SECRET

        if (!jwtSecret) {
            return next(new Error("JWT_SECRET is not set"))
        }

        try {
            const payload = jwt.verify(token, jwtSecret) as JwtPayload

            socket.user = {
                id: payload.userId
            }

            next()
        } catch {
            next(new Error("Invalid or expired token"))
        }
    })

    io.on("connection", (socket: AuthedSocket) => {
        console.log(`Socket connected: ${socket.id}, user: ${socket.user!.id}`)
    })
}