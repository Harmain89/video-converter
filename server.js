import express from "express";
import { WebSocketServer } from "ws";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const PYTHON = process.platform === "win32" ? "python" : "python3";
const ENGINE = path.join(__dirname, "engine", "engine.py");

const VIDEO_EXT = new Set([
  ".mkv", ".mp4", ".avi", ".mov", ".wmv", ".flv", ".webm", ".m4v",
  ".mpg", ".mpeg", ".ts", ".m2ts", ".vob", ".3gp", ".ogv", ".divx",
]);

const isVideoLike = (name) => {
  const ext = path.extname(name).toLowerCase();
  return VIDEO_EXT.has(ext) || ext === ""; // ext === "" catches files like "Harry Potter 2001"
};

const app = express();
app.use(express.static(path.join(__dirname, "public")));

/** Run engine.py once and resolve the single JSON object it prints. */
function runEngineOnce(engineArgs) {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON, [ENGINE, ...engineArgs]);
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (err += d));
    proc.on("error", reject);
    proc.on("close", () => {
      const line = out.trim().split("\n").filter(Boolean).pop();
      if (!line) return reject(new Error(err || "engine produced no output"));
      try {
        resolve(JSON.parse(line));
      } catch {
        reject(new Error(err || "could not parse engine output"));
      }
    });
  });
}

// --- File browser (no upload: we operate on local paths) --------------------
app.get("/api/list", (req, res) => {
  let dir = req.query.dir;
  if (!dir || dir === "~") dir = os.homedir();

  // Windows: empty / root request -> enumerate drive letters.
  if (process.platform === "win32" && (dir === "/" || dir === "")) {
    const drives = [];
    for (let c = 65; c <= 90; c++) {
      const root = `${String.fromCharCode(c)}:\\`;
      if (fs.existsSync(root)) drives.push({ name: root, path: root, type: "dir" });
    }
    return res.json({ dir: "Drives", parent: null, entries: drives });
  }

  try {
    dir = path.resolve(dir);
    const items = fs.readdirSync(dir, { withFileTypes: true });
    const entries = [];
    for (const it of items) {
      const full = path.join(dir, it.name);
      try {
        if (it.isDirectory()) {
          if (it.name.startsWith(".")) continue;
          entries.push({ name: it.name, path: full, type: "dir" });
        } else if (it.isFile() && isVideoLike(it.name)) {
          entries.push({ name: it.name, path: full, type: "file", size: fs.statSync(full).size });
        }
      } catch { /* unreadable entry — skip */ }
    }
    entries.sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1
    );
    const parent = path.dirname(dir);
    res.json({ dir, parent: parent === dir ? null : parent, entries });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- Analyze (cheap ffprobe pass -> recommended plan) -----------------------
app.get("/api/analyze", async (req, res) => {
  const { path: p, format = "mp4" } = req.query;
  if (!p || !fs.existsSync(p)) return res.status(400).json({ error: "file not found" });
  try {
    res.json(await runEngineOnce(["--analyze", p, "--format", format]));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// --- Conversion job over WebSocket (streamed progress) ----------------------
wss.on("connection", (ws) => {
  let child = null;

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.action !== "convert" || child) return;
    if (!msg.path || !fs.existsSync(msg.path)) {
      return ws.send(JSON.stringify({ type: "error", message: "file not found" }));
    }

    const args = [
      ENGINE, "--convert", msg.path,
      "--format", msg.format || "mp4",
      "--codec", msg.codec || "h264",
      "--quality", msg.quality || "balanced",
      "--mode", msg.mode || "auto",
    ];
    child = spawn(PYTHON, args);

    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line && ws.readyState === ws.OPEN) ws.send(line);
      }
    });
    child.stderr.on("data", (d) =>
      console.error("[engine]", d.toString().trim())
    );
    child.on("close", () => {
      child = null;
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "closed" }));
    });
    child.on("error", (e) =>
      ws.send(JSON.stringify({ type: "error", message: e.message }))
    );
  });

  ws.on("close", () => {
    if (child) child.kill();
  });
});

server.listen(PORT, () => {
  console.log(`\n  Smart Video Converter running:  http://localhost:${PORT}\n`);
});
