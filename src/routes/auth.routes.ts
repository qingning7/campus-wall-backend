import { Router } from "express";
import bcrypt from "bcryptjs";
import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import jwt from "jsonwebtoken";
import {
  requireAuth,
  type AuthenticatedRequest,
} from "../middlewares/auth.middleware.js";
import { randomInt } from "node:crypto";
import { normalize } from "node:path";
import {
  sendRegistrationCode,
  sendPasswordResetCode,
} from "../lib/email.js";

export const authRouter = Router();

authRouter.post("/email-code", async (req, res) => {
  const { email } = req.body;

  if (!email || typeof email !== "string") {
    return res.status(400).json({
      ok: false,
      message: "Email is required",
    });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const existingUser = await prisma.user.findUnique({
    where: {
      email: normalizedEmail,
    },
    select: {
      id: true,
    },
  });

  if (existingUser) {
    return res.status(409).json({
      ok: false,
      message: "Email already used",
    });
  }

  const code = String(randomInt(1000, 10000));
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  const verificationCode = await prisma.emailVerificationCode.create({
    data: {
      email: normalizedEmail,
      code,
      purpose: "REGISTER",
      expiresAt,
    },
  });

  try {
    await sendRegistrationCode(normalizedEmail, code);
  } catch {
    await prisma.emailVerificationCode.delete({
      where: {
        id: verificationCode.id,
      },
    });

    return res.status(502).json({
      ok: false,
      message: "Failed to send verification code",
    });
  }

  res.json({
    ok: true,
    data: {
      message: "验证码已发送，请查看邮箱",
    },
  });
});

authRouter.post("/register", async (req, res) => {
  const { email, name, password, schoolId, emailCode } = req.body;

  if (
    typeof email !== "string" ||
    typeof password !== "string" ||
    !email.trim() ||
    !password ||
    !emailCode
  ) {
    return res.status(400).json({
      ok: false,
      message: "Email, password and verification are required",
    });
  }

  if (password.length < 6) {
    return res.status(400).json({
      ok: false,
      message: "Password must be at least 6 characters",
    });
  }
  const normalizedEmail = email.trim().toLowerCase();

  const verificationCode = await prisma.emailVerificationCode.findFirst({
    where: {
      email: normalizedEmail,
      code: emailCode,
      purpose: "REGISTER",
      usedAt: null,
      expiresAt: {
        gt: new Date(),
      },
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  if (!verificationCode) {
    return res.status(400).json({
      ok: false,
      message: "Invalid or expired verification code",
    });
  }

  const passwordHash = await bcrypt.hash(password, 10);

  try {
    const user = await prisma.user.create({
      data: {
        email: normalizedEmail,
        name,
        passwordHash,
        schoolId,
      },
      select: {
        id: true,
        email: true,
        name: true,
        schoolId: true,
        createdAt: true,
      },
    });

    await prisma.emailVerificationCode.update({
      where: {
        id: verificationCode.id,
      },
      data: {
        usedAt: new Date(),
      },
    });

    res.status(201).json({
      ok: true,
      data: user,
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002" // judge error type
    ) {
      return res.status(409).json({
        ok: false,
        message: "Email already used",
      });
    }
    throw error;
  }
});

authRouter.post("/login", async (req, res) => {
  const { email, password } = req.body;

  if (
    typeof email !== "string" ||
    typeof password !== "string" ||
    !email.trim() ||
    !password
  ) {
    return res.status(400).json({
      ok: false,
      message: "Email and password are required",
    });
  }

  const normalizedEmail = email.trim().toLowerCase();

  const user = await prisma.user.findUnique({
    where: {
      email: normalizedEmail,
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
              createdAt: true,
            },
          },
        },
      },
    },
  });

  if (!user) {
    return res.status(401).json({
      ok: false,
      message: "Invalid email or password",
    });
  }

  const passwordMatched = await bcrypt.compare(password, user.passwordHash);

  if (!passwordMatched) {
    return res.status(401).json({
      ok: false,
      message: "Invalid email or password",
    });
  }

  const jwtSecret = process.env.JWT_SECRET;

  if (!jwtSecret) {
    throw new Error("JWT_SECRET is not set");
  }

  const token = jwt.sign(
    {
      userId: user.id,
    },
    jwtSecret,
    {
      expiresIn: "7d",
    },
  );

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
        createdAt: user.createdAt,
      },
    },
  });
});

authRouter.get("/me", requireAuth, async (req: AuthenticatedRequest, res) => {
  const user = await prisma.user.findUnique({
    where: {
      id: req.user!.id,
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
              createdAt: true,
            },
          },
        },
      },
      createdAt: true,
    },
  });

  if (!user) {
    return res.status(404).json({
      ok: false,
      message: "User not found",
    });
  }

  res.json({
    ok: true,
    data: user,
  });
});

authRouter.patch(
  "/me/school",
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    const { schoolId } = req.body;

    if (!schoolId) {
      return res.status(400).json({
        ok: false,
        message: "School id is required",
      });
    }

    const school = await prisma.school.findUnique({
      where: {
        id: schoolId,
      },
    });

    if (!school) {
      return res.status(404).json({
        ok: false,
        message: "School not found",
      });
    }

    await prisma.room.upsert({
      where: {
        schoolId,
      },
      update: {},
      create: {
        type: "SCHOOL",
        schoolId,
        name: school.name,
      },
    });

    const user = await prisma.user.update({
      where: {
        id: req.user!.id,
      },
      data: {
        schoolId,
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
                createdAt: true,
              },
            },
          },
        },
        createdAt: true,
      },
    });

    res.json({
      ok: true,
      data: user,
    });
  },
);

authRouter.patch(
  "/me/password",
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    const { currentPassword, newPassword } = req.body ?? {};

    if (
      typeof currentPassword !== "string" ||
      typeof newPassword !== "string" ||
      !currentPassword ||
      !newPassword
    ) {
      return res.status(400).json({
        ok: false,
        message: "请输入当前密码和新密码",
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        ok: false,
        message: "新密码至少需要 6 个字符",
      });
    }

    if (Buffer.byteLength(newPassword, "utf8") > 72) {
      return res.status(400).json({
        ok: false,
        message: "新密码过长，请控制在 72 字节以内",
      });
    }

    const user = await prisma.user.findUnique({
      where: {
        id: req.user!.id,
      },
      select: {
        id: true,
        passwordHash: true,
      },
    });

    if (!user) {
      return res.status(404).json({
        ok: false,
        message: "用户不存在",
      });
    }

    const passwordMatched = await bcrypt.compare(
      currentPassword,
      user.passwordHash,
    );

    if (!passwordMatched) {
      return res.status(400).json({
        ok: false,
        message: "当前密码不正确",
      });
    }

    const samePassword = await bcrypt.compare(newPassword, user.passwordHash);

    if (samePassword) {
      return res.status(400).json({
        ok: false,
        message: "新密码不能与当前密码相同",
      });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);

    await prisma.user.update({
      where: {
        id: user.id,
      },
      data: {
        passwordHash,
      },
      select: {
        id: true,
      },
    });

    res.json({
      ok: true,
      data: {
        message: "密码修改成功",
      },
    });
  },
);

authRouter.post(
  "/me/password/email-code",
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    const user = await prisma.user.findUnique({
      where: {
        id: req.user!.id,
      },
      select: {
        email: true,
      },
    });

    if (!user) {
      return res.status(404).json({
        ok: false,
        message: "用户不存在",
      });
    }

    const recentCode = await prisma.emailVerificationCode.findFirst({
      where: {
        email: user.email,
        purpose: "RESET_PASSWORD",
        createdAt: {
          gt: new Date(Date.now() - 60 * 1000),
        },
      },
    });

    if (recentCode) {
      return res.status(429).json({
        ok: false,
        message: "发送过于频繁，请稍后重试",
      });
    }

    const code = String(randomInt(100000, 1000000));
    const codeHash = await bcrypt.hash(code, 10);

    const verificationCode = await prisma.emailVerificationCode.create({
      data: {
        email: user.email,
        code: codeHash,
        purpose: "RESET_PASSWORD",
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    });

    try {
      await sendPasswordResetCode(user.email, code);
    } catch {
      await prisma.emailVerificationCode.delete({
        where: {
          id: verificationCode.id,
        },
      });

      return res.status(502).json({
        ok: false,
        message: "验证码邮件发送失败，请稍后重试",
      });
    }

    res.json({
      ok: true,
      data: {
        message: "验证码已发送，请查看绑定邮箱",
      },
    });
  },
);

authRouter.patch(
  "/me/password/reset",
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    const { emailCode, newPassword } = req.body ?? {};

    if (
      typeof emailCode !== "string" ||
      !/^\d{6}$/.test(emailCode.trim())
    ) {
      return res.status(400).json({
        ok: false,
        message: "请输入六位数字验证码",
      });
    }

    if (
      typeof newPassword !== "string" ||
      newPassword.length < 6
    ) {
      return res.status(400).json({
        ok: false,
        message: "新密码至少需要 6 个字符",
      });
    }

    if (Buffer.byteLength(newPassword, "utf8") > 72) {
      return res.status(400).json({
        ok: false,
        message: "新密码过长",
      });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: {
        id: true,
        email: true,
        passwordHash: true,
      },
    });

    if (!user) {
      return res.status(404).json({
        ok: false,
        message: "用户不存在",
      });
    }

    const verificationCode = await prisma.emailVerificationCode.findFirst({
      where: {
        email: user.email,
        purpose: "RESET_PASSWORD",
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    if (
      !verificationCode ||
      verificationCode.usedAt !== null ||
      verificationCode.expiresAt <= new Date()
    ) {
      return res.status(400).json({
        ok: false,
        message: "验证码已失效，请重新获取",
      });
    }

    const codeMatched = await bcrypt.compare(
      emailCode.trim(),
      verificationCode.code,
    );

    if (!codeMatched) {
      return res.status(400).json({
        ok: false,
        message: "验证码不正确",
      });
    }

    const samePassword = await bcrypt.compare(
      newPassword,
      user.passwordHash,
    );

    if (samePassword) {
      return res.status(400).json({
        ok: false,
        message: "新密码不能与当前密码相同",
      });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);

    const updated = await prisma.$transaction(async (tx) => {
      const consumed = await tx.emailVerificationCode.updateMany({
        where: {
          id: verificationCode.id,
          usedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: {
          usedAt: new Date(),
        },
      });

      if (consumed.count !== 1) {
        return false;
      }

      await tx.user.update({
        where: { id: user.id },
        data: { passwordHash },
        select: { id: true },
      });

      return true;
    });

    if (!updated) {
      return res.status(400).json({
        ok: false,
        message: "验证码已失效，请重新获取",
      });
    }

    res.json({
      ok: true,
      data: {
        message: "密码重置成功",
      },
    });
  },
);
