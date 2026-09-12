import { mailer } from "../src/lib/mailer.js";

try {
  console.log("正在发送测试邮件……");

  const result = await mailer.sendMail({
    from: {
      name: "campus-wall",
      address: process.env.SMTP_USER!,
    },
    to: "18806119666@163.com",
    subject: "邮件发送测试",
    text: "^^ congratulations!",
  });

  console.log("SMTP 服务器已接受邮件");
  console.log("邮件编号：", result.messageId);
} catch (error) {
  console.error("测试邮件发送失败：", error);
  process.exitCode = 1;
} finally {
  mailer.close();
}
