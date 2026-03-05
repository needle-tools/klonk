# Changelog

## 0.12.3

- **Fix TTS crash on exit** — onnxruntime native module destructors crash during process cleanup; now uses hard exit to skip destructors after TTS completes
- **Fix "Updates available" loop** — re-applying hooks now correctly removes legacy hooks (without `_klaudio` marker) before adding new ones

## 0.12.2

- **Fix TTS crash on macOS** — Kokoro native module could abort the process with a C++ exception; now checks availability before loading
- **Fix existing sounds not detected** — hooks installed by older versions (without `_klaudio` marker) are now recognized via `.claude/sounds/` path detection
- **Fix update notification not showing** — hooks are now stamped with a version number; outdated hooks trigger an update prompt
- **Fix uninstall missing old hooks** — uninstall now removes hooks from older versions that lacked the `_klaudio` marker
- **Add `help` subcommand** — `npx klaudio help` / `--help` / `-h` prints usage info

## 0.12.1

- Add `help` subcommand (`npx klaudio help`)

## 0.12.0

- Music Player mode with shuffle and per-game playback
- Voice summary (TTS) via Kokoro / Piper / macOS `say`
- System sounds source
- Duration filter in sound picker (`<10s`, `>5s`)
- Update detection and re-apply option
- Hook versioning
