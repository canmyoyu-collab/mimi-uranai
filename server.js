const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

// .env 読み込み（ローカル開発用・読み取りのみ）
// 本番（Render）では管理画面の環境変数 ANTHROPIC_API_KEY を使う
const ENV_PATH = path.join(__dirname, ".env");
if (fs.existsSync(ENV_PATH)) {
  fs.readFileSync(ENV_PATH, "utf8").split("\n").forEach(line => {
    const m = line.match(/^([^=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim();
  });
}

const PORT = process.env.PORT || 3456;
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
const MAX_TOKENS = 1500;
const MAX_BODY = 20 * 1024 * 1024;
const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, "prompt.txt"), "utf8").trim();
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

// ── 回数制限（メモリ内） ─────────────────────────
// 1人（IP）あたり1時間に PER_IP_LIMIT 回、全体で1日 DAILY_LIMIT 回まで
const PER_IP_LIMIT = parseInt(process.env.PER_IP_LIMIT || "10", 10);
const DAILY_LIMIT = parseInt(process.env.DAILY_LIMIT || "300", 10);
const HOUR = 60 * 60 * 1000;
const ipHits = new Map();
let daily = { day: "", count: 0 };

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return fwd.split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

function checkRateLimit(ip) {
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  if (daily.day !== today) daily = { day: today, count: 0 };
  if (daily.count >= DAILY_LIMIT) return "本日の診断受付は終了しました。また明日お試しください。";

  const hits = (ipHits.get(ip) || []).filter(t => now - t < HOUR);
  if (hits.length >= PER_IP_LIMIT) {
    ipHits.set(ip, hits);
    return "診断回数の上限に達しました。しばらく時間をおいてからお試しください。";
  }
  hits.push(now);
  ipHits.set(ip, hits);
  daily.count++;
  return null;
}

// 古いIP記録を定期的に掃除
setInterval(() => {
  const now = Date.now();
  for (const [ip, hits] of ipHits) {
    if (!hits.some(t => now - t < HOUR)) ipHits.delete(ip);
  }
}, 10 * 60 * 1000).unref();

function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {

  // ── GET /api/status ──────────────────────────────
  if (req.method === "GET" && req.url === "/api/status") {
    const ready = !!(process.env.ANTHROPIC_API_KEY?.startsWith("sk-ant-"));
    sendJson(res, 200, { ready });
    return;
  }

  // ── POST /api/analyze → Anthropic ────────────────
  // ブラウザからは画像と年齢だけを受け取り、モデル・プロンプトはサーバー側で固定する
  if (req.method === "POST" && req.url === "/api/analyze") {
    const API_KEY = process.env.ANTHROPIC_API_KEY;
    if (!API_KEY) {
      sendJson(res, 503, { error: { message: "APIキーが設定されていません" } });
      return;
    }

    let body = "";
    let bodySize = 0;
    let aborted = false;
    req.on("data", chunk => {
      if (aborted) return;
      bodySize += chunk.length;
      if (bodySize > MAX_BODY) {
        aborted = true;
        sendJson(res, 413, { error: { message: "画像が大きすぎます。もう少し小さいサイズで撮り直してください。" } });
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on("end", () => {
      if (aborted) return;

      let input;
      try {
        input = JSON.parse(body);
      } catch {
        sendJson(res, 400, { error: { message: "リクエストが正しくありません" } });
        return;
      }

      const age = Number(input.age);
      const { imageType, imageBase64 } = input;
      if (!Number.isInteger(age) || age < 18 || age > 120 ||
          !IMAGE_TYPES.includes(imageType) ||
          typeof imageBase64 !== "string" || !/^[A-Za-z0-9+/=]+$/.test(imageBase64)) {
        sendJson(res, 400, { error: { message: "入力内容が正しくありません" } });
        return;
      }

      const limited = checkRateLimit(clientIp(req));
      if (limited) {
        sendJson(res, 429, { error: { message: limited } });
        return;
      }

      const side = age >= 35 ? "右" : "左";
      const payload = JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: imageType, data: imageBase64 },
            },
            {
              type: "text",
              text: `これは${side}耳（${age}歳）の写真です。婚活タイプを診断して、前向きになれるアドバイスをお願いします！`,
            },
          ],
        }],
      });

      const options = {
        hostname: "api.anthropic.com",
        path: "/v1/messages",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          "x-api-key": API_KEY,
          "anthropic-version": "2023-06-01",
        },
      };

      const proxy = https.request(options, (upstream) => {
        res.writeHead(upstream.statusCode, { "Content-Type": "application/json" });
        upstream.pipe(res);
      });

      proxy.on("error", (err) => {
        console.error("Anthropic API error:", err.message);
        sendJson(res, 500, { error: { message: "診断サーバーに接続できませんでした" } });
      });

      proxy.end(payload);
    });
    return;
  }

  // ── GET / → index.html ──
  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    const file = path.join(__dirname, "index.html");
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end("Not found"); return; }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(data);
    });
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`✨ 耳占い婚活診断 起動中 → http://localhost:${PORT}`);
});
