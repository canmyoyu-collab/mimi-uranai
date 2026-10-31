const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

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

const server = http.createServer((req, res) => {

  // ── POST /api/setup ──────────────────────────────
  if (req.method === "POST" && req.url === "/api/setup") {
    let body = "";
    req.on("data", chunk => (body += chunk));
    req.on("end", () => {
      try {
        const { key } = JSON.parse(body);
        if (!key || !key.startsWith("sk-ant-")) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, message: "sk-ant- から始まるキーを入力してください" }));
          return;
        }
        saveApiKey(key);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false }));
      }
    });
    return;
  }

  // ── GET /api/status ──────────────────────────────
  if (req.method === "GET" && req.url === "/api/status") {
    const ready = !!(process.env.ANTHROPIC_API_KEY?.startsWith("sk-ant-"));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ready }));
    return;
  }

  // ── POST /api/analyze → Anthropic proxy ──────────
  if (req.method === "POST" && req.url === "/api/analyze") {
    const API_KEY = process.env.ANTHROPIC_API_KEY;
    if (!API_KEY) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "APIキーが設定されていません" } }));
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

  // ── OPTIONS preflight ──
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" });
    res.end();
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

  // ── GET /2027 → year2027.html ──
  if (req.method === "GET" && (req.url === "/2027" || req.url === "/year2027.html")) {
    const file = path.join(__dirname, "year2027.html");
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
