# iPhone Sensor Bridge PoC

这是一个手机浏览器到 Mac 收件箱的本地投递 PoC，用来把手机里的照片和文件送到 Mac 侧目录。

## 当前状态

- `server.js` 是从救回文件恢复出来的 Codex 版本。
- 通过 `npm start` 启动时，上传文件会写入 `~/Desktop/iphone-sensor-inbox-v2`。
- 服务端口是 `8765`。
- 当前没有 npm 外部依赖。

## 启动

```sh
npm start
```

启动后，用手机打开本机或 Tailscale 暴露出来的地址。

## 验证

```sh
npm run check
curl -s http://127.0.0.1:8765/api/health
```

## mini 重启后自动运行

在 Mac mini 上执行：

```sh
npm run launchd:install
```

这会安装用户级 LaunchAgent：`com.alice.iphone-sensor-bridge-poc`。

## 后续 push

目前还没有配置 GitHub remote。GitHub 账号恢复后，在这个目录里加 remote 再推：

```sh
git remote add origin <repo-url>
git push -u origin main
```
