#!/usr/bin/env node

// Subcommand: klaudio play <file> [--tts] [--voice <voice>]
if (process.argv[2] === "play") {
  const { handlePlayCommand } = await import("../src/player.js");
  await handlePlayCommand(process.argv.slice(3));
  // Hard exit: skip native module destructors (onnxruntime crashes during cleanup)
  process._exit(0);
}

// Subcommand: klaudio notify "title" "body"
if (process.argv[2] === "notify") {
  const title = process.argv[3] || "klaudio";
  const body = process.argv[4] || "";
  if (body) {
    const { sendNotification } = await import("../src/notify.js");
    await sendNotification(title, body);
  }
  process.exit(0);
}

// Subcommand: klaudio say "text" [--voice <voice>]
if (process.argv[2] === "say") {
  const args = process.argv.slice(3);
  const text = args.find((a) => !a.startsWith("--"));
  const voice = args.find((a) => a.startsWith("--voice="))?.slice(8)
    || args[args.indexOf("--voice") + 1];
  if (text) {
    const { speak } = await import("../src/tts.js");
    await speak(text, { voice });
  }
  // Hard exit: skip native module destructors (onnxruntime crashes during cleanup)
  process._exit(0);
}

// Subcommand: klaudio help / --help / -h
if (["help", "--help", "-h"].includes(process.argv[2])) {
  console.log(`
  klaudio — sound effects & music for your coding sessions

  Usage:
    npx klaudio                Interactive installer / music player
    npx klaudio --uninstall    Remove installed hooks
    npx klaudio play <file>    Play a sound file
    npx klaudio say "text"     Speak text via TTS
    npx klaudio notify "t" "b" Send a desktop notification
    npx klaudio help           Show this help
`);
  process.exit(0);
}

// Default: interactive installer UI
const { run } = await import("../src/cli.js");

run().catch((err) => {
  if (err.name === "ExitPromptError") {
    // User pressed Ctrl+C
    console.log("\n  Cancelled.\n");
    process.exit(0);
  }
  console.error(err);
  process.exit(1);
});
