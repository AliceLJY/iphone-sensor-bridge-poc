const http = require("http");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { version: APP_VERSION } = require("./package.json");

const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 60;

function parseBoolean(value, name) {
  if (value === undefined || value === null || value === "") return false;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`${name} must be an explicit true/false value`);
}

function readTokenFile(filePath) {
  const fileStat = fs.lstatSync(filePath);
  if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
    throw new Error("BRIDGE_TOKEN_FILE must be a regular file, not a symbolic link");
  }
  if (typeof process.getuid === "function" && fileStat.uid !== process.getuid()) {
    throw new Error("BRIDGE_TOKEN_FILE must be owned by the current user");
  }
  if ((fileStat.mode & 0o777) !== 0o600) {
    throw new Error("BRIDGE_TOKEN_FILE must have mode 600");
  }
  return fs.readFileSync(filePath, "utf8").trim();
}

function loadConfig(env = process.env) {
  const hosts = [...new Set((env.HOSTS || env.HOST || "127.0.0.1")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean))];
  const tokenFile = typeof env.BRIDGE_TOKEN_FILE === "string" ? env.BRIDGE_TOKEN_FILE.trim() : "";
  const inlineToken = typeof env.BRIDGE_TOKEN === "string" ? env.BRIDGE_TOKEN.trim() : "";

  return {
    hosts,
    port: Number(env.PORT || 8765),
    token: inlineToken || (tokenFile ? readTokenFile(tokenFile) : ""),
    tokenFile,
    inbox: env.INBOX || path.join(os.homedir(), "Desktop", "iphone-sensor-inbox"),
    maxBody: Number(env.MAX_BODY || 200 * 1024 * 1024),
    trustProxy: parseBoolean(env.TRUST_PROXY, "TRUST_PROXY"),
    rateWindowMs: RATE_WINDOW_MS,
    rateMax: RATE_MAX,
  };
}

function isLoopbackHost(host) {
  const normalized = String(host || "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  return net.isIP(normalized) === 4 && normalized.split(".")[0] === "127";
}

function validateConfig(config) {
  if (!Array.isArray(config.hosts) || config.hosts.length === 0) {
    throw new Error("HOSTS must contain at least one listen address");
  }
  if (config.hosts.length > 1 && config.hosts.some((host) => host === "0.0.0.0" || host === "::")) {
    throw new Error("A wildcard listen address cannot be combined with additional HOSTS entries");
  }
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) {
    throw new Error("PORT must be an integer between 0 and 65535");
  }
  if (!Number.isFinite(config.maxBody) || config.maxBody <= 0) {
    throw new Error("MAX_BODY must be a positive number");
  }
  if (!Number.isFinite(config.rateWindowMs) || config.rateWindowMs <= 0) {
    throw new Error("rateWindowMs must be a positive number");
  }
  if (!Number.isInteger(config.rateMax) || config.rateMax <= 0) {
    throw new Error("rateMax must be a positive integer");
  }
  if (config.token.includes("\r") || config.token.includes("\n")) {
    throw new Error("BRIDGE_TOKEN must not contain line breaks");
  }
  if (config.token && !/^[A-Za-z0-9._~+\/-]+=*$/.test(config.token)) {
    throw new Error("BRIDGE_TOKEN must use Bearer-safe characters");
  }
  if (config.hosts.some((host) => !isLoopbackHost(host)) && config.token.length < 32) {
    throw new Error("A BRIDGE_TOKEN of at least 32 characters is required for every non-loopback listen address");
  }
  return config;
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function json(res, status, body, extraHeaders = {}) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": data.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extraHeaders,
  });
  res.end(data);
}

function html(res, body) {
  const data = Buffer.from(body);
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": data.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "permissions-policy": "camera=(self)",
  });
  res.end(data);
}

function notFound(res) {
  json(res, 404, { error: "not_found" });
}

function unauthorized(res) {
  json(res, 401, { error: "unauthorized" }, {
    "www-authenticate": 'Bearer realm="phone-file-drop"',
  });
}

function clientKey(req, trustProxy = false) {
  const remoteAddress = req.socket.remoteAddress || "unknown";
  if (!trustProxy) return remoteAddress;

  const header = req.headers["x-forwarded-for"];
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== "string") return remoteAddress;
  const forwarded = raw.split(",", 1)[0].trim();
  return forwarded ? forwarded.slice(0, 200) : remoteAddress;
}

function createRateLimiter({ windowMs, max, trustProxy = false, now = () => Date.now() }) {
  const entries = new Map();
  let nextSweepAt = 0;

  function cleanup(at) {
    if (at < nextSweepAt) return;
    for (const [key, entry] of entries) {
      if (at - entry.start >= windowMs) entries.delete(key);
    }
    nextSweepAt = at + windowMs;
  }

  function check(req) {
    const at = now();
    cleanup(at);
    const key = clientKey(req, trustProxy);
    const entry = entries.get(key) || { start: at, count: 0 };
    if (at - entry.start >= windowMs) {
      entry.start = at;
      entry.count = 0;
    }
    entry.count += 1;
    entries.set(key, entry);
    return entry.count <= max;
  }

  return { check, cleanup, entries };
}

function checkToken(req, expectedToken) {
  if (!expectedToken) return true;
  const header = req.headers.authorization;
  if (typeof header !== "string") return false;
  const match = header.match(/^Bearer[ \t]+(.+)$/i);
  if (!match) return false;

  const provided = Buffer.from(match[1].trim(), "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
      req.destroy();
    };
    req.on("data", (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > limit) {
        // 超限立即中断，不再收完整个 body（慢链路上省手机流量与时间）
        fail(Object.assign(new Error(`body_too_large_${Math.round(limit / 1024 / 1024)}MB_limit`), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", fail);
  });
}

function safeName(name) {
  const base = path.posix.basename(String(name || "upload.bin").replace(/\\/g, "/"));
  const sanitized = base.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 100);
  return !sanitized || sanitized === "." || sanitized === ".." ? "upload.bin" : sanitized;
}

function parseMultipart(req, body) {
  const contentType = req.headers["content-type"] || "";
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!match) throw Object.assign(new Error("missing_boundary"), { statusCode: 400 });

  const boundary = "--" + (match[1] || match[2]);
  const raw = body.toString("latin1");
  const parts = raw.split(boundary).slice(1, -1);
  const fields = {};
  const files = [];

  for (let part of parts) {
    if (part.startsWith("\r\n")) part = part.slice(2);
    const splitAt = part.indexOf("\r\n\r\n");
    if (splitAt < 0) continue;

    const headerBlock = part.slice(0, splitAt);
    let data = part.slice(splitAt + 4);
    if (data.endsWith("\r\n")) data = data.slice(0, -2);

    const nameMatch = headerBlock.match(/name="([^"]+)"/i);
    const filenameMatch = headerBlock.match(/filename="([^"]*)"/i);
    const typeMatch = headerBlock.match(/content-type:\s*([^\r\n]+)/i);
    const name = nameMatch ? nameMatch[1] : "";
    const mime = typeMatch ? typeMatch[1].trim().toLowerCase() : "text/plain";

    if (filenameMatch && filenameMatch[1]) {
      files.push({
        field: name,
        filename: safeName(filenameMatch[1]),
        mime,
        data: Buffer.from(data, "latin1"),
      });
    } else if (name) {
      fields[name] = Buffer.from(data, "latin1").toString("utf8");
    }
  }

  return { fields, files };
}

function latestItems(inbox) {
  let names;
  try {
    names = fs.readdirSync(inbox);
  } catch {
    return [];
  }
  return names
    .filter((name) => !name.startsWith("."))
    .sort()
    .reverse()
    .slice(0, 30)
    .map((name) => {
      // 单个坏条目（坏 symlink / 权限 / readdir-stat race）不应拖垮整个请求
      try {
        const stat = fs.statSync(path.join(inbox, name));
        if (!stat.isFile()) return null;
        return { name, size: stat.size, modified: stat.mtime.toISOString() };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function page(maxBody) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>Phone File Drop ${APP_VERSION}</title>
  <style>
    :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: Canvas; color: CanvasText; }
    main { max-width: 720px; margin: 0 auto; padding: 18px; }
    h1 { font-size: 24px; margin: 12px 0 6px; }
    p { color: color-mix(in srgb, CanvasText 72%, Canvas); line-height: 1.5; }
    section { border-top: 1px solid color-mix(in srgb, CanvasText 18%, Canvas); padding: 16px 0; }
    button, input, textarea { font: inherit; }
    button, label.pick { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; padding: 0 14px; margin: 5px 5px 5px 0; border: 1px solid color-mix(in srgb, CanvasText 22%, Canvas); border-radius: 8px; background: color-mix(in srgb, CanvasText 6%, Canvas); color: CanvasText; }
    button:disabled { opacity: 0.48; }
    input[type=password] { width: min(100%, 420px); box-sizing: border-box; min-height: 44px; border-radius: 8px; padding: 0 10px; border: 1px solid color-mix(in srgb, CanvasText 22%, Canvas); background: Canvas; color: CanvasText; }
    textarea { width: 100%; box-sizing: border-box; min-height: 96px; border-radius: 8px; padding: 10px; border: 1px solid color-mix(in srgb, CanvasText 22%, Canvas); background: Canvas; color: CanvasText; }
    input[type=file] { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
    #log { white-space: pre-wrap; overflow-wrap: anywhere; border-radius: 8px; padding: 12px; background: color-mix(in srgb, CanvasText 7%, Canvas); min-height: 100px; }
    .ok { color: #167a3c; }
    .bad { color: #b42318; }
    .muted { color: color-mix(in srgb, CanvasText 62%, Canvas); }
    .pill { display: inline-flex; align-items: center; min-height: 26px; padding: 0 8px; border-radius: 999px; background: color-mix(in srgb, CanvasText 8%, Canvas); font-size: 13px; }
  </style>
</head>
<body>
<main>
  <h1>Phone File Drop</h1>
  <p><span class="pill">${APP_VERSION}</span> 把手机里的图片和文件直接送到 Mac mini，不经过 iCloud / 微信 / WPS / 网盘。</p>

  <section>
    <strong>访问凭证</strong>
    <p class="muted">Token 只保存在当前浏览器标签页会话的 sessionStorage；关闭该会话后需要重新输入。</p>
    <input id="tokenInput" type="password" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="输入 BRIDGE_TOKEN">
    <button id="connect">连接</button>
    <button id="forgetToken">忘记 Token</button>
    <p id="authStatus" class="muted">尚未连接</p>
  </section>

  <section>
    <strong>Browser capability</strong>
    <p id="caps" class="muted">checking...</p>
  </section>

  <section>
    <strong>上传到 Mac 收件箱</strong>
    <label class="pick">拍照上传<input id="photo" data-auth-required type="file" accept="image/*" capture="environment" disabled></label>
    <label class="pick">选图片/文件<input id="files" data-auth-required type="file" multiple disabled></label>
    <p class="muted">单次上传上限约 ${Math.round(maxBody / 1024 / 1024)} MB。上传后复制下面这段给 cc-remote。</p>
    <textarea id="ccPrompt" readonly>先输入 Token 并连接。</textarea>
    <button id="copyPrompt" data-auth-required disabled>复制收件箱指令</button>
  </section>

  <section>
    <strong>发送一段文字</strong>
    <textarea id="textInput" placeholder="输入或粘贴一大段文字，直接发到 Mac 收件箱"></textarea>
    <button id="sendText" data-auth-required disabled>发送文字到 Mac</button>
  </section>

  <section>
    <strong>Result</strong>
    <div id="log"></div>
  </section>
</main>

<script>
const APP_VERSION = ${JSON.stringify(APP_VERSION)};
const SESSION_TOKEN_KEY = "phone-file-drop-token";
let INBOX = "";
let CC_PROMPT = "先输入 Token 并连接。";
let connected = false;
const logEl = document.getElementById("log");
const tokenInput = document.getElementById("tokenInput");
const authStatus = document.getElementById("authStatus");

function buildPrompt(names) {
  if (!INBOX) return "先输入 Token 并连接。";
  if (!names || !names.length) return "收件箱：" + INBOX + "\\n给 cc-remote：读取 mini 的这个收件箱中最新上传的文件，帮我处理。";
  return "收件箱：" + INBOX + "\\n给 cc-remote：读取 mini 收件箱里这次刚上传的文件，帮我处理：\\n  " + names.join("\\n  ");
}

function applyPrompt(names) {
  CC_PROMPT = buildPrompt(names);
  document.getElementById("ccPrompt").value = CC_PROMPT;
}

function setConnected(value) {
  connected = value;
  document.querySelectorAll("[data-auth-required]").forEach((element) => {
    element.disabled = !value;
  });
  authStatus.textContent = value ? "已通过应用层认证" : "尚未连接";
  authStatus.className = value ? "ok" : "muted";
  if (!value) {
    INBOX = "";
    applyPrompt([]);
  }
}

function authHeaders(initial) {
  const headers = new Headers(initial || {});
  const token = sessionStorage.getItem(SESSION_TOKEN_KEY) || "";
  if (token) headers.set("authorization", "Bearer " + token);
  return headers;
}

async function apiFetch(url, options) {
  const request = options || {};
  const response = await fetch(url, { ...request, headers: authHeaders(request.headers) });
  if (response.status === 401) setConnected(false);
  return response;
}

async function responseData(response) {
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { error: text || response.statusText };
  }
  if (!response.ok) throw new Error((data.error || response.statusText) + " (HTTP " + response.status + ")");
  return data;
}

async function connect() {
  const entered = tokenInput.value.trim();
  if (entered) sessionStorage.setItem(SESSION_TOKEN_KEY, entered);
  tokenInput.value = "";

  try {
    const response = await apiFetch("/api/items");
    const data = await responseData(response);
    INBOX = data.inbox;
    setConnected(true);
    applyPrompt([]);
    log(APP_VERSION + " ready, inbox: " + data.inbox + ", recent items: " + data.items.length, "ok");
  } catch (err) {
    setConnected(false);
    log("认证失败: " + err.message, "bad");
  }
}

function log(message, cls) {
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = "[" + new Date().toLocaleTimeString() + "] " + message;
  logEl.prepend(line);
}

function updateCaps() {
  const caps = [
    "secureContext=" + window.isSecureContext,
    "fileInput=true",
    "cameraCapture=" + Boolean(document.createElement("input").capture !== undefined),
  ];
  document.getElementById("caps").textContent = caps.join(" / ");
}

async function upload(kind, files) {
  if (!connected) throw new Error("请先输入 Token 并连接");
  if (!files || !files.length) return;
  const form = new FormData();
  form.append("kind", kind);
  for (const file of files) form.append("file", file, file.name || (kind + ".bin"));
  return uploadForm(form);
}

async function uploadForm(form) {
  const res = await apiFetch("/api/upload", {
    method: "POST",
    body: form,
  });
  const data = await responseData(res);
  const names = (data.saved || []).map((item) => item.name);
  if (!names.length) {
    log("没有文件被保存（可能选了空文件）", "bad");
    return data;
  }
  applyPrompt(names);
  log("上传成功: " + names.join(", "), "ok");
  log("下一步：复制下面已更新的 cc-remote 指令（已含本次文件名）。");
  return data;
}

document.getElementById("copyPrompt").onclick = async () => {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(CC_PROMPT);
    } else {
      const prompt = document.getElementById("ccPrompt");
      prompt.focus();
      prompt.select();
      document.execCommand("copy");
    }
    log("已复制 cc-remote 指令", "ok");
  } catch (err) {
    log("复制失败，手动选中那段文字复制即可: " + err.message, "bad");
  }
};

document.getElementById("connect").onclick = connect;
tokenInput.onkeydown = (event) => {
  if (event.key === "Enter") connect();
};
document.getElementById("forgetToken").onclick = () => {
  sessionStorage.removeItem(SESSION_TOKEN_KEY);
  tokenInput.value = "";
  setConnected(false);
  log("已清除当前浏览器会话中的 Token");
};

document.getElementById("photo").onchange = (event) => upload("photo", event.target.files).catch((err) => log("照片上传失败: " + err.message, "bad"));
document.getElementById("files").onchange = (event) => upload("file", event.target.files).catch((err) => log("文件上传失败: " + err.message, "bad"));

document.getElementById("sendText").onclick = async () => {
  const el = document.getElementById("textInput");
  const text = el.value.trim();
  if (!text) { log("文字是空的，先输入点内容", "bad"); return; }
  try {
    const res = await apiFetch("/api/text", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const data = await responseData(res);
    applyPrompt(data.saved.map((item) => item.name));
    log("文字已发送: " + data.saved[0].name + " (" + data.saved[0].size + " bytes)", "ok");
    log("下一步：复制下面已更新的 cc-remote 指令（已含本次文件名）。");
    el.value = "";
  } catch (err) {
    log("文字发送失败: " + err.message, "bad");
  }
};

updateCaps();
document.getElementById("ccPrompt").value = CC_PROMPT;
if (sessionStorage.getItem(SESSION_TOKEN_KEY)) connect();
</script>
</body>
</html>`;
}

async function handlePost(req, res, pathname, config) {
  const metaDir = path.join(config.inbox, ".meta");
  try {
    if (pathname === "/api/upload") {
      // 早拒：超限的上传不必收完整个 body 再报错
      const declared = Number(req.headers["content-length"] || 0);
      if (declared > config.maxBody) {
        return json(
          res,
          413,
          { error: `body_too_large_${Math.round(config.maxBody / 1024 / 1024)}MB_limit` },
          { connection: "close" },
        );
      }

      const body = await readBody(req, config.maxBody);
      const parsed = parseMultipart(req, body);
      const kind = safeName(parsed.fields.kind || "upload");

      // 任意文件类型都收（File Drop 不该只接受图片/音视频）；空 part 直接忽略。
      // 先过滤再统一写入，避免"前 N 个已落盘、第 N+1 个出错却报失败"的失真反馈。
      const files = parsed.files.filter((file) => file.data.length);
      const saved = [];

      for (const file of files) {
        const id = `${nowStamp()}_${kind}_${crypto.randomBytes(4).toString("hex")}`;
        const name = `${id}_${file.filename}`;
        const out = path.join(config.inbox, name);
        const meta = path.join(metaDir, `${name}.json`);
        fs.writeFileSync(out, file.data);
        fs.writeFileSync(meta, JSON.stringify({
          id,
          kind,
          originalName: file.filename,
          name,
          mime: file.mime,
          size: file.data.length,
          receivedAt: new Date().toISOString(),
          remote: clientKey(req, config.trustProxy),
          userAgent: req.headers["user-agent"] || "",
        }, null, 2));
        saved.push({ name, mime: file.mime, size: file.data.length });
      }

      return json(res, 200, { ok: true, saved });
    }

    if (pathname === "/api/text") {
      const textLimit = Math.min(config.maxBody, 5 * 1024 * 1024);
      const declared = Number(req.headers["content-length"] || 0);
      if (declared > textLimit) {
        return json(
          res,
          413,
          { error: `body_too_large_${Math.round(textLimit / 1024 / 1024)}MB_limit` },
          { connection: "close" },
        );
      }

      const body = await readBody(req, textLimit);
      let text = "";
      const ct = (req.headers["content-type"] || "").toLowerCase();
      if (ct.includes("application/json")) {
        try { text = String(JSON.parse(body.toString("utf8")).text || ""); } catch { text = ""; }
      } else if (ct.includes("application/x-www-form-urlencoded")) {
        text = new URLSearchParams(body.toString("utf8")).get("text") || "";
      } else {
        text = body.toString("utf8");
      }
      text = text.trim();
      if (!text) return json(res, 400, { error: "empty_text" });

      const id = `${nowStamp()}_text_${crypto.randomBytes(4).toString("hex")}`;
      const name = `${id}.txt`;
      const size = Buffer.byteLength(text, "utf8");
      fs.writeFileSync(path.join(config.inbox, name), text, "utf8");
      fs.writeFileSync(path.join(metaDir, `${name}.json`), JSON.stringify({
        id,
        kind: "text",
        name,
        mime: "text/plain",
        size,
        receivedAt: new Date().toISOString(),
        remote: clientKey(req, config.trustProxy),
        userAgent: req.headers["user-agent"] || "",
      }, null, 2));

      return json(res, 200, { ok: true, saved: [{ name, mime: "text/plain", size }] });
    }

    notFound(res);
  } catch (err) {
    if (res.headersSent || res.destroyed) return;
    const status = err.statusCode || 500;
    json(res, status, { error: status >= 500 ? "server_error" : (err.message || "bad_request") });
  }
}

function createBridge(config, logger = console) {
  validateConfig(config);
  const metaDir = path.join(config.inbox, ".meta");
  fs.mkdirSync(config.inbox, { recursive: true });
  fs.mkdirSync(metaDir, { recursive: true });

  const limiter = createRateLimiter({
    windowMs: config.rateWindowMs,
    max: config.rateMax,
    trustProxy: config.trustProxy,
  });

  const handler = async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      logger.log(`${new Date().toISOString()} ${req.method} ${url.pathname} ${clientKey(req, config.trustProxy)}`);

      if (req.method === "GET" && url.pathname === "/") return html(res, page(config.maxBody));
      if (req.method === "GET" && url.pathname === "/api/health") {
        return json(res, 200, { ok: true, version: APP_VERSION });
      }

      if (url.pathname.startsWith("/api/")) {
        if (!limiter.check(req)) return json(res, 429, { error: "rate_limited" });
        if (!checkToken(req, config.token)) return unauthorized(res);
      }

      if (req.method === "GET" && url.pathname === "/api/items") {
        return json(res, 200, { ok: true, inbox: config.inbox, items: latestItems(config.inbox) });
      }
      if (req.method === "POST") return handlePost(req, res, url.pathname, config);
      notFound(res);
    } catch (err) {
      // 任何 GET 处理异常都不该掀翻常驻进程（KeepAlive 会重启，但崩溃-重启循环本身是隐患）
      logger.error(`${new Date().toISOString()} handler error ${req.method}: ${err && err.message}`);
      if (!res.headersSent) json(res, 500, { error: "server_error" });
    }
  };

  function makeServer() {
    const server = http.createServer(handler);
    // 大文件经 Tailscale 慢速上传可能超过 Node 默认 5min requestTimeout 被掐断。
    server.requestTimeout = 0;
    // Headers do not contain the large body; keep a finite limit to avoid slow-header connection pinning.
    server.headersTimeout = 60_000;
    return server;
  }

  return { config, handler, limiter, makeServer };
}

function startServers(config = loadConfig(), logger = console) {
  const bridge = createBridge(config, logger);
  const servers = [];

  for (const host of config.hosts) {
    const server = bridge.makeServer();
    servers.push(server);
    server.listen(config.port, host, () => {
      logger.log(`Phone File Drop listening on http://${host}:${config.port}`);
      logger.log(`Saving uploads to ${config.inbox}`);
    });
    server.on("error", (err) => {
      logger.error(`listen failed for ${host}:${config.port}`, err);
      process.exitCode = 1;
      for (const candidate of servers) {
        if (candidate !== server && candidate.listening) candidate.close();
      }
    });
  }

  return servers;
}

if (require.main === module) {
  try {
    startServers();
  } catch (err) {
    console.error(`startup refused: ${err.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  APP_VERSION,
  checkToken,
  clientKey,
  createBridge,
  createRateLimiter,
  isLoopbackHost,
  loadConfig,
  parseMultipart,
  readTokenFile,
  readBody,
  safeName,
  startServers,
  validateConfig,
};
