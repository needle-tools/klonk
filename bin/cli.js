#!/usr/bin/env node

// Subcommand: klaudio play <file> [--tts] [--voice <voice>]
if (process.argv[2] === "play") {
  const { handlePlayCommand } = await import("../src/player.js");
  await handlePlayCommand(process.argv.slice(3));
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
