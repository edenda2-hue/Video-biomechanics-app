import fs from "node:fs";
import cors from "cors";
import express from "express";
import { DATA_DIR, PORT, SESSIONS_DIR } from "./config.js";
import { HttpError } from "./lib/storage.js";
import { videoRouter } from "./routes/video.js";
import { poseRouter } from "./routes/pose.js";
import { anatomyRouter } from "./routes/anatomy.js";
import { musclesRouter } from "./routes/muscles.js";
import { highlightRouter } from "./routes/highlight.js";
import { exportRouter } from "./routes/exportRouter.js";

fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.use("/api", videoRouter);
app.use("/api", poseRouter);
app.use("/api", anatomyRouter);
app.use("/api", musclesRouter);
app.use("/api", highlightRouter);
app.use("/api", exportRouter);

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
