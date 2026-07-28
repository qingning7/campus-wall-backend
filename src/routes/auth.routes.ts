import { Router } from "express"
import bcrypt from "bcryptjs"
import { Prisma } from "../../generated/prisma/client.js"
import { prisma } from "../lib/prisma.js"
import jwt from "jsonwebtoken"
import { requireAuth, type AuthenticatedRequest } from "../middlewares/auth.middleware.js"

export const authRouter = Router()

authRouter.post("/register", async (req, res) => {
    const { email, name, password, schoolId} = req.body

    if (!email || !password) {
        return res.status(400).json({
            ok:false,
            message: "Email and password are required"
        })
    }

    if (password.length < 6) {
        return res.status(400).json({
            ok: false,
            message: "Password must be at least 6 characters"
        })
    }

    const passwordHash = await bcrypt.hash(password, 10)

    try {
        const user = await prisma.user.create({
            data: {
                email,
                name,
                passwordHash,
                schoolId
            },
            select: {
                id: true,
                email: true,
                name: true,
                schoolId: true,
                createdAt: true
            }
        })

        res.status(201).json({
            ok: true,
            data: user
        })
    } catch (error) {
        if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === "P2002" // judge error type
        ) {
            return res.status(409).json({
                ok: false,
                message: "Email already used"
            })
        }
        throw error
    }
})

authRouter.post("/login", async (req, res) => {
    const { email, password } = req.body

    if (!email || !password) {
        return res.status(400).json({
            ok: false,
            message: "Email and password are required"
        })
    }

    const user = await prisma.user.findUnique({
        where: {
            email
        }
    })

    if (!user) {
        return res.status(401).json({
            ok: false,
            message: "Invalid email or password"
        })
    }

    const passwordMatched = await bcrypt.compare(password, user.passwordHash)

    if (!passwordMatched) {
        return res.status(401).json({
            ok: false,
            message: "Invalid email or password"
        })
    }

    const jwtSecret = process.env.JWT_SECRET

    if (!jwtSecret) {
        throw new Error("JWT_SECRET is not set")
    }

    const token = jwt.sign(
        {
            userId: user.id
        },
        jwtSecret,
        {
            expiresIn: "7d"
        }
    )

    res.json({
        ok: true,
        data: {
            token,
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                schoolId: user.schoolId,
                createdAt: user.createdAt
            }
        }
    })
})

authRouter.get("/me", requireAuth, async (req: AuthenticatedRequest, res) => {
    const user = await prisma.user.findUnique({
        where: {
            id: req.user!.id
        },
        select: {
            id: true,
            email: true,
            name: true,
            schoolId: true,
            createdAt: true
        }
    })

    if (!user) {
        return res.status(404).json({
            ok: false,
            message: "User not found"
        })
    }

    res.json({
        ok: true,
        data: user
    })
})

authRouter.patch(
    "/me/school",
    requireAuth,
    async (req: AuthenticatedRequest, res) => {
        const { schoolId } = req.body

        if (!schoolId) {
            return res.status(400).json({
                ok: false,
                message: "School id is required"
            })
        }

        const school = await prisma.school.findUnique({
            where: {
                id: schoolId
            }
        })

        if (!school) {
            return res.status(404).json({
                ok: false,
                message: "School not found"
            })
        }

        const user = await prisma.user.update({
            where: {
                id: req.user!.id
            },
            data: {
                schoolId
            },
            select: {
                id: true,
                email: true,
                name: true,
                schoolId: true,
                createdAt: true
            }
        })

        res.json({
            ok: true,
            data: user
        })
    }
)
