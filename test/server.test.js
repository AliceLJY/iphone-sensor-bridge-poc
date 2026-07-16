"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const {
  clientKey,
  createBridge,
  createRateLimiter,
  isLoopbackHost,
  loadConfig,
  parseMultipart,
  readBody,
  readTokenFile,
  safeName,
  validateConfig,
} = require("../server");

const TEST_TOKEN = "test-only-bridge-token-0123456789";
const quietLogger = { log() {}, error() {} };

function uniqueInbox(label) {
  return path.join(os.tmpdir(), `iphone-sensor-bridge-poc-${label}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function testConfig(overrides = {}) {
  return {
    ...loadConfig({
      HOSTS: "127.0.0.1",
      PORT: "0",
      INBOX: uniqueInbox("inbox"),
      MAX_BODY: "1048576",
      BRIDGE_TOKEN: TEST_TOKEN,
      TRUST_PROXY: "false",
    }),
    ...overrides,
  };
}

async function withServer(config, fn) {
  const bridge = createBridge(config, quietLogger);
  const server = bridge.makeServer();
  assert.equal(server.requestTimeout, 0);
  assert.equal(server.headersTimeout, 60_000);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    return await fn(server);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function request(server, { method = "GET", pathname = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const address = server.address();
    const req = http.request({
      host: "127.0.0.1",
      port: address.port,
      method,
      path: pathname,
      headers,
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

test("non-loopback listeners fail closed without BRIDGE_TOKEN", () => {
  const inbox = uniqueInbox("blocked");
  const config = loadConfig({
    HOSTS: "0.0.0.0",
    PORT: "8765",
    INBOX: inbox,
    MAX_BODY: "1024",
    BRIDGE_TOKEN: "",
  });

  assert.throws(() => createBridge(config, quietLogger), /at least 32 characters/);
  assert.equal(fs.existsSync(inbox), false, "startup validation must run before creating the inbox");

  const entrypointInbox = uniqueInbox("entrypoint-blocked");
  const entrypoint = spawnSync(process.execPath, ["server.js"], {
    cwd: path.resolve(__dirname, ".."),
    env: {
      ...process.env,
      HOSTS: "0.0.0.0",
      PORT: "0",
      INBOX: entrypointInbox,
      MAX_BODY: "1024",
      BRIDGE_TOKEN: "",
    },
    encoding: "utf8",
  });
  assert.equal(entrypoint.status, 1);
  assert.equal(fs.existsSync(entrypointInbox), false, "refused entrypoint must not create runtime directories");

  const loopbackOnly = loadConfig({
    HOSTS: "127.0.0.1,::1",
    PORT: "8765",
    INBOX: uniqueInbox("loopback"),
    MAX_BODY: "1024",
    BRIDGE_TOKEN: "",
  });
  assert.doesNotThrow(() => validateConfig(loopbackOnly));
  assert.doesNotThrow(() => validateConfig(loadConfig({
    HOSTS: "0.0.0.0",
    PORT: "8765",
    INBOX: uniqueInbox("tailscale-ready"),
    MAX_BODY: "1024",
    BRIDGE_TOKEN: TEST_TOKEN,
  })));
  assert.throws(
    () => validateConfig(testConfig({ hosts: ["0.0.0.0"], token: "too-short" })),
    /at least 32 characters/,
  );
  assert.throws(
    () => validateConfig(testConfig({ hosts: ["0.0.0.0", "127.0.0.1"] })),
    /wildcard listen address/,
  );
  assert.equal(loadConfig({ HOSTS: "127.0.0.1,127.0.0.1" }).hosts.length, 1);
  assert.equal(isLoopbackHost("127.999.0.1"), false);
  assert.throws(
    () => validateConfig(testConfig({ token: "not bearer safe" })),
    /Bearer-safe/,
  );
});

test("private token files require a real user-owned mode-600 file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "iphone-sensor-token-"));
  const tokenFile = path.join(root, "token");
  const symlink = path.join(root, "token-link");
  try {
    fs.writeFileSync(tokenFile, TEST_TOKEN, { mode: 0o600 });
    fs.chmodSync(tokenFile, 0o600);
    assert.equal(readTokenFile(tokenFile), TEST_TOKEN);
    assert.equal(loadConfig({
      HOSTS: "0.0.0.0",
      BRIDGE_TOKEN_FILE: tokenFile,
      INBOX: uniqueInbox("token-file"),
    }).token, TEST_TOKEN);

    fs.chmodSync(tokenFile, 0o644);
    assert.throws(() => readTokenFile(tokenFile), /mode 600/);
    fs.chmodSync(tokenFile, 0o600);
    fs.symlinkSync(tokenFile, symlink);
    assert.throws(() => readTokenFile(symlink), /symbolic link/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("unauthenticated page is a credential shell and protected APIs require Bearer auth", async () => {
  const config = testConfig();
  await withServer(config, async (server) => {
    const root = await request(server);
    assert.equal(root.status, 200);
    assert.equal(root.body.includes(TEST_TOKEN), false, "GET / must not contain the server token");
    assert.equal(root.body.includes(config.inbox), false, "GET / must not expose protected inbox data");
    assert.match(root.body, /type="password"/);
    assert.match(root.body, /sessionStorage/);
    assert.doesNotMatch(root.body, /localStorage/);
    assert.match(root.body, /authorization/i);
    assert.doesNotMatch(root.body, /x-bridge-token/i);
    assert.match(root.headers["content-security-policy"], /frame-ancestors 'none'/);
    assert.equal(root.headers["x-frame-options"], "DENY");
    const browserScript = root.body.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(browserScript);
    assert.doesNotThrow(() => new Function(browserScript[1]));

    const health = await request(server, { pathname: "/api/health" });
    assert.equal(health.status, 200);
    assert.equal(Object.hasOwn(JSON.parse(health.body), "inbox"), false);

    const missing = await request(server, { pathname: "/api/items" });
    assert.equal(missing.status, 401);
    assert.match(missing.headers["www-authenticate"], /^Bearer /);

    const uploadWithoutAuth = await request(server, { method: "POST", pathname: "/api/upload" });
    assert.equal(uploadWithoutAuth.status, 401);
    const textWithoutAuth = await request(server, { method: "POST", pathname: "/api/text" });
    assert.equal(textWithoutAuth.status, 401);

    const legacy = await request(server, {
      pathname: "/api/items",
      headers: { "x-bridge-token": TEST_TOKEN },
    });
    assert.equal(legacy.status, 401);

    const wrong = await request(server, {
      pathname: "/api/items",
      headers: { authorization: "Bearer wrong-test-token" },
    });
    assert.equal(wrong.status, 401);

    const valid = await request(server, {
      pathname: "/api/items",
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    assert.equal(valid.status, 200);
    const data = JSON.parse(valid.body);
    assert.equal(data.inbox, config.inbox);
    assert.deepEqual(data.items, []);

    const declaredOversize = await request(server, {
      method: "POST",
      pathname: "/api/upload",
      headers: {
        authorization: `Bearer ${TEST_TOKEN}`,
        "content-length": String(config.maxBody + 1),
      },
    });
    assert.equal(declaredOversize.status, 413);
    assert.equal(declaredOversize.headers.connection, "close");
  });
});

test("readBody aborts the request as soon as the streaming limit is exceeded", async () => {
  const req = new EventEmitter();
  let destroyed = false;
  req.destroy = () => { destroyed = true; };

  const bodyPromise = readBody(req, 4);
  req.emit("data", Buffer.alloc(5));

  await assert.rejects(bodyPromise, (err) => {
    assert.equal(err.statusCode, 413);
    return true;
  });
  assert.equal(destroyed, true);
});

test("multipart parsing keeps file bytes and safeName removes traversal syntax", () => {
  const boundary = "unit-test-boundary";
  const body = Buffer.from(
    `--${boundary}\r\n` +
    'Content-Disposition: form-data; name="kind"\r\n\r\n' +
    'camera roll\r\n' +
    `--${boundary}\r\n` +
    'Content-Disposition: form-data; name="file"; filename="../../A weird?.txt"\r\n' +
    'Content-Type: text/plain\r\n\r\n' +
    'hello\r\n' +
    `--${boundary}--\r\n`,
    "latin1",
  );
  const parsed = parseMultipart({
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  }, body);

  assert.equal(parsed.fields.kind, "camera roll");
  assert.equal(parsed.files.length, 1);
  assert.equal(parsed.files[0].filename, "A_weird_.txt");
  assert.equal(parsed.files[0].data.toString("utf8"), "hello");
  assert.equal(safeName("..\\..\\secret name?.txt"), "secret_name_.txt");
  assert.equal(safeName(".."), "upload.bin");
  assert.ok(safeName("x".repeat(150)).length <= 100);
  assert.throws(
    () => parseMultipart({ headers: { "content-type": "multipart/form-data" } }, Buffer.alloc(0)),
    (err) => err.statusCode === 400,
  );
});

test("X-Forwarded-For is ignored unless TRUST_PROXY is explicit", () => {
  const req = {
    headers: { "x-forwarded-for": "203.0.113.9, 198.51.100.4" },
    socket: { remoteAddress: "100.64.0.1" },
  };

  assert.equal(clientKey(req), "100.64.0.1");
  assert.equal(clientKey(req, false), "100.64.0.1");
  assert.equal(clientKey(req, true), "203.0.113.9");
  assert.equal(loadConfig({ TRUST_PROXY: "true" }).trustProxy, true);
  assert.throws(() => loadConfig({ TRUST_PROXY: "implicit" }), /explicit true\/false/);
});

test("rate limiter sweeps entries after their window expires", () => {
  let now = 1_000;
  const limiter = createRateLimiter({ windowMs: 1_000, max: 2, now: () => now });
  const first = { headers: {}, socket: { remoteAddress: "client-a" } };
  const second = { headers: {}, socket: { remoteAddress: "client-b" } };

  assert.equal(limiter.check(first), true);
  assert.equal(limiter.entries.has("client-a"), true);
  now = 2_001;
  assert.equal(limiter.check(second), true);
  assert.equal(limiter.entries.has("client-a"), false);
  assert.equal(limiter.entries.has("client-b"), true);
});

test("tracked configuration contains no token value", () => {
  const root = path.resolve(__dirname, "..");
  const plist = fs.readFileSync(path.join(root, "launchd", "com.alice.iphone-sensor-bridge-poc.plist"), "utf8");
  assert.equal(plist.includes("<key>BRIDGE_TOKEN</key>"), false, "tracked plist must not define BRIDGE_TOKEN");
  assert.equal(plist.includes("<key>BRIDGE_TOKEN_FILE</key>"), true, "tracked plist should reference a private token file");

  const envExample = fs.readFileSync(path.join(root, ".env.example"), "utf8");
  const tokenLine = envExample.split(/\r?\n/).find((line) => line.startsWith("BRIDGE_TOKEN="));
  assert.equal(tokenLine === "BRIDGE_TOKEN=", true, "tracked env example must leave BRIDGE_TOKEN empty");
  const tokenFileLine = envExample.split(/\r?\n/).find((line) => line.startsWith("BRIDGE_TOKEN_FILE="));
  assert.equal(tokenFileLine === "BRIDGE_TOKEN_FILE=", true, "tracked env example must not contain a local path");
});
