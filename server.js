const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const HOSTS = (process.env.HOSTS || process.env.HOST || "127.0.0.1")
  .split(",")
  .map((host) => host.trim())
  .filter(Boolean);
const PORT = Number(process.env.PORT || 8765);
const TOKEN = process.env.BRIDGE_TOKEN || "sensor-bridge-dev-token";
const INBOX = process.env.INBOX || path.join(os.homedir(), "Desktop", "iphone-sensor-inbox");
const META_DIR = path.join(INBOX, ".meta");
const MAX_BODY = Number(process.env.MAX_BODY || 200 * 1024 * 1024);
const APP_VERSION = "v8";
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 60;

const rate = new Map();

fs.mkdirSync(INBOX, { recursive: true });
fs.mkdirSync(META_DIR, { recursive: true });

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function json(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": data.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
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
    "permissions-policy": "camera=(self)",
  });
  res.end(data);
}

function notFound(res) {
  json(res, 404, { error: "not_found" });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

function clientKey(req) {
  return req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";
}

function checkRate(req) {
  const key = clientKey(req);
  const now = Date.now();
  const entry = rate.get(key) || { start: now, count: 0 };
  if (now - entry.start > RATE_WINDOW_MS) {
    entry.start = now;
    entry.count = 0;
  }
  entry.count += 1;
  rate.set(key, entry);
  return entry.count <= RATE_MAX;
}

function checkToken(req) {
  return req.headers["x-bridge-token"] === TOKEN;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > limit) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) {
        reject(Object.assign(new Error(`body_too_large_${Math.round(limit / 1024 / 1024)}MB_limit`), { statusCode: 413 }));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

function safeName(name) {
  const base = path.basename(name || "upload.bin");
  return base.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 100) || "upload.bin";
}

function allowedMime(mime) {
  return /^image\//.test(mime)
    || /^audio\//.test(mime)
    || /^video\//.test(mime)
    || mime === "application/pdf"
    || mime === "text/plain"
    || mime === "application/octet-stream";
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

function latestItems() {
  return fs.readdirSync(INBOX)
    .filter((name) => !name.startsWith("."))
    .sort()
    .reverse()
    .slice(0, 30)
    .map((name) => {
      const file = path.join(INBOX, name);
      const stat = fs.statSync(file);
      return { name, size: stat.size, modified: stat.mtime.toISOString() };
    });
}

function page() {
  const ccPrompt = `收件箱：${INBOX}\n给 cc-remote：读取 mini 的这个收件箱中最新上传的文件，帮我处理。`;

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
    <strong>Browser capability</strong>
    <p id="caps" class="muted">checking...</p>
  </section>

  <section>
    <strong>上传到 Mac 收件箱</strong>
    <label class="pick">拍照上传<input id="photo" type="file" accept="image/*" capture="environment"></label>
    <label class="pick">选图片/文件<input id="files" type="file" multiple></label>
    <p class="muted">单次上传上限约 ${Math.round(MAX_BODY / 1024 / 1024)} MB。上传后复制下面这段给 cc-remote。</p>
    <textarea id="ccPrompt" readonly>${escapeHtml(ccPrompt)}</textarea>
    <button id="copyPrompt">复制收件箱指令</button>
  </section>

  <section>
    <strong>发送一段文字</strong>
    <textarea id="textInput" placeholder="输入或粘贴一大段文字，直接发到 Mac 收件箱"></textarea>
    <button id="sendText">发送文字到 Mac</button>
  </section>

  <section>
    <strong>Result</strong>
    <div id="log"></div>
  </section>
</main>

<script>
const TOKEN = ${JSON.stringify(TOKEN)};
const APP_VERSION = ${JSON.stringify(APP_VERSION)};
const CC_PROMPT = ${JSON.stringify(ccPrompt)};
const logEl = document.getElementById("log");

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
  if (!files || !files.length) return;
  const form = new FormData();
  form.append("kind", kind);
  for (const file of files) form.append("file", file, file.name || (kind + ".bin"));
  return uploadForm(form);
}

async function uploadForm(form) {
  const res = await fetch("/api/upload", {
    method: "POST",
    headers: { "x-bridge-token": TOKEN },
    body: form,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { error: text || res.statusText };
  }
  if (!res.ok) throw new Error((data.error || res.statusText) + " (HTTP " + res.status + ")");
  log("上传成功: " + data.saved.map((item) => item.name).join(", "), "ok");
  log("下一步：复制页面上的 cc-remote 指令。");
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

document.getElementById("photo").onchange = (event) => upload("photo", event.target.files).catch((err) => log("照片上传失败: " + err.message, "bad"));
document.getElementById("files").onchange = (event) => upload("file", event.target.files).catch((err) => log("文件上传失败: " + err.message, "bad"));

document.getElementById("sendText").onclick = async () => {
  const el = document.getElementById("textInput");
  const text = el.value.trim();
  if (!text) { log("文字是空的，先输入点内容", "bad"); return; }
  try {
    const res = await fetch("/api/text", {
      method: "POST",
      headers: { "x-bridge-token": TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error((data.error || res.statusText) + " (HTTP " + res.status + ")");
    log("文字已发送: " + data.saved[0].name + " (" + data.saved[0].size + " bytes)", "ok");
    log("下一步：复制页面上的 cc-remote 指令。");
    el.value = "";
  } catch (err) {
    log("文字发送失败: " + err.message, "bad");
  }
};

updateCaps();
document.getElementById("ccPrompt").value = CC_PROMPT;
fetch("/api/items")
  .then((r) => r.json())
  .then((data) => log(APP_VERSION + " ready, inbox: " + data.inbox + ", recent items: " + data.items.length, "ok"))
  .catch((err) => log(err.message, "bad"));
</script>
</body>
</html>`;
}

async function handlePost(req, res) {
  if (!checkRate(req)) return json(res, 429, { error: "rate_limited" });
  if (!checkToken(req)) return json(res, 401, { error: "bad_token" });

  try {
    if (req.url === "/api/upload") {
      const body = await readBody(req, MAX_BODY);
      const parsed = parseMultipart(req, body);
      const kind = safeName(parsed.fields.kind || "upload");
      const saved = [];

      for (const file of parsed.files) {
        if (!allowedMime(file.mime)) return json(res, 415, { error: "unsupported_mime", mime: file.mime });
        if (!file.data.length) continue;

        const id = `${nowStamp()}_${kind}_${crypto.randomBytes(4).toString("hex")}`;
        const name = `${id}_${file.filename}`;
        const out = path.join(INBOX, name);
        const meta = path.join(META_DIR, `${name}.json`);
        fs.writeFileSync(out, file.data);
        fs.writeFileSync(meta, JSON.stringify({
          id,
          kind,
          originalName: file.filename,
          name,
          mime: file.mime,
          size: file.data.length,
          receivedAt: new Date().toISOString(),
          remote: clientKey(req),
          userAgent: req.headers["user-agent"] || "",
        }, null, 2));
        saved.push({ name, mime: file.mime, size: file.data.length });
      }

      return json(res, 200, { ok: true, saved });
    }

    if (req.url === "/api/text") {
      const body = await readBody(req, 5 * 1024 * 1024);
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
      fs.writeFileSync(path.join(INBOX, name), text, "utf8");
      fs.writeFileSync(path.join(META_DIR, `${name}.json`), JSON.stringify({
        id,
        kind: "text",
        name,
        mime: "text/plain",
        size,
        receivedAt: new Date().toISOString(),
        remote: clientKey(req),
        userAgent: req.headers["user-agent"] || "",
      }, null, 2));

      return json(res, 200, { ok: true, saved: [{ name, mime: "text/plain", size }] });
    }

    notFound(res);
  } catch (err) {
    json(res, err.statusCode || 500, { error: err.message || "server_error" });
  }
}

function makeServer() {
  return http.createServer(async (req, res) => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.url} ${clientKey(req)}`);
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (req.method === "GET" && url.pathname === "/") return html(res, page());
  if (req.method === "GET" && url.pathname === "/api/health") return json(res, 200, { ok: true, inbox: INBOX });
  if (req.method === "GET" && url.pathname === "/api/items") return json(res, 200, { ok: true, inbox: INBOX, items: latestItems() });
  if (req.method === "POST") return handlePost(req, res);
  notFound(res);
  });
}

for (const host of HOSTS) {
  const server = makeServer();
  // 大文件经 Tailscale 慢速上传可能超过 Node 默认 5min requestTimeout 被掐断
  // （手机端表现为 "Failed to fetch" + 文件未落盘）。关掉超时让慢上传跑完。
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.listen(PORT, host, () => {
    console.log(`Phone File Drop listening on http://${host}:${PORT}`);
    console.log(`Saving uploads to ${INBOX}`);
  });
  server.on("error", (err) => {
    console.error(`listen failed for ${host}:${PORT}`, err);
  });
}
