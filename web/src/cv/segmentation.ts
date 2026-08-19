import { FilesetResolver, ImageSegmenter } from "@mediapipe/tasks-vision";

const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite";
const WASM_BASE = "/mediapipe-wasm";

let segmenterPromise: Promise<ImageSegmenter> | null = null;

function getSegmenter(): Promise<ImageSegmenter> {
  if (!segmenterPromise) {
    segmenterPromise = FilesetResolver.forVisionTasks(WASM_BASE).then((fileset) =>
      ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL },
        runningMode: "IMAGE",
        outputCategoryMask: false,
        outputConfidenceMasks: true,
      }),
    );
  }
  return segmenterPromise;
}

/**
 * Human Segmentation (spec section 3): returns a grayscale PNG data URL where
 * white = person, black = original background/equipment/floor, at the
 * frame's native resolution.
 */
export async function segmentPerson(image: HTMLCanvasElement | HTMLImageElement, width: number, height: number): Promise<string> {
  if (import.meta.env.VITE_CV_MOCK === "1") return mockMask(width, height);
  const segmenter = await getSegmenter();
  const result = segmenter.segment(image);
  const confidence = result.confidenceMasks?.[0];
  if (!confidence) throw new Error("Segmentation produced no mask");

  const maskWidth = confidence.width;
  const maskHeight = confidence.height;
  const data = confidence.getAsFloat32Array();

  const canvas = document.createElement("canvas");
  canvas.width = maskWidth;
  canvas.height = maskHeight;
  const ctx = canvas.getContext("2d")!;
  const imageData = ctx.createImageData(maskWidth, maskHeight);
  for (let i = 0; i < data.length; i++) {
    const v = Math.round(Math.min(1, Math.max(0, data[i])) * 255);
    imageData.data[i * 4] = v;
    imageData.data[i * 4 + 1] = v;
    imageData.data[i * 4 + 2] = v;
    imageData.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(imageData, 0, 0);
  confidence.close();

  if (maskWidth === width && maskHeight === height) {
    return canvas.toDataURL("image/png");
  }

  const resized = document.createElement("canvas");
  resized.width = width;
  resized.height = height;
  const rctx = resized.getContext("2d")!;
  rctx.drawImage(canvas, 0, 0, width, height);
  return resized.toDataURL("image/png");
}

/** Offline stand-in mask (mirrors mockPose in cv/pose.ts): a centered ellipse silhouette. */
function mockMask(width: number, height: number): string {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "black";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "white";
  ctx.beginPath();
  ctx.ellipse(width * 0.5, height * 0.5, width * 0.16, height * 0.42, 0, 0, Math.PI * 2);
  ctx.fill();
  return canvas.toDataURL("image/png");
}
