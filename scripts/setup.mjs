// One-command local setup: checks prerequisites (Node, ffmpeg), installs
// dependencies, and prepares server/.env — so a first-time user only needs
// `npm run setup` followed by `npm run dev`.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

console.log("== Video Biomechanics App — setup ==\n");

// 1. Node version
const [major] = process.versions.node.split(".").map(Number);
if (major < 22) {
  fail(
    `Node.js ${process.versions.node} detected, but Node 22+ is required.\n` +
      "Install a recent Node.js from https://nodejs.org and re-run `npm run setup`.",
  );
}
console.log(`✔ Node.js ${process.versions.node}`);

// 2. ffmpeg / ffprobe on PATH
for (const bin of ["ffmpeg", "ffprobe"]) {
  const result = spawnSync(bin, ["-version"], { stdio: "ignore" });
  if (result.error || result.status !== 0) {
    fail(
      `'${bin}' was not found on your PATH. The video engine requires ffmpeg.\n\n` +
        "Install it, then re-run `npm run setup`:\n" +
        "  macOS:            brew install ffmpeg\n" +
        "  Ubuntu/Debian:    sudo apt install ffmpeg\n" +
        "  Windows:          winget install ffmpeg   (or choco install ffmpeg)\n",
    );
  }
}
console.log("✔ ffmpeg / ffprobe found");

// 3. Install dependencies (root + both workspaces)
console.log("\nInstalling dependencies (this can take a minute)...");
run("npm", ["install"]);

// 4. server/.env
const envPath = path.join(ROOT, "server", ".env");
const envExamplePath = path.join(ROOT, "server", ".env.example");
if (!fs.existsSync(envPath)) {
  fs.copyFileSync(envExamplePath, envPath);
  console.log("✔ Created server/.env (no OPENAI_API_KEY yet — offline mock mode will be used)");
} else {
  console.log("✔ server/.env already exists, left untouched");
}

console.log(
  "\nSetup complete!\n\n" +
    "  npm run dev\n\n" +
    "then open http://localhost:5173 in your browser.\n\n" +
    "Optional: to use real OpenAI generation instead of the offline mock,\n" +
    "put OPENAI_API_KEY=sk-... into server/.env before starting.\n",
);

function run(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: "inherit", cwd: ROOT, shell: process.platform === "win32" });
  if (result.status !== 0) fail(`Command failed: ${cmd} ${args.join(" ")}`);
}

function fail(message) {
  console.error(`\n✘ ${message}\n`);
  process.exit(1);
}
