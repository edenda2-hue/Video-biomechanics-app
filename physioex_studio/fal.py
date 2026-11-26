"""Minimal fal.ai queue client (no SDK). Model ids are configurable in MODELS."""
import base64, mimetypes, os, sys, time
import requests

QUEUE = "https://queue.fal.run"

# keyframe: references -> start frame;  video: start frame -> clip
MODELS = {
    "nano-banana": {"kind": "image", "id": "fal-ai/nano-banana/edit",
                    "args": lambda p, refs, **k: {"prompt": p, "image_urls": refs, "num_images": 1,
                                                  "aspect_ratio": "9:16", "output_format": "png"}},
    "flux-ultra": {"kind": "image", "id": "fal-ai/flux-pro/v1.1-ultra",
                   "args": lambda p, refs, **k: {"prompt": p, "aspect_ratio": "9:16", "num_images": 1,
                                                 "output_format": "png"}},
    "kling": {"kind": "video", "id": "fal-ai/kling-video/v2.1/pro/image-to-video",
              "args": lambda p, img, neg="", dur=10, **k: {"prompt": p, "image_url": img,
                                                          "negative_prompt": neg, "cfg_scale": 0.5,
                                                          "duration": "5" if dur <= 5 else "10"}},
    "seedance": {"kind": "video", "id": "fal-ai/bytedance/seedance/v1/pro/image-to-video",
                 "args": lambda p, img, neg="", dur=10, **k: {"prompt": p, "image_url": img,
                                                             "resolution": "1080p",
                                                             "duration": str(min(max(int(dur), 3), 12))}},
}


def key():
    k = os.environ.get("FAL_KEY")
    if not k:
        # In a Claude cloud session the network proxy injects the saved key for queue.fal.run,
        # so a placeholder is enough there. Elsewhere set FAL_KEY.
        print("[fal] FAL_KEY not set, sending placeholder (works only behind a credential-injecting proxy)",
              file=sys.stderr)
        k = "proxy-injected"
    return k


def data_uri(path):
    mime = mimetypes.guess_type(path)[0] or "application/octet-stream"
    return f"data:{mime};base64," + base64.b64encode(open(path, "rb").read()).decode()


def run(model_id, args, poll=4, timeout=1200):
    h = {"Authorization": f"Key {key()}", "Content-Type": "application/json"}
    r = requests.post(f"{QUEUE}/{model_id}", json=args, headers=h, timeout=120)
    if r.status_code >= 400:
        raise RuntimeError(f"fal submit {r.status_code}: {r.text[:500]}")
    j = r.json()
    status_url, resp_url = j["status_url"], j["response_url"]
    t0 = time.time()
    while True:
        s = requests.get(status_url, headers=h, timeout=60).json()
        st = s.get("status")
        print(f"[fal] {model_id}: {st}", file=sys.stderr)
        if st == "COMPLETED":
            break
        if st in ("FAILED", "ERROR", "CANCELLED"):
            raise RuntimeError(f"fal job failed: {s}")
        if time.time() - t0 > timeout:
            raise TimeoutError("fal job timed out")
        time.sleep(poll)
    r = requests.get(resp_url, headers=h, timeout=120)
    if r.status_code >= 400:
        raise RuntimeError(f"fal result {r.status_code}: {r.text[:500]}")
    return r.json()


def download(url, out):
    if url.startswith("data:"):
        open(out, "wb").write(base64.b64decode(url.split(",", 1)[1]))
        return out
    with requests.get(url, stream=True, timeout=300) as r:
        r.raise_for_status()
        with open(out, "wb") as f:
            for chunk in r.iter_content(1 << 16):
                f.write(chunk)
    return out


def keyframe(model, prompt, ref_paths, out):
    m = MODELS[model]
    res = run(m["id"], m["args"](prompt, [data_uri(p) for p in ref_paths]))
    return download(res["images"][0]["url"], out)


def animate(model, prompt, image_path, negative, duration, out):
    m = MODELS[model]
    res = run(m["id"], m["args"](prompt, data_uri(image_path), neg=negative, dur=duration))
    return download(res["video"]["url"], out)
