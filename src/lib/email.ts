import { mailer } from "./mailer.js";

export async function sendRegistrationCode(email: string, code: string) {
  await mailer.sendMail({
    from: {
      name: "campus-wall",
      address: process.env.SMTP_USER!,
    },
    to: email,
    subject: "campus-wall 注册验证码",
    text: [
      `你的注册验证码是：${code}`,
      "",
      "验证码 10 分钟内有效，请勿向他人透露。",
      "如果不是你本人操作，请忽略这封邮件。",
    ].join("\n"),
  });
}

export async function sendPasswordResetCode(
  email: string,
  code: string,
) {
  await mailer.sendMail({
    from: {
      name: "campus-wall",
      address: process.env.SMTP_USER!,
    },
    to: email,
    subject: "campus-wall 重置密码",
    text: [
      `重置密码验证码：${code}`,
      "",
      "验证码 10 分钟内有效，仅用于重置当前账号的登录密码。",
      "请勿向他人透露验证码。",
      "如果不是你本人操作，请忽略这封邮件。",
    ].join("\n"),
  });
}
