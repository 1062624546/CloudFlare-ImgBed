# Telegram 断点续传 API

网页选择 Telegram 渠道上传大文件时，会保留会话 ID。上传失败后可点击重试，或在同一浏览器重新选择同一文件。网页按服务器确认的字节数显示进度。会话有效期为 72 小时，支持 2 GiB 以内的文件，分片为 16 MiB，最后一片按剩余字节发送。

Muse AI Studio 可以调用以下接口，继续使用现有的图床上传凭证。每个任务应保存 uploadId 和原始文件 SHA-256，以便进程重启后恢复。

| 方法 | 路径 | 请求与返回 |
| --- | --- | --- |
| POST | `/upload?telegramResume=init` | multipart 表单字段 `originalFileName`、`originalFileType`、`size`（字节）、`fingerprint`（小写 SHA-256）。返回 `uploadId`、`chunkSize`、`totalChunks`、`expiresAt`（Unix 毫秒）。初始化时可传现有 `channelName`、`uploadFolder`、`uploadNameType`、`expire` 查询参数。 |
| GET | `/upload?telegramResume=status&uploadId=ID` | 返回 `fingerprint`、`chunkSize`、`totalChunks`、`completed`（从 0 开始的分片序号）、`finalized`、`expiresAt`。 |
| POST | `/upload?telegramResume=part&uploadId=ID&index=0` | 请求体是原始分片字节，Content-Type 为 `application/octet-stream`。服务端登记 Telegram 返回的分片信息后响应成功。 |
| POST | `/upload?telegramResume=complete&uploadId=ID` | 登记一条完整文件记录。可传 `returnFormat=full&responseFormat=object` 获取对象格式的完整链接。 |

网页端每个 Telegram 续传任务最多并行上传 2 个分片。API 客户端可串行上传，或同时发送不同序号的分片。收到 429 时按 `Retry-After` 等待，网络中断或 5xx 可重试。收到 409 且返回 `completed` 时，可稍后查询状态并补传缺失分片。410 表示会话已失效，需要重新初始化。文件 SHA-256 用于客户端识别原始文件。分片接口校验每片大小。会话 ID 应和上传凭证一样保密。

播放器可使用普通 `/file/...` 地址，Telegram 分片的 Range 响应每次最多返回 16 MiB。外部下载器可循环请求 Range 并按 Content-Range 拼接，尤其是完整下载可能超过 Cloudflare 免费计划子请求额度的大文件。
