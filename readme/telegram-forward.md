# 同步 Telegram 群里的转发媒体

在图床里启用一个 Telegram 存储渠道，使用该渠道的机器人接收转发消息。将机器人加入指定群并设为管理员，或者在 BotFather 关闭群隐私模式后重新加入群。用同一机器人的 Token 设置 Webhook。

| 环境变量 | 配置 |
| --- | --- |
| `TELEGRAM_FORWARD_SECRET` | 长随机字符串。与 Telegram `setWebhook` 的 `secret_token` 相同，作为密钥保存。 |
| `TELEGRAM_FORWARD_CHAT_ID` | 允许同步的 Telegram 群数字 ID。 |
| `TELEGRAM_FORWARD_CHANNEL` | 图床中启用的 Telegram 渠道名称。 |
| `TELEGRAM_FORWARD_USER_ID` | 可选。设置自己的数字用户 ID 时，只同步自己转发的消息。 |
| `TELEGRAM_FORWARD_FOLDER` | 可选。后台目录，默认为 `telegram-forwards`。 |

通过 Telegram Bot API 的 `setWebhook` 设置 HTTPS 地址 `https://图床域名/api/telegram/forward`，并传入同一随机密钥及 `allowed_updates: ["message"]`。一个机器人只能注册一个 Webhook。已有其他服务使用该机器人的 Webhook 时，可另建一个 Telegram 渠道和机器人用于同步。

启用后，转发到指定群的图片和视频会使用 Telegram 文件 ID 登记到目录里，包括以文件形式转发的图片和视频。每条消息对应一个文件 ID，Telegram 重试回调时目录仍只显示一条。使用官方云端 Bot API 时，超过 20 MB 的群视频会跳过导入。大视频可以通过图床断点续传接口上传。同步只接收启用后的新转发消息。
