/* High-accuracy emotion model.
   EmotiEffLib (formerly HSEmotion) EfficientNet-B0, trained on AffectNet, run with ONNX Runtime Web.
   One pass gives 8 emotion scores plus valence (negative..positive) and arousal (calm..excited).
   Model: https://github.com/sb-ai-lab/EmotiEffLib (Apache-2.0) */
window.EmotionPro = (() => {
  'use strict';

  const ORT_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/';
  const MODEL_PATH = 'models/enet_b0_8_va_mtl.onnx';
  const SIZE = 224;
  const MEAN = [0.485, 0.456, 0.406];
  const STD = [0.229, 0.224, 0.225];
  // Output order of the model's 8 emotion logits.
  const CLASSES = ['angry', 'contempt', 'disgusted', 'fearful', 'happy', 'neutral', 'sad', 'surprised'];

  let session = null;
  let backend = null;
  let warmed = false;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  const input = new Float32Array(3 * SIZE * SIZE);

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(s);
    });
  }

  const clamp = (v) => Math.max(-1, Math.min(1, v));

  async function run() {
    const tensor = new ort.Tensor('float32', input, [1, 3, SIZE, SIZE]);
    const out = await session.run({ [session.inputNames[0]]: tensor });
    const s = out[session.outputNames[0]].data;
    let max = -Infinity;
    for (let i = 0; i < 8; i++) max = Math.max(max, s[i]);
    let sum = 0;
    const e = [];
    for (let i = 0; i < 8; i++) { e[i] = Math.exp(s[i] - max); sum += e[i]; }
    const expressions = {};
    CLASSES.forEach((k, i) => { expressions[k] = e[i] / sum; });
    return { expressions, valence: clamp(s[8]), arousal: clamp(s[9]) };
  }

  async function load() {
    const adapter = 'gpu' in navigator ? await navigator.gpu.requestAdapter().catch(() => null) : null;
    await loadScript(ORT_BASE + (adapter ? 'ort.webgpu.min.js' : 'ort.wasm.min.js'));
    ort.env.wasm.wasmPaths = ORT_BASE;
    ort.env.logLevel = 'error';
    for (const ep of adapter ? ['webgpu', 'wasm'] : ['wasm']) {
      try {
        session = await ort.InferenceSession.create(MODEL_PATH, { executionProviders: [ep], graphOptimizationLevel: 'all' });
        backend = ep;
        break;
      } catch (err) {
        console.warn(`Emotion model: ${ep} backend failed`, err);
      }
    }
    if (!session) throw new Error('Could not start the emotion model');
    await run(); // warm-up so the first real frame is fast
    warmed = true;
    return backend;
  }

  /* The model was trained on loose face crops (forehead to below the chin). Building the crop from
     the 68 landmarks keeps the framing identical whichever face detector found the face; the
     padding factors were measured to match that framing. */
  function cropFromLandmarks(points) {
    let lx0 = Infinity, ly0 = Infinity, lx1 = -Infinity, ly1 = -Infinity;
    for (const p of points) {
      lx0 = Math.min(lx0, p.x); lx1 = Math.max(lx1, p.x);
      ly0 = Math.min(ly0, p.y); ly1 = Math.max(ly1, p.y);
    }
    const w = lx1 - lx0, h = ly1 - ly0;
    return { x0: lx0 - 0.16 * w, y0: ly0 - 0.63 * h, x1: lx1 + 0.16 * w, y1: ly1 + 0.31 * h };
  }

  /** Classify one face of `source` (video, image or canvas sized W x H) from its 68 landmark points. */
  async function classify(source, points, W, H) {
    const c = cropFromLandmarks(points);
    const x0 = Math.max(0, c.x0), y0 = Math.max(0, c.y0);
    const x1 = Math.min(W, c.x1), y1 = Math.min(H, c.y1);
    g.drawImage(source, x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0), 0, 0, SIZE, SIZE);
    const px = g.getImageData(0, 0, SIZE, SIZE).data;
    const plane = SIZE * SIZE;
    for (let i = 0, j = 0; i < plane; i++, j += 4) {
      input[i] = (px[j] / 255 - MEAN[0]) / STD[0];
      input[i + plane] = (px[j + 1] / 255 - MEAN[1]) / STD[1];
      input[i + 2 * plane] = (px[j + 2] / 255 - MEAN[2]) / STD[2];
    }
    return run();
  }

  return {
    load,
    classify,
    get ready() { return warmed; },
    get backend() { return backend; },
  };
})();
