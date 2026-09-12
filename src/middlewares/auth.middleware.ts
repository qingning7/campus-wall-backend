import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

type JwtPayLoad = {
  userId: string;
};

export type AuthenticatedRequest = Request & {
  user?: {
    id: string;
  };
}; // 扩展一个带登录用户信息的请求类型

export function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({
      ok: false,
      message: "Authorization header is required",
    });
  }

  const [type, token] = authHeader.split(" ");

  if (type !== "Bearer" || !token) {
    return res.status(401).json({
      ok: false,
      message: "Invalid authorization header",
    });
  }

  const jwtSecret = process.env.JWT_SECRET;

  if (!jwtSecret) {
    throw new Error("JWT_SECRET is not set");
  }

  try {
    const payload = jwt.verify(token, jwtSecret) as JwtPayLoad;

    req.user = {
      id: payload.userId,
    }; // 验证token后，将用户ID添加到请求对象中

    next();
  } catch {
    return res.status(401).json({
      ok: false,
      message: "Invalid or expired token",
    });
  }
}
