// index.js — Selov ASX backend
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ─────────────────────────────────────────────────────────────
// SHARE JOB ENGINE (persistent across page reloads)
// ─────────────────────────────────────────────────────────────

const STATE_FILE = path.join(__dirname, "share-state.json");

let job = {
  running: false,
  stopRequested: false,
  cookie: "",
  link: "",
  total: 0,
  done: 0,
  ok: 0,
  fail: 0,
  delay: 0, // stored in milliseconds internally
  startedAt: null,
  finishedAt: null,
  log: []
};

function saveState() {
  try {
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify({
        running: job.running,
        cookie: job.cookie,
        link: job.link,
        total: job.total,
        done: job.done,
        ok: job.ok,
        fail: job.fail,
        delay: job.delay,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        log: job.log.slice(-200)
      })
    );
  } catch (_) {}
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (raw.running) {
      raw.running = false;
      raw.finishedAt = raw.finishedAt || Date.now();
      raw.log = (raw.log || []).concat([
        { t: Date.now(), level: "warn", msg: "server restarted — job stopped" }
      ]);
    }
    job = { ...job, ...raw, stopRequested: false };
  } catch (_) {}
}
loadState();

function pushLog(level, msg) {
  job.log.push({ t: Date.now(), level, msg });
  if (job.log.length > 500) job.log = job.log.slice(-500);
  saveState();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function interruptibleDelay(ms) {
  const step = 100;
  let left = ms;
  while (left > 0 && !job.stopRequested) {
    const s = Math.min(step, left);
    await sleep(s);
    left -= s;
  }
}

async function shareLoop() {
  job.running = true;
  job.stopRequested = false;
  job.done = 0;
  job.ok = 0;
  job.fail = 0;
  job.startedAt = Date.now();
  job.finishedAt = null;
  job.log = [];

  const startSec = (job.delay / 1000).toFixed(job.delay % 1000 === 0 ? 0 : 1);
  pushLog("dim", `session start · target=${job.total} · delay=${startSec}s`);

  const API = "https://vern-rest-api.vercel.app/api/share";

  for (let i = 1; i <= job.total; i++) {
    if (job.stopRequested) {
      pushLog("warn", "stop requested — halting");
      break;
    }

    const params = new URLSearchParams({
      key: "",
      cookie: job.cookie,
      link: job.link,
      limit: "1"
    });

    try {
      const r = await fetch(API + "?" + params.toString(), { method: "GET" });
      if (r.ok) {
        job.ok++;
        pushLog("ok", `[${i}/${job.total}] ok ${r.status}`);
      } else {
        job.fail++;
        pushLog("err", `[${i}/${job.total}] http ${r.status}`);
      }
    } catch (e) {
      job.fail++;
      pushLog("err", `[${i}/${job.total}] network — ${e.message}`);
    }

    job.done++;

    if (job.delay > 0 && i < job.total && !job.stopRequested) {
      const secStr = (job.delay / 1000).toFixed(job.delay % 1000 === 0 ? 0 : 1);
      pushLog("dim", `waiting ${secStr}s…`);
      await interruptibleDelay(job.delay);
    }
  }

  job.running = false;
  job.finishedAt = Date.now();
  pushLog("warn", `session end · ok=${job.ok} fail=${job.fail}`);
  saveState();
}

// ── START — expects delay in SECONDS ──
app.post("/api/share/start", (req, res) => {
  if (job.running) {
    return res.status(409).json({ ok: false, error: "already running" });
  }

  const { cookie, link, amount, delaySec } = req.body || {};
  if (!cookie) return res.status(400).json({ ok: false, error: "missing cookie" });
  if (!link) return res.status(400).json({ ok: false, error: "missing link" });

  job.cookie = String(cookie);
  job.link = String(link);
  job.total = Math.max(1, parseInt(amount, 10) || 1);

  // delaySec comes in seconds → store as ms internally
  let sec = Number(delaySec);
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  sec = Math.min(sec, 3600); // cap at 1 hour
  job.delay = Math.round(sec * 1000);

  shareLoop();
  res.json({ ok: true, started: true });
});

// ── STOP ──
app.post("/api/share/stop", (_req, res) => {
  if (!job.running) return res.json({ ok: true, running: false });
  job.stopRequested = true;
  res.json({ ok: true, stopping: true });
});

// ── STATUS ──
app.get("/api/share/status", (_req, res) => {
  res.json({
    running: job.running,
    stopRequested: job.stopRequested,
    total: job.total,
    done: job.done,
    ok: job.ok,
    fail: job.fail,
    delay: job.delay,
    delaySec: job.delay / 1000,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    elapsed: job.startedAt
      ? Math.floor(((job.finishedAt || Date.now()) - job.startedAt) / 1000)
      : 0,
    log: job.log
  });
});

// ─────────────────────────────────────────────────────────────
// TEMP MAIL PROXY
// ─────────────────────────────────────────────────────────────
app.get("/api/messages", async (req, res) => {
  const { address = "", nocache = "" } = req.query;
  if (!address) return res.status(400).json({ ok: false, error: "missing address" });

  const upstream = new URL("https://temporary-emaill.netlify.app/api/messages");
  upstream.searchParams.set("address", address);
  if (nocache) upstream.searchParams.set("nocache", nocache);

  try {
    const r = await fetch(upstream.toString(), {
      headers: { Accept: "application/json" }
    });
    const text = await r.text();
    res.status(r.status);
    res.set("Content-Type", r.headers.get("content-type") || "application/json");
    res.send(text);
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

// ── health ──
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", service: "selov-asx", uptime: process.uptime() });
});

// ── SPA fallback ──
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`\n  ✦ Selov ASX running at http://localhost:${PORT}\n`);
});
