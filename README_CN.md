# iPhone Sensor Bridge PoC

这是一个零外部依赖的 Node.js 文件投递桥：手机通过受信任的局域网或 Tailscale 地址打开网页，把照片、文件和文字送到 Mac 收件箱。

## 安全边界

- `GET /` 是无需认证的应用外壳，不包含服务端 Token，也不包含受保护的收件箱信息。
- `GET /api/health` 可匿名访问，但只返回服务状态和版本。
- 配置 Token 后，其余 `/api/*` 路由都要求 `Authorization: Bearer <token>`。
- 旧的 `x-bridge-token` 请求头不再接受。
- 只要监听地址里有一个不是 loopback，启动时就必须通过 `BRIDGE_TOKEN` 或 `BRIDGE_TOKEN_FILE` 提供至少 32 字符、可用于 Bearer 的 Token，否则服务拒绝启动。仓库内不再提供固定或可预测的默认 Token。
- 网页要求用户手动输入 Token，只在当前浏览器标签页会话的 `sessionStorage` 中保留；Token 不进入 URL、HTML 或服务端生成的 JavaScript。
- 默认忽略 `X-Forwarded-For`。只有服务确实位于可信反向代理之后，而且代理会用已验证的客户端地址覆盖该请求头，或追加它直接观察到的客户端地址时，才设置 `TRUST_PROXY=true`。限流使用最右侧的有效地址，标准追加模式下，客户端伪造在左侧的值不能绕过限流。原样透传客户端请求头的代理不安全，不能启用该选项。

Tailscale 和 Bearer Token 管的是两层边界：Tailscale 决定哪些设备能连到这个 HTTP 服务，Token 决定哪些请求能查看收件箱信息或投递内容。不要把端口直接暴露到公网。直接走局域网时仍是明文 HTTP，只应在可信局域网或 Tailscale 路径中使用。

## 运行要求

- Node.js 18 或更高版本
- 不需要安装 npm 外部依赖

## 仅本机运行

只监听 loopback 时可以不设 Token：

```sh
npm start
```

默认地址为 `127.0.0.1:8765`，默认收件箱为 `~/Desktop/iphone-sensor-inbox-v2`。

## 局域网或 Tailscale 运行

先在本机生成高熵 Token，并保存在 Git 仓库之外的私有文件：

```sh
mkdir -p "$HOME/.config/iphone-sensor-bridge-poc"
chmod 700 "$HOME/.config/iphone-sensor-bridge-poc"
umask 077
openssl rand -hex 32 > "$HOME/.config/iphone-sensor-bridge-poc/token"
chmod 600 "$HOME/.config/iphone-sensor-bridge-poc/token"

cp .env.example .env
chmod 600 .env
```

编辑 `.env`：把 `HOSTS` 改成需要的非 loopback 地址，并设置 `BRIDGE_TOKEN_FILE=$HOME/.config/iphone-sensor-bridge-poc/token`。优先填写 Mac 的确切 Tailscale 地址；只有确实想让可信局域网访问时才用 `0.0.0.0`。启动前加载这份本机环境：

```sh
set -a
. ./.env
set +a
npm start
```

手机打开局域网或 Tailscale 地址后，输入同一个 Token 再连接。关闭该浏览器标签页会话后，网页保存的 Token 会被清除。

## 安装 LaunchAgent

仓库跟踪的 plist 和安装后的 LaunchAgent 都不包含 Token。安装脚本会隐藏输入内容，把 Token 存进 `~/.config/iphone-sensor-bridge-poc/token`（目录权限 `700`、文件权限 `600`），随后重启 LaunchAgent。服务会拒绝符号链接、错误属主、宽松权限和格式不合格的值：

```sh
npm run launchd:install
```

非交互安装时，可由本机 secret store 通过进程环境传入 `BRIDGE_TOKEN`；还可用 `BRIDGE_LISTEN_HOSTS`、`BRIDGE_INBOX`、`BRIDGE_NODE_BIN` 覆盖监听地址、收件箱或安装脚本自动找到的 Node 可执行文件，路径类覆盖值必须是绝对路径。仓库内的 plist 是可移植模板，安装脚本会按当前机器填入用户目录、仓库、可执行文件和日志路径。脚本不会打印 Token，也不会把它放进进程参数。运行该命令会改变正在运行的 LaunchAgent，因此只做代码审查时不要执行。

## 配置项

- `HOSTS`：逗号分隔的监听地址，默认 `127.0.0.1`。
- `PORT`：默认 `8765`。
- `INBOX`：投递目录，默认 `~/Desktop/iphone-sensor-inbox-v2`。
- `BRIDGE_TOKEN`：直接提供 Token；存在非 loopback 监听地址时至少 32 字符。
- `BRIDGE_TOKEN_FILE`：launchd 推荐的 Token 来源；必须是当前用户拥有、权限为 `600` 的普通文件。
- `MAX_BODY`：单次上传字节上限，默认 200 MiB。
- `TRUST_PROXY`：默认 false；只在直接访问已限制到可信反向代理，且代理会覆盖转发地址或追加它直接观察到的客户端地址时启用。

## 验证

```sh
npm run check
npm test
curl -s http://127.0.0.1:8765/api/health
```

受保护 API 的调用示例：

```sh
curl -H 'Authorization: Bearer <从本机-secret-store读取的-token>' \
  http://127.0.0.1:8765/api/items
```

CI 会在 Node.js 18、20、22 上运行语法检查和关键行为测试。

配置多个 `HOSTS` 时，所有地址都监听成功才算启动成功。任一地址绑定失败，服务会关闭已经打开的监听并以非零状态退出，让 launchd 重启，避免留下只开放部分地址的半残服务。

## GitHub remote

当前 clone 的 `origin` 是 `git@github.com:AliceLJY/iphone-sensor-bridge-poc.git`，对应 [AliceLJY/iphone-sensor-bridge-poc](https://github.com/AliceLJY/iphone-sensor-bridge-poc)。

## 为什么做这个项目

AirDrop 覆盖不了非 Apple 手机，也覆盖不了与目标 Mac 不在同一地点的场景。这个桥保留了原来的单用户体验：手机打开 Mac 的可信局域网或 Tailscale 地址，在网页里认证后上传，内容直接进入 Mac 收件箱，不必绕经 iCloud、聊天软件或网盘。
