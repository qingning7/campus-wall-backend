import { mailer } from "./mailer.js"

export async function sendRegistrationCode(
    email: string,
    code: string,
) {
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
    })
}