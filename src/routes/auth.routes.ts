import { Router } from "express"
import bcrypt from "bcryptjs"
import { Prisma } from "../../generated/prisma/client.js"
import { prisma } from "../lib/prisma.js"
import jwt from "jsonwebtoken"
import { requireAuth, type AuthenticatedRequest } from "../middlewares/auth.middleware.js"
import { randomInt } from "node:crypto"
import { normalize } from "node:path"

export const authRouter = Router()

authRouter.post("/email-code", async (req, res) => {
    const { email } = req.body

    if (!email || typeof email !== "string") {
        return res.status(400).json({
            ok: false,
            message: "Email is required"
        })
    }

    const normalizedEmail = email.trim().toLowerCase()
    const existingUser = await prisma.user.findUnique({
        where: {
            email: normalizedEmail
        },
        select: {
            id: true
        }
    })

    if (existingUser) {
        return res.status(409).json({
            ok: false,
            message: "Email already used"
        })
    }

    const code = String(randomInt(1000, 10000))
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000)

    await prisma.emailVerificationCode.create({
        data: {
            email: normalizedEmail,
            code,
            purpose: "REGISTER",
            expiresAt
        }
    })

    res.json({
        ok: true,
        data: {
            message: "Verification code generated",
            devCode: code
        }
    })
})

authRouter.post("/register", async (req, res) => {
    const { email, name, password, schoolId, emailCode} = req.body

    if (typeof email !== "string" || typeof password !== "string" || !email.trim() || !password || !emailCode) {
        return res.status(400).json({
            ok:false,
            message: "Email, password and verification are required"
        })
    }

    if (password.length < 6) {
        return res.status(400).json({
            ok: false,
            message: "Password must be at least 6 characters"
        })
    }
    const normalizedEmail = email.trim().toLowerCase()

    const verificationCode = await prisma.emailVerificationCode.findFirst({
        where: {
            email: normalizedEmail,
            code: emailCode,
            purpose: "REGISTER",
            usedAt: null,
            expiresAt: {
                gt: new Date()
            }
        },
        orderBy: {
            createdAt: "desc"
        }
    })

    if (!verificationCode) {
        return res.status(400).json({
            ok: false,
            message: "Invalid or expired verification code"
        })
    }

    const passwordHash = await bcrypt.hash(password, 10)

    try {
        const user = await prisma.user.create({
            data: {
                email: normalizedEmail,
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

        await prisma.emailVerificationCode.update({
            where: {
                id: verificationCode.id
            },
            data: {
                usedAt: new Date()
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

    if (typeof email !== "string" || typeof password !== "string" || !email.trim() || !password) {
        return res.status(400).json({
            ok: false,
            message: "Email and password are required"
        })
    }

    const normalizedEmail = email.trim().toLowerCase()

    const user = await prisma.user.findUnique({
        where: {
            email: normalizedEmail
        },
        include: {
            school: {
                select: {
                    id: true,
                    name: true,
                    room: {
                        select: {
                            id: true,
                            type: true,
                            name: true,
                            code: true,
                            createdAt: true
                        }
                    }
                }
            }
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
                school: user.school,
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
            school: {
                select: {
                    id: true,
                    name: true,
                    room: {
                        select: {
                            id: true,
                            type: true,
                            name: true,
                            code: true,
                            createdAt: true
                        }
                    }
                }
            },
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

        await prisma.room.upsert({
            where: {
                schoolId
            },
            update: {},
            create: {
                type: "SCHOOL",
                schoolId,
                name: school.name
            }
        })

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
                school: {
                    select: {
                        id: true,
                        name: true,
                        room: {
                            select: {
                                id: true,
                                type: true,
                                name: true,
                                code: true,
                                createdAt: true
                            }
                        }
                    }
                },
                createdAt: true
            }
        })

        res.json({
            ok: true,
            data: user
        })
    }
)
