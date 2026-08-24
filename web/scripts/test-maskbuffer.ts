// Standalone sanity check for the mask-buffer resize math used by
// continuous mode's per-frame mask tracking (pure, no DOM/canvas needed).
// Run with: npx tsx scripts/test-maskbuffer.ts
import { resizeMaskBuffer } from "../src/cv/maskBuffer";

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`FAILED: ${msg}`);
    process.exit(1);
  }
  console.log(`ok: ${msg}`);
}

function close(a: number, b: number, eps = 1e-6) {
  return Math.abs(a - b) < eps;
}

// --- identity: same size returns an equal-but-distinct copy ---
{
  const src = new Float32Array([0, 0.5, 1, 0.25]);
  const out = resizeMaskBuffer(src, 2, 2, 2, 2);
  assert(out !== src, "same-size resize returns a distinct array instance");
  assert(out.every((v, i) => close(v, src[i])), "same-size resize is a value-identity copy");
}

// --- a constant buffer stays constant at any resolution ---
{
  const src = new Float32Array(10 * 10).fill(0.7);
  const up = resizeMaskBuffer(src, 10, 10, 40, 25);
  assert(up.every((v) => close(v, 0.7, 1e-4)), "upsampling a constant buffer keeps every value constant");
  const down = resizeMaskBuffer(src, 10, 10, 3, 3);
  assert(down.every((v) => close(v, 0.7, 1e-4)), "downsampling a constant buffer keeps every value constant");
}

// --- monotonic gradient interpolates smoothly, not just nearest-neighbor ---
{
  // A 1D-ish left(0)-to-right(1) gradient, 4 columns wide.
  const w = 4;
  const h = 1;
  const src = new Float32Array([0, 1 / 3, 2 / 3, 1]);
  const out = resizeMaskBuffer(src, w, h, 8, 1);
  for (let i = 1; i < out.length; i++) {
    assert(out[i] >= out[i - 1] - 1e-6, `upsampled gradient stays monotonically non-decreasing at column ${i}`);
  }
  assert(close(out[0], src[0], 0.2), "upsampled gradient's first column stays near the source's first value");
  assert(close(out[out.length - 1], src[src.length - 1], 0.2), "upsampled gradient's last column stays near the source's last value");
}

// --- values stay within the source's [min,max] range (no overshoot/ringing) ---
{
  const src = new Float32Array([0, 1, 0, 1, 1, 0, 1, 0, 0]); // 3x3 checkerboard
  const out = resizeMaskBuffer(src, 3, 3, 11, 11);
  assert(out.every((v) => v >= -1e-6 && v <= 1 + 1e-6), "bilinear resize never overshoots the source value range");
}

console.log("\nAll mask-buffer checks passed.");
