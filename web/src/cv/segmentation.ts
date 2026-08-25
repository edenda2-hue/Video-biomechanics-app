import { FilesetResolver, ImageSegmenter } from "@mediapipe/tasks-vision";

// selfie_segmenter (the model previously used here) is tuned for close-up,
// front-facing "selfie" framing — background blur/replace use cases where
// the subject fills most of the frame with limbs held close to the body.
// Tested directly against a real exercise photo (arms raised overhead
// gripping a barbell, full body, mid-distance) and it dropped the entire
// raised-arm silhouette from the mask almost completely, and gave the
// shoes a uniform ~50%-confidence blob instead of a clean included/excluded
// boundary — both directly explain "the anatomy doesn't sit right" reports:
// a masked-out arm can't receive the anatomy overlay at all regardless of
// how good the pose/warp is, and a partial-confidence shoe region blends a
// ghostly partial overlay right at the ankle instead of a clean cut.
// selfie_multiclass_256x256 (a multi-class model: background/hair/
// body-skin/face-skin/clothes/other) doesn't share that close-up-framing
// assumption and, tested on the same photo, covered the raised arm in full
// and gave the shoes ("other") a clean near-zero mask instead of a uniform
// partial one. "Person" here is hair+body-skin+face-skin+clothes summed —
// everything but background and non-person "other" objects (a gripped
// barbell, in that same test image, correctly fell into "other" and was
// excluded).
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite";
const WASM_BASE = "/mediapipe-wasm";
const PERSON_CLASSES = [1, 2, 3, 4]; // hair, body-skin, face-skin, clothes (0 = background, 5 = other)

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
  const masks = result.confidenceMasks;
  if (!masks || masks.length <= Math.max(...PERSON_CLASSES)) throw new Error("Segmentation produced no mask");

  const maskWidth = masks[0].width;
  const maskHeight = masks[0].height;
  const personArrays = PERSON_CLASSES.map((i) => masks[i].getAsFloat32Array());

  const canvas = document.createElement("canvas");
  canvas.width = maskWidth;
  canvas.height = maskHeight;
  const ctx = canvas.getContext("2d")!;
  const imageData = ctx.createImageData(maskWidth, maskHeight);
  for (let i = 0; i < maskWidth * maskHeight; i++) {
    let person = 0;
    for (const arr of personArrays) person += arr[i];
    const v = Math.round(Math.min(1, Math.max(0, person)) * 255);
    imageData.data[i * 4] = v;
    imageData.data[i * 4 + 1] = v;
    imageData.data[i * 4 + 2] = v;
    imageData.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(imageData, 0, 0);
  masks.forEach((m) => m.close());

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
