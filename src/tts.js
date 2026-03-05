import { execFile } from "node:child_process";
import { mkdir, stat, chmod, writeFile as fsWriteFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { join, basename } from "node:path";
import { homedir, platform, arch, tmpdir } from "node:os";
import { createHash } from "node:crypto";

const PIPER_VERSION = "2023.11.14-2";
const VOICE_NAME = "en_GB-alan-medium";

const PIPER_DIR = join(homedir(), ".klaudio", "piper");

// ── Kokoro TTS (primary engine) ─────────────────────────────────

// Default voice per preset vibe
const KOKORO_PRESET_VOICES = {
  "retro-8bit": "af_bella",
  "minimal-zen": "af_heart",
  "sci-fi-terminal": "af_nova",
  "victory-fanfare": "af_sky",
};
const KOKORO_DEFAULT_VOICE = "af_heart";

// Curated voice list for the picker (best quality voices)
const KOKORO_VOICES = [
  { id: "af_heart",  name: "Heart",  gender: "F", accent: "US", grade: "A" },
  { id: "af_bella",  name: "Bella",  gender: "F", accent: "US", grade: "A-" },
  { id: "af_nicole", name: "Nicole", gender: "F", accent: "US", grade: "B-" },
  { id: "af_nova",   name: "Nova",   gender: "F", accent: "US", grade: "C" },
  { id: "af_sky",    name: "Sky",    gender: "F", accent: "US", grade: "C-" },
  { id: "af_sarah",  name: "Sarah",  gender: "F", accent: "US", grade: "C+" },
  { id: "am_fenrir", name: "Fenrir", gender: "M", accent: "US", grade: "C+" },
  { id: "am_michael",name: "Michael",gender: "M", accent: "US", grade: "C+" },
  { id: "am_puck",   name: "Puck",   gender: "M", accent: "US", grade: "C+" },
  { id: "bf_emma",   name: "Emma",   gender: "F", accent: "UK", grade: "B-" },
  { id: "bm_george", name: "George", gender: "M", accent: "UK", grade: "C" },
  { id: "bm_fable",  name: "Fable",  gender: "M", accent: "UK", grade: "C" },
];

// Singleton: reuse the loaded model across calls
let kokoroInstance = null;
let kokoroLoadPromise = null;

/**
 * Load the Kokoro TTS model (singleton, downloads ~86MB on first use).
 * Uses CPU backend (DirectML has ConvTranspose compatibility issues).
 */
async function getKokoro() {
  if (kokoroInstance) return kokoroInstance;
  if (kokoroLoadPromise) return kokoroLoadPromise;

  kokoroLoadPromise = (async () => {
    const { KokoroTTS } = await import("kokoro-js");
    kokoroInstance = await KokoroTTS.from_pretrained(
      "onnx-community/Kokoro-82M-v1.0-ONNX",
      { dtype: "q4", device: "cpu" },
    );
    return kokoroInstance;
  })();

  try {
    return await kokoroLoadPromise;
  } catch (err) {
    kokoroLoadPromise = null;
    throw err;
  }
}

/**
 * Speak text using Kokoro TTS.
 * Returns true if successful, false if Kokoro is unavailable.
 */
async function speakKokoro(text, voice) {
  const tts = await getKokoro();
  const voiceId = voice || KOKORO_DEFAULT_VOICE;

  const audio = await tts.generate(text, { voice: voiceId, speed: 1.0 });

  // Save to temp wav and play
  const hash = createHash("md5").update(text + voiceId).digest("hex").slice(0, 8);
  const outPath = join(tmpdir(), `klaudio-kokoro-${hash}.wav`);
  audio.save(outPath);

  const { playSoundWithCancel } = await import("./player.js");
  await playSoundWithCancel(outPath, { maxSeconds: 0 }).promise.catch(() => {});
}

// ── Piper TTS (fallback engine) ─────────────────────────────────

function getPiperAssetName() {
  const os = platform();
  const a = arch();
  if (os === "win32") return "piper_windows_amd64.zip";
  if (os === "darwin") return a === "arm64" ? "piper_macos_aarch64.tar.gz" : "piper_macos_x64.tar.gz";
  if (a === "arm64" || a === "aarch64") return "piper_linux_aarch64.tar.gz";
  return "piper_linux_x86_64.tar.gz";
}

function getPiperBinPath() {
  const bin = platform() === "win32" ? "piper.exe" : "piper";
  return join(PIPER_DIR, "piper", bin);
}

function getVoiceModelPath() {
  return join(PIPER_DIR, `${VOICE_NAME}.onnx`);
}

async function downloadFile(url, destPath, onProgress) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  const total = parseInt(res.headers.get("content-length") || "0", 10);
  let downloaded = 0;

  const fileStream = createWriteStream(destPath);
  const reader = res.body.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    fileStream.write(value);
    downloaded += value.length;
    if (onProgress && total > 0) {
      onProgress(Math.round((downloaded / total) * 100));
    }
  }

  fileStream.end();
  await new Promise((resolve, reject) => {
    fileStream.on("finish", resolve);
    fileStream.on("error", reject);
  });
}

async function extractArchive(archivePath, destDir) {
  const os = platform();
  if (archivePath.endsWith(".zip")) {
    if (os === "win32") {
      await new Promise((resolve, reject) => {
        execFile("powershell.exe", [
          "-NoProfile", "-Command",
          `Expand-Archive -Path '${archivePath}' -DestinationPath '${destDir}' -Force`,
        ], { windowsHide: true, timeout: 60000 }, (err) => err ? reject(err) : resolve());
      });
    } else {
      await new Promise((resolve, reject) => {
        execFile("unzip", ["-o", archivePath, "-d", destDir], { timeout: 60000 }, (err) => err ? reject(err) : resolve());
      });
    }
  } else {
    await new Promise((resolve, reject) => {
      execFile("tar", ["xzf", archivePath, "-C", destDir], { timeout: 60000 }, (err) => err ? reject(err) : resolve());
    });
  }
}

export async function ensurePiper(onProgress) {
  const binPath = getPiperBinPath();
  try {
    await stat(binPath);
    return binPath;
  } catch { /* needs download */ }

  try {
    await mkdir(PIPER_DIR, { recursive: true });
    const asset = getPiperAssetName();
    const url = `https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/${asset}`;
    const archivePath = join(PIPER_DIR, asset);

    if (onProgress) onProgress(`Downloading piper TTS...`);
    await downloadFile(url, archivePath, (pct) => {
      if (onProgress) onProgress(`Downloading piper TTS... ${pct}%`);
    });

    if (onProgress) onProgress("Extracting piper...");
    await extractArchive(archivePath, PIPER_DIR);

    if (platform() !== "win32") {
      try { await chmod(binPath, 0o755); } catch { /* ignore */ }
    }

    return binPath;
  } catch (err) {
    try { const { unlink } = await import("node:fs/promises"); await unlink(join(PIPER_DIR, getPiperAssetName())); } catch { /* ignore */ }
    throw new Error(`Failed to download piper: ${err.message}`);
  }
}

export async function ensureVoiceModel(onProgress) {
  const modelPath = getVoiceModelPath();
  const configPath = modelPath + ".json";
  try {
    await stat(modelPath);
    await stat(configPath);
    return modelPath;
  } catch { /* needs download */ }

  try {
    await mkdir(PIPER_DIR, { recursive: true });
    const baseUrl = `https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_GB/alan/medium`;

    if (onProgress) onProgress("Downloading voice model...");
    await downloadFile(`${baseUrl}/${VOICE_NAME}.onnx`, modelPath, (pct) => {
      if (onProgress) onProgress(`Downloading voice model... ${pct}%`);
    });

    if (onProgress) onProgress("Downloading voice config...");
    await downloadFile(`${baseUrl}/${VOICE_NAME}.onnx.json`, configPath);

    return modelPath;
  } catch (err) {
    const { unlink } = await import("node:fs/promises");
    try { await unlink(modelPath); } catch { /* ignore */ }
    try { await unlink(configPath); } catch { /* ignore */ }
    throw new Error(`Failed to download voice model: ${err.message}`);
  }
}

async function speakPiper(text, onProgress) {
  let piperBin, modelPath;
  try {
    [piperBin, modelPath] = await Promise.all([
      ensurePiper(onProgress),
      ensureVoiceModel(onProgress),
    ]);
  } catch {
    return;
  }

  const hash = createHash("md5").update(text).digest("hex").slice(0, 8);
  const outPath = join(tmpdir(), `klaudio-tts-${hash}.wav`);

  try {
    await new Promise((resolve, reject) => {
      const child = execFile(piperBin, [
        "--model", modelPath,
        "--output_file", outPath,
        "--sentence_silence", "0.5",
      ], { windowsHide: true, timeout: 15000 }, (err) => {
        if (err) reject(err);
        else resolve();
      });
      child.stdin.write(text);
      child.stdin.end();
    });

    const { playSoundWithCancel } = await import("./player.js");
    await playSoundWithCancel(outPath, { maxSeconds: 0 }).promise.catch(() => {});
  } catch {
    // Piper failed — skip silently
  }
}

// ── macOS fallback ──────────────────────────────────────────────

function speakMacOS(text) {
  return new Promise((resolve) => {
    execFile("say", ["-v", "Daniel", text], { timeout: 15000 }, () => resolve());
  });
}

// ── Public API ──────────────────────────────────────────────────

let speaking = false;
const TTS_LOCK = join(tmpdir(), ".klaudio-tts-lock");

/**
 * Try to acquire a cross-process TTS lock.
 * Returns true if acquired, false if another process is speaking.
 * Stale locks (>30s) are automatically cleaned up.
 */
async function acquireTTSLock() {
  try {
    const lockStat = await stat(TTS_LOCK);
    if (Date.now() - lockStat.mtimeMs < 30000) return false; // fresh lock, skip
  } catch { /* no lock file, good */ }
  try {
    await fsWriteFile(TTS_LOCK, String(process.pid), "utf-8");
    return true;
  } catch { return false; }
}

async function releaseTTSLock() {
  try { const { unlink } = await import("node:fs/promises"); await unlink(TTS_LOCK); } catch { /* ignore */ }
}

/**
 * Speak text using the best available TTS engine.
 * Priority: Kokoro (GPU/CPU) → Piper → macOS say
 * Only one speak() call runs at a time — concurrent calls are skipped.
 *
 * @param {string} text - Text to speak
 * @param {object} [options]
 * @param {string} [options.voice] - Kokoro voice ID (e.g. "af_heart")
 * @param {Function} [options.onProgress] - Progress callback for downloads
 */
export async function speak(text, options = {}) {
  if (!text) return;
  if (speaking) return; // in-process mutex
  if (!await acquireTTSLock()) return; // cross-process mutex
  speaking = true;

  try {
    const { voice, onProgress } = typeof options === "function"
      ? { voice: null, onProgress: options }  // backwards compat: speak(text, onProgress)
      : options;

    // Try Kokoro first (works on all platforms, best quality)
    try {
      await speakKokoro(text, voice);
      return;
    } catch {
      // Kokoro unavailable — fall through
    }

    // macOS: use built-in `say`
    if (platform() === "darwin") {
      return speakMacOS(text);
    }

    // Fallback: Piper
    return speakPiper(text, onProgress);
  } finally {
    speaking = false;
    await releaseTTSLock();
  }
}

export { KOKORO_PRESET_VOICES, KOKORO_VOICES, KOKORO_DEFAULT_VOICE };
