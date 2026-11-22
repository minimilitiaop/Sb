// index.js — Selov ASX backend
const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// ── middleware ──
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// ── serve static frontend ──
app.use(express.static(path.join(__dirname, "public")));

// ── health check ──
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "selov-asx",
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// ── share boost proxy ──
// Frontend calls: GET /api/share?key=&cookie=&link=&limit=1
// Proxies to the upstream share API
app.get("/api/share", async (req, res) => {
  const { key = "", cookie = "", link = "", limit = "1" } = req.query;

  if (!cookie) {
    return res.status(400).json({ ok: false, error: "missing cookie" });
  }
  if (!link) {
    return res.status(400).json({ ok: false, error: "missing link" });
  }

  const upstream = new URL("https://vern-rest-api.vercel.app/api/share");
  upstream.searchParams.set("key", key);
  upstream.searchParams.set("cookie", cookie);
  upstream.searchParams.set("link", link);
  upstream.searchParams.set("limit", limit);

  try {
    const r = await fetch(upstream.toString(), {
      method: "GET",
      headers: { Accept: "application/json" }
    });

    const text = await r.text();

    res.status(r.status);
    res.set("Content-Type", r.headers.get("content-type") || "application/json");
    return res.send(text);
  } catch (err) {
    console.error("[share proxy]", err.message);
    return res.status(502).json({ ok: false, error: err.message });
  }
});

// ── temp mail inbox proxy ──
// Frontend calls: GET /api/messages?address=xxx@domain&nocache=...
app.get("/api/messages", async (req, res) => {
  const { address = "", nocache = "" } = req.query;

  if (!address) {
    return res.status(400).json({ ok: false, error: "missing address" });
  }

  const upstream = new URL("https://temporary-emaill.netlify.app/api/messages");
  upstream.searchParams.set("address", address);
  if (nocache) upstream.searchParams.set("nocache", nocache);

  try {
    const r = await fetch(upstream.toString(), {
      method: "GET",
      headers: { Accept: "application/json" }
    });

    const text = await r.text();

    res.status(r.status);
    res.set("Content-Type", r.headers.get("content-type") || "application/json");
    return res.send(text);
  } catch (err) {
    console.error("[mail proxy]", err.message);
    return res.status(502).json({ ok: false, error: err.message });
  }
});

// ── SPA fallback ──
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ── start ──
app.listen(PORT, () => {
  console.log(`\n  ✦ Selov ASX running at http://localhost:${PORT}\n`);
});

module.exports = app;
