import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Detect compiled bun binary: import.meta.url starts with "bun:" or "B:/"
const isCompiledBinary = import.meta.url.startsWith("bun:") || import.meta.url.startsWith("B:/~BUN/");
const SOUNDS_DIR = isCompiledBinary
  ? join(dirname(process.execPath), "sounds")
  : join(__dirname, "..", "sounds");

/**
 * Sound events that can be configured.
 */
export const EVENTS = {
  notification: {
    name: "Notification",
    description: "Plays when Claude needs your attention",
    hookEvent: "Notification",
    copilotHookEvent: null, // Copilot doesn't have this yet
  },
  stop: {
    name: "Task Complete",
    description: "Plays when Claude finishes a response",
    hookEvent: "Stop",
    copilotHookEvent: "sessionEnd",
  },
};

/**
 * Built-in presets with their sound file mappings.
 */
export const PRESETS = {
  "retro-8bit": {
    name: "Retro 8-bit",
    icon: "🎮",
    description: "Chiptune bleeps, bloops, and victory jingles",
    sounds: {
      stop: join(SOUNDS_DIR, "retro-8bit", "stop.wav"),
      notification: join(SOUNDS_DIR, "retro-8bit", "notification.wav"),
    },
  },
  "minimal-zen": {
    name: "Minimal Zen",
    icon: "🔔",
    description: "Soft chimes and gentle tones",
    sounds: {
      stop: join(SOUNDS_DIR, "minimal-zen", "stop.wav"),
      notification: join(SOUNDS_DIR, "minimal-zen", "notification.wav"),
    },
  },
  "sci-fi-terminal": {
    name: "Sci-Fi Terminal",
    icon: "🚀",
    description: "Futuristic UI bleeps and digital notifications",
    sounds: {
      stop: join(SOUNDS_DIR, "sci-fi-terminal", "stop.wav"),
      notification: join(SOUNDS_DIR, "sci-fi-terminal", "notification.wav"),
    },
  },
  "victory-fanfare": {
    name: "Victory Fanfare",
    icon: "🏆",
    description: "Celebratory jingles for task completion",
    sounds: {
      stop: join(SOUNDS_DIR, "victory-fanfare", "stop.wav"),
      notification: join(SOUNDS_DIR, "victory-fanfare", "notification.wav"),
    },
  },
};

export function getPresetSoundPath(presetId, eventId) {
  return PRESETS[presetId]?.sounds[eventId];
}

export function getSoundsDir() {
  return SOUNDS_DIR;
}
