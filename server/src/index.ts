import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import sharp from "sharp";
import { DATA_DIR, PORT, SESSIONS_DIR } from "./config.js";

// The free-tier deploy target has ~512MB RAM. sharp/libvips defaults are
// tuned for throughput on machines that can spare it: an operation cache
// (decoded-pixel-data cache, tens of MB) and an internal thread pool that
// can multiply a single composite's peak memory. Neither is needed here —
// each session processes one frame at a time, sequentially — so both are
// disabled at startup to keep peak memory bounded rather than let sharp's
// defaults quietly compete with Node's own buffers for the same tight limit.
sharp.cache(false);
sharp.concurrency(1);
import { HttpError } from "./lib/storage.js";
import { videoRouter } from "./routes/video.js";
import { poseRouter } from "./routes/pose.js";
import { anatomyRouter } from "./routes/anatomy.js";
import { musclesRouter } from "./routes/muscles.js";
import { highlightRouter } from "./routes/highlight.js";
import { exportRouter } from "./routes/exportRouter.js";
import { chatRouter } from "./routes/chat.js";
import { continuousRouter } from "./routes/continuous.js";
import { keyframesRouter } from "./routes/keyframes.js";
import { slidesRouter } from "./routes/slides.js";

fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const app = express();
app.use(cors());
// Continuous mode's export request carries a puppet+mask PNG per output
// frame in one JSON body (no live key/API to stream against yet — see
// README's "Continuous-motion mode" section), so the limit is well above
// the single-frame routes' needs.
app.use(express.json({ limit: "80mb" }));

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.use("/api", videoRouter);
app.use("/api", poseRouter);
app.use("/api", anatomyRouter);
app.use("/api", musclesRouter);
app.use("/api", highlightRouter);
app.use("/api", exportRouter);
app.use("/api", chatRouter);
app.use("/api", continuousRouter);
app.use("/api", keyframesRouter);
app.use("/api", slidesRouter);

// Single-service deployment (see Dockerfile / render.yaml): if a built web
// app is present, serve it from the same process/port as the API so the
// whole thing deploys as one free web service with one public URL.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST = process.env.WEB_DIST_PATH
  ? path.resolve(process.env.WEB_DIST_PATH)
  : path.resolve(__dirname, "../../web/dist");
if (fs.existsSync(path.join(WEB_DIST, "index.html"))) {
  app.use(express.static(WEB_DIST));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(WEB_DIST, "index.html")));
  console.log(`[server] serving web build from ${WEB_DIST}`);
}

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error(err);
  res.status(500).json({ error: err instanceof Error ? err.message : "Internal error" });
});

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
  console.log(`[server] data dir: ${DATA_DIR}`);
});
