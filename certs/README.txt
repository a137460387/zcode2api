此目录存放 farm 页 HTTPS 证书（gitignore）。
来源 A：mkcert 生成 localhost-key.pem + localhost.pem。
来源 B：直接复制 D:\code\Ai\zcode-proxy\certs\ 下的同名文件（CA 已装本机）。
没有证书时 farm 服务自动用 HTTP（Chrome 视 localhost 为安全上下文，SDK 通常可用）。
