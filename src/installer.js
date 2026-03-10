import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import { homedir } from "node:os";
import { getHookPlayCommand, processSound } from "./player.js";
import { EVENTS } from "./presets.js";

/**
 * Get the target directory based on install scope.
 */
function getTargetDir(scope) {
  if (scope === "global") {
    return join(homedir(), ".claude");
  }
  return join(process.cwd(), ".claude");
}

/**
 * Install sounds and configure hooks.
 *
 * @param {object} options
 * @param {string} options.scope - "global" or "project"
 * @param {Record<string, string>} options.sounds - Map of event ID -> source sound file path
 * @param {boolean} [options.tts] - Enable TTS voice summary on task complete
 * @param {number} [options.speed] - Voice speed multiplier (default 1.0)
 */
export async function install({ scope, sounds, tts = false, voice, speed } = {}) {
  const claudeDir = getTargetDir(scope);
  const soundsDir = join(claudeDir, "sounds");
  const settingsFile = join(claudeDir, "settings.json");

  // Create sounds directory
  await mkdir(soundsDir, { recursive: true });

  // Process and copy sound files (clamp to 10s with fadeout via ffmpeg)
  const installedSounds = {};
  for (const [eventId, sourcePath] of Object.entries(sounds)) {
    const processedPath = await processSound(sourcePath);
    const srcName = basename(sourcePath, extname(sourcePath));
    const outExt = extname(processedPath) || ".wav";
    const fileName = `${eventId}-${srcName}${outExt}`;
    const destPath = join(soundsDir, fileName);
    await copyFile(processedPath, destPath);
    installedSounds[eventId] = destPath;
  }

  // Read existing settings
  let settings = {};
  try {
    const existing = await readFile(settingsFile, "utf-8");
    settings = JSON.parse(existing);
  } catch {
    // File doesn't exist or is invalid — start fresh
  }

  // Build hooks config
  if (!settings.hooks) {
    settings.hooks = {};
  }

  for (const [eventId, soundPath] of Object.entries(installedSounds)) {
    const event = EVENTS[eventId];
    if (!event) continue;

    // Approval event uses a PreToolUse/PostToolUse timer instead of a direct hook
    if (eventId === "approval") {
      await installApprovalHooks(settings, soundPath, claudeDir);
      continue;
    }

    const hookEvent = event.hookEvent;
    // Enable TTS only for the "stop" event (task complete)
    const useTts = tts && eventId === "stop";
    const playCommand = getHookPlayCommand(soundPath, { tts: useTts, voice, speed });

    // Check if there's already a klaudio hook for this event
    if (!settings.hooks[hookEvent]) {
      settings.hooks[hookEvent] = [];
    }

    // Remove any existing klaudio/klonk entries (including legacy hooks without marker)
    settings.hooks[hookEvent] = settings.hooks[hookEvent].filter(
      (entry) => !entry._klaudio && !entry._klonk && !entry.hooks?.[0]?.command?.includes(".claude/sounds/")
    );

    // Add our hook
    settings.hooks[hookEvent].push({
      matcher: "",
      hooks: [
        {
          type: "command",
          command: playCommand,
        },
      ],
    });
  }

  // Write settings
  await writeFile(settingsFile, JSON.stringify(settings, null, 2) + "\n", "utf-8");

  // Also install Copilot coding agent hooks (.github/hooks/klaudio.json)
  await installCopilotHooks(installedSounds, scope);

  return {
    soundsDir,
    settingsFile,
    installedSounds,
  };
}

/**
 * Install approval notification hooks (PreToolUse/PostToolUse timer).
 * Writes a helper script and hooks that play a sound after 15s if no approval.
 */
async function installApprovalHooks(settings, soundPath, claudeDir) {
  const normalized = soundPath.replace(/\\/g, "/");
  const scriptPath = join(claudeDir, "klaudio-approval-notify.js").replace(/\\/g, "/");

  // Write the timer script (CJS so it works outside any module context)
  const script = `#!/usr/bin/env node
'use strict';
const { writeFileSync, readFileSync, unlinkSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const DELAY_MS = 120000;
const MARKER = join(tmpdir(), '.claude-approval-pending');
const SOUND = "${normalized}";

const action = process.argv[2];

if (action === 'start') {
  const token = process.pid + '-' + Date.now();
  writeFileSync(MARKER, token + '\\n' + process.cwd() + '\\n', 'utf-8');
  const child = spawn(process.execPath, [__filename, 'timer', token], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
} else if (action === 'cancel') {
  try { unlinkSync(MARKER); } catch (_) {}
} else if (action === 'timer') {
  const token = process.argv[3];
  setTimeout(function () {
    try {
      const content = readFileSync(MARKER, 'utf-8');
      const lines = content.trim().split('\\n');
      if (lines[0] !== token) return;
      unlinkSync(MARKER);
      const project = (lines[1] || '').split(/[\\/\\\\]/).pop() || 'project';
      spawnSync('npx', ['--yes', 'klaudio', 'play', SOUND], { stdio: 'ignore' });
      spawnSync('npx', ['--yes', 'klaudio', 'notify', project, 'Waiting for your approval'], { stdio: 'ignore' });
      spawnSync('npx', ['--yes', 'klaudio', 'say', project + ' needs your attention'], { stdio: 'ignore' });
    } catch (_) {}
  }, DELAY_MS);
}
`;
  await writeFile(scriptPath, script, "utf-8");

  // Add PreToolUse hook
  if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];
  settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter(
    (e) => !e._klaudio && !e._klonk
  );
  settings.hooks.PreToolUse.push({
    matcher: "",
    hooks: [{ type: "command", command: `node "${scriptPath}" start` }],
  });

  // Add PostToolUse hook
  if (!settings.hooks.PostToolUse) settings.hooks.PostToolUse = [];
  settings.hooks.PostToolUse = settings.hooks.PostToolUse.filter(
    (e) => !e._klaudio && !e._klonk
  );
  settings.hooks.PostToolUse.push({
    matcher: "",
    hooks: [{ type: "command", command: `node "${scriptPath}" cancel` }],
  });
}

/**
 * Install hooks for GitHub Copilot coding agent.
 * Writes .github/hooks/klaudio.json in the Copilot format.
 */
async function installCopilotHooks(installedSounds, scope) {
  // Find the repo root (.github lives at repo root)
  const repoRoot = scope === "global" ? null : process.cwd();
  if (!repoRoot) return; // Copilot hooks are project-scoped only

  const hooksDir = join(repoRoot, ".github", "hooks");
  const hooksFile = join(hooksDir, "klaudio.json");

  await mkdir(hooksDir, { recursive: true });

  // Read existing file if present
  let config = { version: 1, hooks: {} };
  try {
    const existing = await readFile(hooksFile, "utf-8");
    config = JSON.parse(existing);
    if (!config.hooks) config.hooks = {};
  } catch { /* start fresh */ }

  for (const [eventId, soundPath] of Object.entries(installedSounds)) {
    const event = EVENTS[eventId];
    if (!event?.copilotHookEvent) continue;

    const normalized = soundPath.replace(/\\/g, "/");
    const bashCmd = `afplay "${normalized}" 2>/dev/null & aplay "${normalized}" 2>/dev/null &`;
    const psCmd = `Add-Type -AssemblyName PresentationCore; $p = New-Object System.Windows.Media.MediaPlayer; $p.Open([System.Uri]::new('${normalized.replace(/\//g, "\\")}')); Start-Sleep -Milliseconds 200; $p.Play(); Start-Sleep -Seconds 2`;

    if (!config.hooks[event.copilotHookEvent]) {
      config.hooks[event.copilotHookEvent] = [];
    }

    // Remove existing klaudio entries
    config.hooks[event.copilotHookEvent] = config.hooks[event.copilotHookEvent].filter(
      (entry) => !entry._klaudio
    );

    config.hooks[event.copilotHookEvent].push({
      type: "command",
      bash: bashCmd,
      powershell: psCmd,
      timeoutSec: 10,
      comment: `klaudio: ${event.name}`,
    });
  }

  await writeFile(hooksFile, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

/**
 * Read existing klaudio sound selections from settings.
 * Returns a map of eventId -> soundFilePath (from the sounds/ dir).
 */
export async function getExistingSounds(scope) {
  const claudeDir = getTargetDir(scope);
  const settingsFile = join(claudeDir, "settings.json");
  const sounds = {};

  try {
    const existing = await readFile(settingsFile, "utf-8");
    const settings = JSON.parse(existing);
    if (!settings.hooks) return sounds;

    for (const [eventId, event] of Object.entries(EVENTS)) {
      // Approval event: read sound from the klaudio-approval-notify.js script
      if (eventId === "approval") {
        const scriptPath = join(claudeDir, "klaudio-approval-notify.js");
        try {
          const script = await readFile(scriptPath, "utf-8");
          const m = script.match(/SOUND\s*=\s*"([^"]+\.(wav|mp3|ogg|flac|aac))"/);
          if (m) {
            sounds[eventId] = m[1].replace(/\//g, join("a", "b").includes("\\") ? "\\" : "/");
          }
        } catch { /* no script */ }
        continue;
      }

      const hookEntries = settings.hooks[event.hookEvent];
      if (!hookEntries) continue;
      const entry = hookEntries.find((e) => e._klaudio || e._klonk
        || e.hooks?.[0]?.command?.includes("klaudio")
        || e.hooks?.[0]?.command?.includes(".claude/sounds/"));
      if (!entry?.hooks?.[0]?.command) continue;

      // Extract file path from the play command
      // Commands contain the path in quotes: ... "path/to/file" ...
      const match = entry.hooks[0].command.match(/"([^"]+\.(wav|mp3|ogg|flac|aac))"/);
      if (match) {
        const soundPath = match[1].replace(/\//g, join("a", "b").includes("\\") ? "\\" : "/");
        sounds[eventId] = soundPath;
      }
    }
  } catch { /* no existing config */ }

  return sounds;
}

/**
 * Check if existing hooks are outdated (missing features from newer versions).
 * Returns a list of reasons why hooks should be updated.
 */
export async function checkHooksOutdated(scope) {
  const claudeDir = getTargetDir(scope);
  const settingsFile = join(claudeDir, "settings.json");
  const reasons = [];

  try {
    const existing = await readFile(settingsFile, "utf-8");
    const settings = JSON.parse(existing);
    if (!settings.hooks) return reasons;

    const isOurs = (e) => e._klaudio || e._klonk || e.hooks?.[0]?.command?.includes("klaudio") || e.hooks?.[0]?.command?.includes(".claude/sounds/");

    // Check Stop hook for --notify flag
    const stopEntries = settings.hooks.Stop || [];
    const stopHook = stopEntries.find(isOurs);
    if (stopHook?.hooks?.[0]?.command && !stopHook.hooks[0].command.includes("--notify")) {
      reasons.push("System notifications on task complete");
    }

    // Check Notification hook for --notify flag
    const notifEntries = settings.hooks.Notification || [];
    const notifHook = notifEntries.find(isOurs);
    if (notifHook?.hooks?.[0]?.command && !notifHook.hooks[0].command.includes("--notify")) {
      reasons.push("System notifications on background task");
    }

    // Check approval script exists as the new Node.js version
    const oldScriptPath = join(claudeDir, "approval-notify.sh");
    const newScriptPath = join(claudeDir, "klaudio-approval-notify.js");
    try {
      await readFile(oldScriptPath, "utf-8");
      // Old bash script still present — needs upgrade
      reasons.push("Approval timer upgraded to cross-platform Node.js");
    } catch { /* old script gone, good */ }
    try {
      const script = await readFile(newScriptPath, "utf-8");
      const delayMatch = script.match(/DELAY_MS\s*=\s*(\d+)/);
      if (delayMatch && parseInt(delayMatch[1]) < 120000) {
        reasons.push("Approval timer too short (now 120s)");
      }
    } catch { /* no script */ }

    // Check for duplicate hooks (old bug)
    for (const [event, entries] of Object.entries(settings.hooks)) {
      const klaudioEntries = entries.filter(isOurs);
      if (klaudioEntries.length > 1) {
        reasons.push(`Duplicate ${event} hooks`);
      }
    }
  } catch { /* no existing config */ }

  return reasons;
}

/**
 * Uninstall klaudio hooks from settings.
 */
export async function uninstall(scope) {
  const claudeDir = getTargetDir(scope);
  const settingsFile = join(claudeDir, "settings.json");

  try {
    const existing = await readFile(settingsFile, "utf-8");
    const settings = JSON.parse(existing);

    if (settings.hooks) {
      for (const [event, entries] of Object.entries(settings.hooks)) {
        settings.hooks[event] = entries.filter(
          (entry) => !entry._klaudio && !entry._klonk && !entry.hooks?.[0]?.command?.includes(".claude/sounds/")
        );
        if (settings.hooks[event].length === 0) {
          delete settings.hooks[event];
        }
      }
      if (Object.keys(settings.hooks).length === 0) {
        delete settings.hooks;
      }
    }

    await writeFile(settingsFile, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  } catch { /* no existing config */ }

  // Also clean up Copilot hooks
  await uninstallCopilotHooks(scope);

  return true;
}

/**
 * Remove klaudio entries from .github/hooks/klaudio.json.
 */
async function uninstallCopilotHooks(scope) {
  if (scope === "global") return;
  const hooksFile = join(process.cwd(), ".github", "hooks", "klaudio.json");
  try {
    const { unlink } = await import("node:fs/promises");
    await unlink(hooksFile);
  } catch { /* file doesn't exist */ }
}
