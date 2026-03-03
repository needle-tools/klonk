import { execFile } from "node:child_process";
import { readdir, mkdir, stat, chmod } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { join, extname, basename, resolve as resolvePath } from "node:path";
import { platform, homedir, tmpdir } from "node:os";
import { pipeline } from "node:stream/promises";

const TOOLS_DIR = join(homedir(), ".klaudio", "tools");

// Packed audio formats that vgmstream-cli can convert to WAV
const PACKED_EXTENSIONS = new Set([".wem", ".bnk", ".bank", ".fsb", ".pck"]);

/**
 * Check if a file is a packed audio format we can extract.
 */
export function isPackedAudio(filePath) {
  return PACKED_EXTENSIONS.has(extname(filePath).toLowerCase());
}

/**
 * Check if a game directory has extractable packed audio.
 */
export async function hasPackedAudio(gamePath) {
  const formats = { wem: 0, bnk: 0, bank: 0, fsb: 0, pck: 0 };
  await scanForPackedAudio(gamePath, formats, 0);
  return {
    total: Object.values(formats).reduce((a, b) => a + b, 0),
    formats,
  };
}

async function scanForPackedAudio(dir, formats, depth) {
  if (depth > 5) return;
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await scanForPackedAudio(join(dir, entry.name), formats, depth + 1);
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase().slice(1);
        if (ext in formats) formats[ext]++;
      }
      // Stop early if we found enough
      if (Object.values(formats).reduce((a, b) => a + b, 0) > 100) return;
    }
  } catch { /* skip */ }
}

/**
 * Get the path to vgmstream-cli, downloading it if needed.
 */
export async function getVgmstreamPath(onProgress) {
  const os = platform();
  const exeName = os === "win32" ? "vgmstream-cli.exe" : "vgmstream-cli";
  const toolPath = join(TOOLS_DIR, exeName);

  // Check if already downloaded
  try {
    await stat(toolPath);
    return toolPath;
  } catch { /* not found, need to download */ }

  if (onProgress) onProgress("Downloading vgmstream-cli...");

  await mkdir(TOOLS_DIR, { recursive: true });

  // Download the appropriate release
  const isWindows = os === "win32";
  const releaseUrl = isWindows
    ? "https://github.com/vgmstream/vgmstream-releases/releases/download/nightly/vgmstream-win64.zip"
    : os === "darwin"
      ? "https://github.com/vgmstream/vgmstream-releases/releases/download/nightly/vgmstream-mac-cli.tar.gz"
      : "https://github.com/vgmstream/vgmstream-releases/releases/download/nightly/vgmstream-linux-cli.tar.gz";

  const archiveExt = isWindows ? ".zip" : ".tar.gz";
  const archivePath = join(tmpdir(), `vgmstream${archiveExt}`);

  // Download using Node.js fetch
  const response = await fetch(releaseUrl, { redirect: "follow" });
  if (!response.ok) throw new Error(`Failed to download vgmstream: ${response.status}`);

  const fileStream = createWriteStream(archivePath);
  await pipeline(response.body, fileStream);

  if (onProgress) onProgress("Extracting vgmstream-cli...");

  // Extract: PowerShell for Windows, tar for macOS/Linux
  if (isWindows) {
    await new Promise((resolve, reject) => {
      execFile("powershell.exe", [
        "-NoProfile", "-Command",
        `Expand-Archive -Path '${archivePath}' -DestinationPath '${TOOLS_DIR}' -Force`,
      ], { windowsHide: true }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  } else {
    await new Promise((resolve, reject) => {
      execFile("tar", ["xzf", archivePath, "-C", TOOLS_DIR], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    // Make executable
    try { await chmod(toolPath, 0o755); } catch { /* ignore */ }
    // Remove macOS quarantine attribute so Gatekeeper doesn't block execution
    if (os === "darwin") {
      try {
        await new Promise((resolve) => {
          execFile("xattr", ["-d", "com.apple.quarantine", toolPath], () => resolve());
        });
      } catch { /* ignore — attribute may not exist */ }
    }
  }

  // Verify it exists
  await stat(toolPath);
  return toolPath;
}

/**
 * Find all extractable audio files in a game directory.
 */
export async function findPackedAudioFiles(gamePath, maxFiles = 50) {
  const results = [];

  async function scan(dir, depth = 0) {
    if (depth > 5 || results.length >= maxFiles) return;
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (results.length >= maxFiles) break;
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          const lower = entry.name.toLowerCase();
          if (["__pycache__", "node_modules", ".git"].some(s => lower.includes(s))) continue;
          await scan(fullPath, depth + 1);
        } else if (entry.isFile()) {
          const ext = extname(entry.name).toLowerCase();
          // Formats vgmstream-cli can convert directly
          // (.bnk needs bnkextr preprocessing — skip for now)
          if (ext === ".wem" || ext === ".fsb" || ext === ".bank") {
            results.push({ path: fullPath, name: entry.name, dir });
          }
        }
      }
    } catch { /* skip */ }
  }

  await scan(gamePath);
  return results;
}

/**
 * Extract/convert a packed audio file to WAV using vgmstream-cli.
 *
 * @param {string} inputPath - Path to .wem/.bnk/.bank/.fsb file
 * @param {string} outputDir - Directory to write WAV files to
 * @param {string} vgmstreamPath - Path to vgmstream-cli binary
 * @returns {string[]} Array of output WAV file paths
 */
export async function extractToWav(inputPath, outputDir, vgmstreamPath) {
  await mkdir(outputDir, { recursive: true });

  // Resolve to absolute OS-native paths (critical on Windows where
  // MSYS uses forward slashes but native exes need backslashes)
  const absInput = resolvePath(inputPath);
  const ext = extname(absInput).toLowerCase();
  const baseName = basename(absInput, ext);
  const outputPath = resolvePath(join(outputDir, `${baseName}.wav`));

  return new Promise((resolve, reject) => {
    // For .bnk files, vgmstream can extract subsongs
    // First try with -S flag to get subsong count
    execFile(vgmstreamPath, ["-m", absInput], { windowsHide: true, timeout: 10000 }, (err, stdout) => {
      if (err) {
        // Single file conversion
        execFile(vgmstreamPath, ["-o", outputPath, absInput], { windowsHide: true, timeout: 30000 }, (err2) => {
          if (err2) reject(new Error(`Failed to convert ${basename(absInput)}: ${err2.message}`));
          else resolve([outputPath]);
        });
        return;
      }

      // Check if it has multiple subsongs
      const subsongMatch = stdout.match(/stream count:\s*(\d+)/i) || stdout.match(/subsong count:\s*(\d+)/i);
      const subsongCount = subsongMatch ? parseInt(subsongMatch[1]) : 1;

      if (subsongCount <= 1) {
        // Single conversion
        execFile(vgmstreamPath, ["-o", outputPath, absInput], { windowsHide: true, timeout: 30000 }, (err2) => {
          if (err2) reject(new Error(`Failed to convert ${basename(absInput)}: ${err2.message}`));
          else resolve([outputPath]);
        });
      } else {
        // Extract each subsong (up to 20)
        const count = Math.min(subsongCount, 20);
        const outputs = [];
        let done = 0;

        for (let i = 1; i <= count; i++) {
          const subOutput = join(outputDir, `${baseName}_${String(i).padStart(3, "0")}.wav`);
          execFile(vgmstreamPath, ["-o", resolvePath(subOutput), "-s", String(i), absInput], { windowsHide: true, timeout: 30000 }, (err2) => {
            if (!err2) outputs.push(subOutput);
            done++;
            if (done === count) resolve(outputs);
          });
        }
      }
    });
  });
}
