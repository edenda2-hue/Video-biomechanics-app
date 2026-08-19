import fs from "node:fs";
import path from "node:path";
import multer from "multer";
import { DATA_DIR } from "../config.js";

const uploadsTmp = path.join(DATA_DIR, "uploads-tmp");
fs.mkdirSync(uploadsTmp, { recursive: true });

export const uploadVideo = multer({
  storage: multer.diskStorage({
    destination: uploadsTmp,
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_")}`),
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
});
