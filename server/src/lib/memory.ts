// Encourages prompt release of the large raw-image buffers the export
// routes allocate per frame/keyframe, on a deploy target with a tight
// memory ceiling (the free tier's ~512MB). global.gc() only exists when
// the process was started with --expose-gc (see the Dockerfile); no-ops
// harmlessly everywhere else (local dev, tests) rather than throwing.
export function releaseMemory() {
  global.gc?.();
}
