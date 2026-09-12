import "dotenv/config";
import nodemailer from "nodemailer";

const host = process.env.SMTP_HOST;
const port = Number(process.env.SMTP_PORT);
const user = process.env.SMTP_USER;
const pass = process.env.SMTP_PASS;

if (!host || !user || !pass) {
  throw new Error("缺少 SMTP 配置，请检查后端 .env");
}

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("SMTP_PORT 必须是有效的端口号");
}

export const mailer = nodemailer.createTransport({
  host,
  port,
  secure: true,
  auth: {
    user,
    pass,
  },
});
