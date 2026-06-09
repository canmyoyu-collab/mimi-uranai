const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// .env 読み込み（ローカル開発用）
const ENV_PATH = path.join(__dirname, ".env");
if (fs.existsSync(ENV_PATH)) {
  fs.readFileSync(ENV_PATH, "utf8").split("\n").forEach(line => {
    const m = line.match(/^([^=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim();
  });
}

function saveApiKey(key) {
  fs.writeFileSync(ENV_PATH, `ANTHROPIC_API_KEY=${key}\n`, "utf8");
  process.env.ANTHROPIC_API_KEY = key;
}

const PORT = process.env.PORT || 3456;

// ── Instagram キーワード返信 データ管理 ──────────────────

const DATA_PATH = path.join(__dirname, "data", "ig-config.json");

function loadData() {
  try {
    if (fs.existsSync(DATA_PATH)) {
      return JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
    }
  } catch (e) {}
  return { instagram: {}, rules: [], logs: [] };
}

function saveData(data) {
  const dir = path.dirname(DATA_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), "utf8");
}

function generateId() {
  return crypto.randomBytes(8).toString("hex");
}

function sendJson(res, statusCode, obj) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

// ── Instagram Graph API ───────────────────────────────────

function igApiPost(apiPath, body, accessToken) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const options = {
      hostname: "graph.facebook.com",
      path: `${apiPath}?access_token=${encodeURIComponent(accessToken)}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(bodyStr),
      },
    };
    const req = https.request(options, (r) => {
      let data = "";
      r.on("data", c => (data += c));
      r.on("end", () => {
        try { resolve({ status: r.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: r.statusCode, body: data }); }
      });
    });
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

// ── キーワードマッチング ──────────────────────────────────

function matchesKeywords(text, rule) {
  const lower = text.toLowerCase();
  if (rule.matchType === "all") {
    return rule.keywords.every(kw => lower.includes(kw.toLowerCase()));
  }
  return rule.keywords.some(kw => lower.includes(kw.toLowerCase()));
}

// ── Webhook イベント処理 ──────────────────────────────────

async function processComment(igUserId, commentId, commentText, fromId, fromUsername) {
  const data = loadData();
  const { pageAccessToken } = data.instagram || {};
  if (!pageAccessToken || !igUserId) return;

  const enabledRules = (data.rules || []).filter(r => r.enabled);

  for (const rule of enabledRules) {
    if (!matchesKeywords(commentText, rule)) continue;

    const logEntry = {
      id: generateId(),
      timestamp: new Date().toISOString(),
      commentId,
      commentText,
      commenterId: fromId,
      commenterUsername: fromUsername || "",
      ruleId: rule.id,
      ruleName: rule.name,
      replyType: rule.replyType,
      sent: false,
      error: null,
    };

    try {
      let result;
      if (rule.replyType === "dm" && fromId) {
        result = await igApiPost(
          `/v19.0/${igUserId}/messages`,
          { recipient: { id: fromId }, message: { text: rule.message } },
          pageAccessToken
        );
      } else if (rule.replyType === "comment" && commentId) {
        result = await igApiPost(
          `/v19.0/${commentId}/replies`,
          { message: rule.message },
          pageAccessToken
        );
      }
      if (result?.body?.error) {
        logEntry.error = JSON.stringify(result.body.error);
      } else {
        logEntry.sent = true;
      }
    } catch (err) {
      logEntry.error = err.message;
    }

    data.logs = [logEntry, ...(data.logs || [])].slice(0, 500);
    saveData(data);
    break; // 最初にマッチしたルールのみ実行
  }
}

async function processWebhookPayload(rawBody) {
  const payload = JSON.parse(rawBody);
  if (payload.object !== "instagram") return;
  const data = loadData();
  const igUserId = data.instagram?.instagramAccountId;

  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== "comments") continue;
      const v = change.value;
      if (v?.verb !== "add" || !v?.text) continue;
      await processComment(igUserId, v.id, v.text, v.from?.id, v.from?.username);
    }
  }
}

// ── HTTP サーバー ─────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  let parsedUrl;
  try {
    parsedUrl = new URL(req.url, "http://localhost");
  } catch {
    res.writeHead(400);
    res.end("Bad request");
    return;
  }
  const pathname = parsedUrl.pathname;

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    });
    res.end();
    return;
  }

  // ── POST /api/setup ──────────────────────────────────
  if (req.method === "POST" && pathname === "/api/setup") {
    const body = await readBody(req);
    try {
      const { key } = JSON.parse(body);
      if (!key || !key.startsWith("sk-ant-")) {
        sendJson(res, 400, { ok: false, message: "sk-ant- から始まるキーを入力してください" });
        return;
      }
      saveApiKey(key);
      sendJson(res, 200, { ok: true });
    } catch {
      sendJson(res, 400, { ok: false });
    }
    return;
  }

  // ── GET /api/status ──────────────────────────────────
  if (req.method === "GET" && pathname === "/api/status") {
    const ready = !!(process.env.ANTHROPIC_API_KEY?.startsWith("sk-ant-"));
    sendJson(res, 200, { ready });
    return;
  }

  // ── POST /api/analyze → Anthropic proxy ──────────────
  if (req.method === "POST" && pathname === "/api/analyze") {
    const API_KEY = process.env.ANTHROPIC_API_KEY;
    if (!API_KEY) {
      sendJson(res, 503, { error: { message: "APIキーが設定されていません" } });
      return;
    }

    let body = "";
    let bodySize = 0;
    req.on("data", chunk => {
      bodySize += chunk.length;
      if (bodySize > 20 * 1024 * 1024) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "画像が大きすぎます。もう少し小さいサイズで撮り直してください。" } }));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on("end", () => {
      const options = {
        hostname: "api.anthropic.com",
        path: "/v1/messages",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": API_KEY,
          "anthropic-version": "2023-06-01",
        },
      };
      const proxy = https.request(options, (upstream) => {
        res.writeHead(upstream.statusCode, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        upstream.pipe(res);
      });
      proxy.on("error", (err) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: err.message } }));
      });
      proxy.write(body);
      proxy.end();
    });
    return;
  }

  // ── GET /webhook (Facebook Webhook 認証) ─────────────
  if (req.method === "GET" && pathname === "/webhook") {
    const mode = parsedUrl.searchParams.get("hub.mode");
    const token = parsedUrl.searchParams.get("hub.verify_token");
    const challenge = parsedUrl.searchParams.get("hub.challenge");
    const data = loadData();
    const verifyToken = data.instagram?.verifyToken;

    if (mode === "subscribe" && verifyToken && token === verifyToken) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(challenge);
    } else {
      res.writeHead(403);
      res.end("Forbidden");
    }
    return;
  }

  // ── POST /webhook (Instagram コメントイベント) ────────
  if (req.method === "POST" && pathname === "/webhook") {
    const rawBody = await readBody(req);
    // Facebook は 20 秒以内に 200 を要求するので即座に返す
    res.writeHead(200);
    res.end("EVENT_RECEIVED");
    processWebhookPayload(rawBody).catch(e => console.error("Webhook processing error:", e));
    return;
  }

  // ── GET /api/ig/config ───────────────────────────────
  if (req.method === "GET" && pathname === "/api/ig/config") {
    const data = loadData();
    const cfg = { ...(data.instagram || {}) };
    // トークンはマスク表示
    if (cfg.pageAccessToken) {
      cfg.pageAccessToken = "****" + cfg.pageAccessToken.slice(-4);
    }
    sendJson(res, 200, cfg);
    return;
  }

  // ── POST /api/ig/config ──────────────────────────────
  if (req.method === "POST" && pathname === "/api/ig/config") {
    const body = await readBody(req);
    try {
      const updates = JSON.parse(body);
      const data = loadData();
      // マスクされたトークンが送られた場合は上書きしない
      if (updates.pageAccessToken?.startsWith("****")) {
        delete updates.pageAccessToken;
      }
      data.instagram = { ...data.instagram, ...updates };
      if (!data.instagram.verifyToken) {
        data.instagram.verifyToken = crypto.randomBytes(16).toString("hex");
      }
      saveData(data);
      sendJson(res, 200, { ok: true, verifyToken: data.instagram.verifyToken });
    } catch {
      sendJson(res, 400, { ok: false });
    }
    return;
  }

  // ── GET /api/ig/rules ────────────────────────────────
  if (req.method === "GET" && pathname === "/api/ig/rules") {
    const data = loadData();
    sendJson(res, 200, data.rules || []);
    return;
  }

  // ── POST /api/ig/rules ───────────────────────────────
  if (req.method === "POST" && pathname === "/api/ig/rules") {
    const body = await readBody(req);
    try {
      const rule = JSON.parse(body);
      const data = loadData();
      rule.id = generateId();
      rule.createdAt = new Date().toISOString();
      rule.enabled = rule.enabled !== false;
      data.rules = [...(data.rules || []), rule];
      saveData(data);
      sendJson(res, 201, rule);
    } catch {
      sendJson(res, 400, { ok: false });
    }
    return;
  }

  // ── PUT/DELETE /api/ig/rules/:id ─────────────────────
  const ruleMatch = pathname.match(/^\/api\/ig\/rules\/([a-f0-9]+)$/);
  if (ruleMatch) {
    const id = ruleMatch[1];
    if (req.method === "PUT") {
      const body = await readBody(req);
      try {
        const updates = JSON.parse(body);
        const data = loadData();
        const idx = (data.rules || []).findIndex(r => r.id === id);
        if (idx === -1) { sendJson(res, 404, { ok: false }); return; }
        data.rules[idx] = { ...data.rules[idx], ...updates };
        saveData(data);
        sendJson(res, 200, data.rules[idx]);
      } catch {
        sendJson(res, 400, { ok: false });
      }
      return;
    }
    if (req.method === "DELETE") {
      const data = loadData();
      data.rules = (data.rules || []).filter(r => r.id !== id);
      saveData(data);
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  // ── GET /api/ig/logs ─────────────────────────────────
  if (req.method === "GET" && pathname === "/api/ig/logs") {
    const data = loadData();
    sendJson(res, 200, data.logs || []);
    return;
  }

  // ── DELETE /api/ig/logs ──────────────────────────────
  if (req.method === "DELETE" && pathname === "/api/ig/logs") {
    const data = loadData();
    data.logs = [];
    saveData(data);
    sendJson(res, 200, { ok: true });
    return;
  }

  // ── GET /instagram → instagram-admin.html ─────────────
  if (req.method === "GET" && pathname === "/instagram") {
    const file = path.join(__dirname, "instagram-admin.html");
    fs.readFile(file, (err, d) => {
      if (err) { res.writeHead(404); res.end("Not found"); return; }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(d);
    });
    return;
  }

  // ── GET / → index.html ───────────────────────────────
  if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
    const file = path.join(__dirname, "index.html");
    fs.readFile(file, (err, d) => {
      if (err) { res.writeHead(404); res.end("Not found"); return; }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(d);
    });
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`✨ 耳占い婚活診断 起動中 → http://localhost:${PORT}`);
  console.log(`📱 Instagram 管理画面 → http://localhost:${PORT}/instagram`);
});
