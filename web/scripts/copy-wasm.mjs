// Self-hosts the MediaPipe tasks-vision WASM runtime under /public instead of
// fetching it from a CDN at runtime (some deployment environments block
// third-party CDN hosts even when storage.googleapis.com, where the actual
// models live, is reachable).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const candidates = [
  path.resolve(__dirname, "../node_modules/@mediapipe/tasks-vision/wasm"),
  path.resolve(__dirname, "../../node_modules/@mediapipe/tasks-vision/wasm"),
];
const src = candidates.find((p) => fs.existsSync(p));
const dest = path.resolve(__dirname, "../public/mediapipe-wasm");

if (!src) {
  console.warn("[copy-wasm] source not found in any of:", candidates, "- did npm install run?");
  process.exit(0);
}

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });
for (const file of fs.readdirSync(src)) {
  fs.copyFileSync(path.join(src, file), path.join(dest, file));
}
console.log(`[copy-wasm] copied ${fs.readdirSync(dest).length} files to public/mediapipe-wasm`);
