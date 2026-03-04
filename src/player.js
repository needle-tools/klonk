import { execFile, spawn } from "node:child_process";
import { platform } from "node:os";
import { resolve, extname, basename, join } from "node:path";
import { open, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

const MAX_PLAY_SECONDS = 10;
const FADE_SECONDS = 2; // fade out over last 2 seconds

// Formats that Windows MediaPlayer (PresentationCore) can play natively
const MEDIA_PLAYER_FORMATS = new Set([".wav", ".mp3", ".wma", ".aac"]);

/**
 * Determine the best playback strategy for a file on the current OS.
 */
function getPlaybackCommand(absPath, { withFade = false, maxSeconds = MAX_PLAY_SECONDS } = {}) {
  const os = platform();
  const ext = extname(absPath).toLowerCase();

  // ffplay args with optional fade-out and silence-skip
  const ffplayArgs = ["-nodisp", "-autoexit", "-loglevel", "quiet"];
  if (withFade) {
    // silenceremove strips leading silence (below -50dB threshold)
    // afade fades out over last FADE_SECONDS before the maxSeconds cut
    const fadeStart = maxSeconds - FADE_SECONDS;
    const filters = [
      "silenceremove=start_periods=1:start_silence=0.1:start_threshold=-50dB",
      `afade=t=out:st=${fadeStart}:d=${FADE_SECONDS}`,
    ];
    ffplayArgs.push("-af", filters.join(","));
    ffplayArgs.push("-t", String(maxSeconds));
  }
  ffplayArgs.push(absPath);

  if (os === "darwin") {
    // afplay doesn't support filters — use ffplay if fade needed, fall back to afplay
    if (withFade) {
      return { type: "exec", cmd: "ffplay", args: ffplayArgs, fallback: "afplay" };
    }
    return { type: "exec", cmd: "afplay", args: [absPath] };
  }

  if (os === "win32") {
    if (withFade || !MEDIA_PLAYER_FORMATS.has(ext)) {
      // Prefer ffplay for fade support and non-native formats; fall back to PowerShell
      return {
        type: "exec",
        cmd: "ffplay",
        args: ffplayArgs,
        fallback: "powershell",
      };
    }
    return { type: "powershell", absPath };
  }

  // Linux
  if (ext === ".wav" && !withFade) {
    return { type: "exec", cmd: "aplay", args: [absPath] };
  }
  return {
    type: "exec",
    cmd: "ffplay",
    args: ffplayArgs,
  };
}

function buildPsCommand(absPath, maxSeconds = 0) {
  const limit = maxSeconds > 0 ? maxSeconds : 30;
  const fadeStart = (limit - FADE_SECONDS) * 10; // in 100ms ticks
  return `
    Add-Type -AssemblyName PresentationCore
    $player = New-Object System.Windows.Media.MediaPlayer
    $player.Open([System.Uri]::new("${absPath.replace(/\\/g, "/")}"))
    Start-Sleep -Milliseconds 300
    $player.Play()
    $player.Volume = 1.0
    $elapsed = 0
    while ($player.Position -lt $player.NaturalDuration.TimeSpan -and $player.NaturalDuration.HasTimeSpan -and $elapsed -lt ${limit * 10}) {
      Start-Sleep -Milliseconds 100
      $elapsed++
      if ($elapsed -gt ${fadeStart} -and ${limit * 10} -gt ${fadeStart}) {
        $remaining = ${limit * 10} - $elapsed
        $total = ${FADE_SECONDS * 10}
        if ($total -gt 0) { $player.Volume = [Math]::Max(0, [double]$remaining / [double]$total) }
      }
    }
    $player.Stop()
    $player.Close()
  `.trim();
}

/**
 * Get the duration of a WAV file in seconds by reading its header.
 * Returns null if unable to determine.
 */
export async function getWavDuration(filePath) {
  const absPath = resolve(filePath);
  const ext = extname(absPath).toLowerCase();

  // Try ffprobe first (handles all formats and non-standard WAV headers)
  const ffDuration = await getFFprobeDuration(absPath);
  if (ffDuration != null) return ffDuration;

  // Fallback: parse WAV header directly
  if (ext === ".wav") {
    return getWavDurationFromHeader(absPath);
  }

  return null;
}

async function getWavDurationFromHeader(absPath) {
  let fh;
  try {
    fh = await open(absPath, "r");
    const header = Buffer.alloc(44);
    await fh.read(header, 0, 44, 0);

    // Verify RIFF/WAVE
    if (header.toString("ascii", 0, 4) !== "RIFF") return null;
    if (header.toString("ascii", 8, 12) !== "WAVE") return null;

    // Read fmt chunk (assuming standard PCM at offset 20)
    const channels = header.readUInt16LE(22);
    const sampleRate = header.readUInt32LE(24);
    const bitsPerSample = header.readUInt16LE(34);

    if (sampleRate === 0 || channels === 0 || bitsPerSample === 0) return null;

    // Data chunk size is at offset 40 in standard WAV
    const dataSize = header.readUInt32LE(40);
    const bytesPerSecond = sampleRate * channels * (bitsPerSample / 8);

    if (bytesPerSecond === 0) return null;
    return Math.round((dataSize / bytesPerSecond) * 10) / 10;
  } catch {
    return null;
  } finally {
    if (fh) await fh.close();
  }
}

function getFFprobeDuration(absPath) {
  return new Promise((res) => {
    execFile(
      "ffprobe",
      ["-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", absPath],
      { windowsHide: true, timeout: 5000 },
      (err, stdout) => {
        if (err) return res(null);
        const val = parseFloat(stdout.trim());
        if (isNaN(val)) return res(null);
        res(Math.round(val * 10) / 10);
      }
    );
  });
}

/**
 * Play a sound file. Returns a promise that resolves when playback starts
 * (not when it finishes — we don't want to block).
 */
export function playSound(filePath) {
  const absPath = resolve(filePath);
  const strategy = getPlaybackCommand(absPath);

  return new Promise((resolvePromise) => {
    if (strategy.type === "exec") {
      const child = spawn(strategy.cmd, strategy.args, {
        stdio: "ignore",
        detached: true,
        windowsHide: true,
      });
      child.unref();
      resolvePromise();
      child.on("error", () => {
        if (strategy.fallback === "powershell") {
          const ps = spawn("powershell.exe", ["-NoProfile", "-Command", buildPsCommand(absPath)], {
            stdio: "ignore", detached: true, windowsHide: true,
          });
          ps.unref();
        }
      });
    } else if (strategy.type === "powershell") {
      const child = spawn("powershell.exe", ["-NoProfile", "-Command", buildPsCommand(absPath)], {
        stdio: "ignore", detached: true, windowsHide: true,
      });
      child.unref();
      resolvePromise();
    }
  });
}

/**
 * Play a sound and wait for it to finish (for preview mode).
 * Returns { promise, cancel } — call cancel() to stop playback immediately.
 * Playback is clamped to MAX_PLAY_SECONDS.
 */
export function playSoundWithCancel(filePath, { maxSeconds = MAX_PLAY_SECONDS } = {}) {
  const uncapped = !maxSeconds;
  const absPath = resolve(filePath);
  const strategy = getPlaybackCommand(absPath, { withFade: !uncapped, maxSeconds });
  let childProcess = null;
  let timer = null;
  let cancelled = false;

  function killChild() {
    if (childProcess && !childProcess.killed) {
      try {
        // On Windows, spawned processes need taskkill for the process tree
        if (platform() === "win32") {
          spawn("taskkill", ["/pid", String(childProcess.pid), "/f", "/t"], {
            stdio: "ignore", windowsHide: true,
          });
        } else {
          childProcess.kill("SIGTERM");
        }
      } catch { /* ignore */ }
    }
    if (timer) clearTimeout(timer);
  }

  const cancel = () => {
    cancelled = true;
    killChild();
  };

  const promise = new Promise((resolvePromise, reject) => {
    function onDone(err) {
      if (timer) clearTimeout(timer);
      if (cancelled) return resolvePromise(); // cancelled — resolve, don't reject
      if (err) reject(err);
      else resolvePromise();
    }

    function startExec(cmd, args) {
      const execTimeout = uncapped ? 0 : (maxSeconds + 2) * 1000;
      childProcess = execFile(cmd, args, { windowsHide: true, timeout: execTimeout }, (err) => {
        if (err && strategy.fallback && !cancelled) {
          if (strategy.fallback === "powershell") {
            childProcess = execFile(
              "powershell.exe",
              ["-NoProfile", "-Command", buildPsCommand(absPath, uncapped ? 0 : maxSeconds)],
              { windowsHide: true, timeout: execTimeout },
              (psErr) => onDone(psErr)
            );
          } else if (strategy.fallback === "afplay") {
            // macOS: ffplay not available, fall back to afplay (no fade)
            childProcess = execFile("afplay", [absPath], { timeout: execTimeout }, (afErr) => onDone(afErr));
          }
        } else {
          onDone(err);
        }
      });

      // Set a hard timeout to kill after maxSeconds (skip if uncapped)
      if (!uncapped) {
        timer = setTimeout(() => {
          killChild();
          resolvePromise();
        }, maxSeconds * 1000);
      }
    }

    if (strategy.type === "exec") {
      startExec(strategy.cmd, strategy.args);
    } else if (strategy.type === "powershell") {
      const execTimeout = uncapped ? 0 : (maxSeconds + 2) * 1000;
      childProcess = execFile(
        "powershell.exe",
        ["-NoProfile", "-Command", buildPsCommand(absPath, uncapped ? 0 : maxSeconds)],
        { windowsHide: true, timeout: execTimeout },
        (err) => onDone(err)
      );
      if (!uncapped) {
        timer = setTimeout(() => {
          killChild();
          resolvePromise();
        }, maxSeconds * 1000);
      }
    }
  });

  const pause = () => {
    if (childProcess && !childProcess.killed && platform() !== "win32") {
      try { process.kill(childProcess.pid, "SIGSTOP"); } catch { /* ignore */ }
    }
  };

  const resume = () => {
    if (childProcess && !childProcess.killed && platform() !== "win32") {
      try { process.kill(childProcess.pid, "SIGCONT"); } catch { /* ignore */ }
    }
  };

  return { promise, cancel, pause, resume };
}

/**
 * Play a sound and wait for it to finish (legacy — no cancel support).
 */
export function playSoundSync(filePath) {
  return playSoundWithCancel(filePath).promise;
}

/**
 * Process a sound file with ffmpeg: strip leading silence, clamp to MAX_PLAY_SECONDS,
 * and fade out over the last FADE_SECONDS. Returns the path to the processed WAV file.
 * If ffmpeg is not available or the file is already short enough, returns the original path.
 */
export async function processSound(filePath) {
  const absPath = resolve(filePath);

  // First check duration — skip processing if already short
  const duration = await getWavDuration(absPath);
  if (duration != null && duration <= MAX_PLAY_SECONDS) {
    return absPath; // Already short enough, no processing needed
  }

  // Build a deterministic output path based on input file hash
  const hash = createHash("md5").update(absPath).digest("hex").slice(0, 12);
  const outDir = join(tmpdir(), "klaudio-processed");
  const outName = `${basename(absPath, extname(absPath))}_${hash}.wav`;
  const outPath = join(outDir, outName);

  // Check if already processed
  try {
    await stat(outPath);
    return outPath; // Already exists
  } catch { /* needs processing */ }

  await mkdir(outDir, { recursive: true });

  // Build ffmpeg filter chain: silence strip → fade out → clamp duration
  const fadeStart = MAX_PLAY_SECONDS - FADE_SECONDS;
  const filters = [
    "silenceremove=start_periods=1:start_silence=0.1:start_threshold=-50dB",
    `afade=t=out:st=${fadeStart}:d=${FADE_SECONDS}`,
  ].join(",");

  return new Promise((res) => {
    execFile(
      "ffmpeg",
      [
        "-y", "-i", absPath,
        "-af", filters,
        "-t", String(MAX_PLAY_SECONDS),
        "-ar", "44100", "-ac", "2",
        outPath,
      ],
      { windowsHide: true, timeout: 30000 },
      (err) => {
        if (err) {
          // ffmpeg not available or failed — return original
          res(absPath);
        } else {
          res(outPath);
        }
      },
    );
  });
}

/**
 * Handle the "play" subcommand: play a sound file and optionally speak a TTS summary.
 * Reads hook JSON from stdin to get last_assistant_message for TTS.
 */
export async function handlePlayCommand(args) {
  const soundFile = args.find((a) => !a.startsWith("-"));
  const tts = args.includes("--tts");

  // Read stdin (hook JSON) non-blocking
  let hookData = {};
  try {
    const chunks = [];
    process.stdin.setEncoding("utf-8");
    // Read whatever is available with a short timeout
    const stdinData = await new Promise((res) => {
      const timer = setTimeout(() => { process.stdin.pause(); res(chunks.join("")); }, 500);
      process.stdin.on("data", (chunk) => chunks.push(chunk));
      process.stdin.on("end", () => { clearTimeout(timer); res(chunks.join("")); });
      process.stdin.resume();
    });
    if (stdinData.trim()) hookData = JSON.parse(stdinData);
  } catch { /* no stdin or invalid JSON */ }

  // Play sound (fire and forget, don't wait)
  const soundPromise = soundFile
    ? playSoundWithCancel(soundFile).promise.catch(() => {})
    : Promise.resolve();

  // TTS: speak first 1-2 sentences of last_assistant_message
  if (tts && hookData.last_assistant_message) {
    // Strip markdown syntax and extract first sentence
    const msg = hookData.last_assistant_message
      .replace(/```[\s\S]*?```/g, "")      // remove code blocks
      .replace(/`([^`]+)`/g, "$1")          // inline code -> text
      .replace(/\*\*([^*]+)\*\*/g, "$1")    // **bold** -> text
      .replace(/\*([^*]+)\*/g, "$1")        // *italic* -> text
      .replace(/__([^_]+)__/g, "$1")        // __bold__ -> text
      .replace(/_([^_]+)_/g, "$1")          // _italic_ -> text
      .replace(/#{1,6}\s+/g, "")            // headings
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // [links](url) -> text
      .replace(/^\s*[-*+]\s+/gm, "")        // list bullets
      .replace(/^\s*\d+\.\s+/gm, "")        // numbered lists
      .replace(/\n+/g, " ")                 // newlines -> spaces
      .trim();
    const sentences = msg.match(/[^.!?]*[.!?]/g);
    const summary = sentences ? sentences[0].trim() : msg.slice(0, 100);
    await soundPromise;
    const { speak } = await import("./tts.js");
    await speak(summary);
  } else {
    await soundPromise;
  }
}

/**
 * Generate the shell command string for use in Claude Code hooks.
 */
export function getHookPlayCommand(soundFilePath, { tts = false } = {}) {
  const normalized = soundFilePath.replace(/\\/g, "/");
  const ttsFlag = tts ? " --tts" : "";
  return `npx klaudio play "${normalized}"${ttsFlag}`;
}
