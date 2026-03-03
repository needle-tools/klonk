import React, { useState, useEffect, useCallback, useRef } from "react";
import { render, Box, Text, useInput, useApp } from "ink";
import Spinner from "ink-spinner";
import { PRESETS, EVENTS } from "./presets.js";
import { playSoundWithCancel, getWavDuration } from "./player.js";
import { getAvailableGames } from "./scanner.js";
import { install, uninstall, getExistingSounds } from "./installer.js";
import { getVgmstreamPath, findPackedAudioFiles, extractToWav } from "./extractor.js";
import { extractUnityResource } from "./unity.js";
import { extractBunFile, isBunFile } from "./scumm.js";
import { getCachedExtraction, cacheExtraction, categorizeLooseFiles, getCategories, sortFilesByPriority } from "./cache.js";
import { basename, dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAX_PLAY_SECONDS = 10;
const ACCENT = "#76C41E"; // Needle green-yellow midpoint

const h = React.createElement;

// ── Custom SelectInput components (bright colors for CMD) ────
const Indicator = ({ isSelected }) =>
  h(Box, { marginRight: 1 }, isSelected
    ? h(Text, { color: ACCENT }, "❯")
    : h(Text, null, " "));

const Item = ({ isSelected, label }) =>
  h(Text, { color: isSelected ? ACCENT : undefined, bold: isSelected }, label);

// ── Non-wrapping SelectInput (clamps at boundaries) ─────────────
const SelectInput = ({ items = [], isFocused = true, initialIndex = 0, indicatorComponent = Indicator, itemComponent = Item, limit: customLimit, onSelect, onHighlight }) => {
  const hasLimit = typeof customLimit === "number" && items.length > customLimit;
  const limit = hasLimit ? Math.min(customLimit, items.length) : items.length;
  const [scrollOffset, setScrollOffset] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(initialIndex ? Math.min(initialIndex, items.length - 1) : 0);
  const previousItems = useRef(items);

  useEffect(() => {
    const prevValues = previousItems.current.map((i) => i.value);
    const curValues = items.map((i) => i.value);
    if (prevValues.length !== curValues.length || prevValues.some((v, i) => v !== curValues[i])) {
      setScrollOffset(0);
      setSelectedIndex(0);
    }
    previousItems.current = items;
  }, [items]);

  useInput(useCallback((input, key) => {
    if (input === "k" || key.upArrow) {
      if (selectedIndex <= 0) return; // clamp — don't wrap
      const next = selectedIndex - 1;
      let newOffset = scrollOffset;
      if (hasLimit && next < scrollOffset) newOffset = next;
      setSelectedIndex(next);
      setScrollOffset(newOffset);
      if (typeof onHighlight === "function") onHighlight(items[next]);
    }
    if (input === "j" || key.downArrow) {
      if (selectedIndex >= items.length - 1) return; // clamp — don't wrap
      const next = selectedIndex + 1;
      let newOffset = scrollOffset;
      if (hasLimit && next >= scrollOffset + limit) newOffset = next - limit + 1;
      setSelectedIndex(next);
      setScrollOffset(newOffset);
      if (typeof onHighlight === "function") onHighlight(items[next]);
    }
    if (key.return) {
      if (typeof onSelect === "function") onSelect(items[selectedIndex]);
    }
  }, [hasLimit, limit, scrollOffset, selectedIndex, items, onSelect, onHighlight]), { isActive: isFocused });

  const visible = hasLimit ? items.slice(scrollOffset, scrollOffset + limit) : items;
  return h(Box, { flexDirection: "column" }, visible.map((item, index) => {
    const isSelected = index + scrollOffset === selectedIndex;
    return h(Box, { key: item.key ?? item.value },
      h(indicatorComponent, { isSelected }),
      h(itemComponent, { ...item, isSelected }));
  }));
};

// ── Screens ─────────────────────────────────────────────────────
const SCREEN = {
  SCOPE: 0,
  PRESET: 1,
  PREVIEW: 2,
  SCANNING: 3,
  GAME_PICK: 4,
  GAME_SOUNDS: 5,
  EXTRACTING: 6,
  CONFIRM: 7,
  INSTALLING: 8,
  DONE: 9,
};

const isUninstallMode = process.argv.includes("--uninstall") || process.argv.includes("--remove");

// ── Header component ────────────────────────────────────────────
const Header = () =>
  h(Box, { flexDirection: "column", marginBottom: 1 },
    h(Text, { bold: true, color: ACCENT }, "  klaudio"),
    h(Text, { dimColor: true }, isUninstallMode
      ? "  Remove sound effects from Claude Code"
      : "  Add sound effects to your Claude Code sessions"),
  );

const NavHint = ({ back = true, extra = "" }) =>
  h(Box, { marginTop: 1 },
    h(Text, { dimColor: true },
      (back ? "  esc back" : "") +
      (extra ? (back ? "  •  " : "  ") + extra : "")
    ),
  );

// ── Screen: Scope ───────────────────────────────────────────────
const ScopeScreen = ({ onNext }) => {
  const items = [
    { label: "Global (~/.claude)     — sounds in all projects", value: "global" },
    { label: "This project (.claude/) — project-specific", value: "project" },
  ];
  return h(Box, { flexDirection: "column" },
    h(Text, { bold: true }, "  Where should sounds be installed?"),
    h(Box, { marginLeft: 2 },
      h(SelectInput, { indicatorComponent: Indicator, itemComponent: Item, items, onSelect: (item) => onNext(item.value) }),
    ),
  );
};

// ── Screen: Preset ──────────────────────────────────────────────
const PresetScreen = ({ onNext, onBack }) => {
  useInput((_, key) => { if (key.escape) onBack(); });

  const items = [
    ...Object.entries(PRESETS).map(([id, p]) => ({
      label: `${p.icon} ${p.name}  — ${p.description}`,
      value: id,
    })),
    { label: "🕹️  Scan local games  — find sounds from your Steam & Epic Games library", value: "_scan" },
    { label: "📁 Custom files  — provide your own sound files", value: "_custom" },
  ];

  return h(Box, { flexDirection: "column" },
    h(Text, { bold: true }, "  Choose a sound preset:"),
    h(Box, { marginLeft: 2 },
      h(SelectInput, { indicatorComponent: Indicator, itemComponent: Item, items, onSelect: (item) => onNext(item.value) }),
    ),
    h(NavHint, { back: true }),
  );
};

// ── Screen: Preview ─────────────────────────────────────────────
const PreviewScreen = ({ presetId, sounds, onAccept, onBack, onUpdateSound }) => {
  const preset = PRESETS[presetId];
  const eventIds = Object.keys(EVENTS);
  const [currentEvent, setCurrentEvent] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [durations, setDurations] = useState({});
  const cancelRef = React.useRef(null);

  const eventId = eventIds[currentEvent];
  const eventInfo = EVENTS[eventId];
  const soundFile = sounds[eventId];

  const stopPlayback = useCallback(() => {
    if (cancelRef.current) { cancelRef.current(); cancelRef.current = null; }
    setPlaying(false);
    setElapsed(0);
  }, []);

  // Fetch durations for all sound files
  useEffect(() => {
    for (const [eid, path] of Object.entries(sounds)) {
      if (path && !durations[eid]) {
        getWavDuration(path).then((dur) => {
          if (dur != null) setDurations((d) => ({ ...d, [eid]: dur }));
        });
      }
    }
  }, [sounds]);

  // Auto-play when current event changes (with debounce)
  useEffect(() => {
    if (!soundFile) return;
    stopPlayback();
    const timer = setTimeout(() => {
      setPlaying(true);
      const { promise, cancel } = playSoundWithCancel(soundFile);
      cancelRef.current = cancel;
      promise.catch(() => {}).finally(() => {
        cancelRef.current = null;
        setPlaying(false);
        setElapsed(0);
      });
    }, 150);
    return () => {
      clearTimeout(timer);
      if (cancelRef.current) {
        cancelRef.current();
        cancelRef.current = null;
      }
    };
  }, [currentEvent]);

  useInput((_, key) => {
    if (key.escape) {
      if (playing) {
        stopPlayback();
      } else {
        onBack();
      }
    } else if (key.leftArrow || key.upArrow) {
      if (currentEvent > 0) {
        stopPlayback();
        setCurrentEvent((i) => i - 1);
      }
    } else if (key.rightArrow || key.downArrow) {
      if (currentEvent < eventIds.length - 1) {
        stopPlayback();
        setCurrentEvent((i) => i + 1);
      }
    } else if (key.return) {
      stopPlayback();
      onAccept(sounds);
    }
  });

  // Elapsed timer while playing
  useEffect(() => {
    if (!playing) return;
    setElapsed(0);
    const interval = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(interval);
  }, [playing]);

  const stepLabel = `(${currentEvent + 1}/${eventIds.length})`;
  const dur = durations[eventId];
  const durLabel = dur != null ? ` (${dur > MAX_PLAY_SECONDS ? MAX_PLAY_SECONDS : dur}s)` : "";

  return h(Box, { flexDirection: "column" },
    h(Text, { bold: true }, `  ${preset.icon} ${preset.name}`),
    h(Text, { dimColor: true }, `  ${preset.description}`),
    h(Box, { marginTop: 1, flexDirection: "column" },
      ...eventIds.map((eid, i) => {
        const d = durations[eid];
        const dStr = d != null ? ` (${d > MAX_PLAY_SECONDS ? MAX_PLAY_SECONDS : d}s)` : "";
        return h(Text, { key: eid, marginLeft: 2,
          color: i === currentEvent ? "#00FFFF" : i < currentEvent ? "green" : "white",
          bold: i === currentEvent,
        },
          i < currentEvent ? "  ✓ " : i === currentEvent ? "  ▸ " : "    ",
          `${EVENTS[eid].name}: `,
          sounds[eid] ? `${basename(sounds[eid])}${dStr}` : "(skipped)",
        );
      }),
    ),
    h(Box, { marginTop: 1, flexDirection: "column", borderStyle: "round", borderColor: playing ? "green" : "cyan", paddingX: 2, paddingY: 0, marginLeft: 2, marginRight: 2 },
      h(Text, { bold: true, color: playing ? "green" : "cyan" },
        `${eventInfo.name} ${stepLabel}`,
      ),
      h(Text, { dimColor: true },
        soundFile
          ? `Sound: ${basename(soundFile)}${durLabel}`
          : "No sound file selected",
      ),
      h(Text, { dimColor: true },
        `Triggers: ${eventInfo.description}`,
      ),
      playing
        ? h(Box, { marginTop: 1 },
            h(Text, { color: "green", bold: true }, h(Spinner, { type: "dots" })),
            h(Text, { color: "green", bold: true }, ` Now playing: ${basename(soundFile)}  ${elapsed}s / ${MAX_PLAY_SECONDS}s max`),
          )
        : null,
    ),
    h(NavHint, { back: true, extra: "↑↓ switch events  •  enter accept all" }),
  );
};

// ── Screen: Game Pick (with progressive background scanning) ────
const GamePickScreen = ({ onNext, onExtract, onBack }) => {
  const [games, setGames] = useState([]);
  const [scanning, setScanning] = useState(true);
  const [scanStatus, setScanStatus] = useState("Discovering game directories...");
  const [filter, setFilter] = useState("");

  // Start scanning on mount, add games progressively
  useEffect(() => {
    let cancelled = false;
    getAvailableGames(
      (progress) => {
        if (cancelled) return;
        if (progress.phase === "dirs") {
          setScanStatus(`Scanning ${progress.dirs.length} directories...`);
        } else if (progress.phase === "scanning") {
          setScanStatus(`Scanning: ${progress.game}`);
        }
      },
      (game) => {
        if (cancelled) return;
        // Add each game as it's found (only if it has audio or can extract)
        setGames((prev) => {
          if (prev.some((g) => g.name === game.name)) return prev;
          const next = [...prev, game];
          // Sort: playable first, then extractable, then others
          next.sort((a, b) => {
            if (a.hasAudio !== b.hasAudio) return a.hasAudio ? -1 : 1;
            if (a.canExtract !== b.canExtract) return a.canExtract ? -1 : 1;
            return a.name.localeCompare(b.name);
          });
          return next;
        });
      },
    ).then(() => {
      if (!cancelled) setScanning(false);
    }).catch(() => {
      if (!cancelled) setScanning(false);
    });
    return () => { cancelled = true; };
  }, []);

  useInput((input, key) => {
    if (key.escape) {
      if (filter) setFilter("");
      else onBack();
    } else if (key.backspace || key.delete) {
      setFilter((f) => f.slice(0, -1));
    } else if (input && !key.ctrl && !key.meta && input.length === 1 && input.charCodeAt(0) >= 32) {
      setFilter((f) => f + input);
    }
  });

  const usableGames = games.filter((g) => g.hasAudio || g.canExtract);
  const noAudio = games.filter((g) => !g.hasAudio && !g.canExtract);

  const allItems = usableGames
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((g) => {
      if (g.hasAudio) {
        return {
          key: `play:${g.name}`,
          label: `${g.name}  (${g.fileCount} audio files)`,
          value: `play:${g.name}`,
        };
      }
      const hasUnity = (g.unityAudioCount || 0) > 0;
      const hasPacked = (g.packedAudioCount || 0) > 0;
      const detail = hasUnity && !hasPacked
        ? `${g.unityAudioCount} Unity audio resource(s) — extract`
        : hasPacked && !hasUnity
          ? `${g.packedAudioCount} packed — extract with vgmstream`
          : `${g.packedAudioCount} packed + ${g.unityAudioCount} Unity — extract`;
      return {
        key: `extract:${g.name}`,
        label: `${g.name}  (${detail})`,
        value: `extract:${g.name}`,
      };
    });

  const filterLower = filter.toLowerCase();
  const items = filter
    ? allItems.filter((i) => i.label.toLowerCase().includes(filterLower))
    : allItems;

  return h(Box, { flexDirection: "column" },
    scanning
      ? h(Box, { marginLeft: 2 },
          h(Text, { color: ACCENT }, h(Spinner, { type: "dots" })),
          h(Text, null, ` ${scanStatus}`),
          games.length > 0
            ? h(Text, { color: "green" }, `  (${games.length} found)`)
            : null,
        )
      : h(Text, { bold: true, marginLeft: 2 },
          `  Found ${games.length} game(s):`,
        ),
    filter
      ? h(Box, { marginLeft: 4 },
          h(Text, { color: "yellow" }, "Filter: "),
          h(Text, { bold: true }, filter),
          h(Text, { dimColor: true }, ` (${items.length} match${items.length !== 1 ? "es" : ""})`),
        )
      : items.length > 0
        ? h(Text, { dimColor: true, marginLeft: 4 }, "Type to filter... (select a game while scan continues)")
        : null,
    items.length > 0
      ? h(Box, { marginLeft: 2 },
          h(SelectInput, { indicatorComponent: Indicator, itemComponent: Item,
            items,
            limit: 15,
            onSelect: (item) => {
              const [type, ...rest] = item.value.split(":");
              const name = rest.join(":");
              if (type === "extract") onExtract(name, games);
              else onNext(name, games);
            },
          }),
        )
      : !scanning
        ? h(Text, { color: "yellow", marginLeft: 4 }, "No games with usable audio found.")
        : null,
    noAudio.length > 0 && !filter && !scanning
      ? h(Box, { flexDirection: "column", marginTop: 1, marginLeft: 4 },
          h(Text, { dimColor: true },
            `${noAudio.length} game(s) with no extractable audio:`,
          ),
          h(Text, { dimColor: true },
            noAudio.map((g) => g.name).join(", "),
          ),
        )
      : null,
    h(NavHint, { back: true }),
  );
};

// ── Screen: Game Sound Picker ───────────────────────────────────
// Three-phase: category pick → file pick → preview/accept/repick
const CATEGORY_LABELS = {
  all: "All sounds", ambient: "Ambient", music: "Music", sfx: "SFX",
  ui: "UI", voice: "Voice / Dialogue", creature: "Creatures / Animals", other: "Other",
};
const CATEGORY_ICONS = {
  voice: "🗣", creature: "🐾", ui: "🖱", sfx: "💥",
  ambient: "🌿", music: "🎵", other: "📦", all: "📂",
};

const FileItem = ({ isSelected, label, usedTag }) =>
  h(Box, null,
    h(Text, { color: isSelected ? ACCENT : undefined, bold: isSelected }, label),
    usedTag ? h(Text, { dimColor: true }, usedTag) : null,
  );

const GameSoundsScreen = ({ game, sounds, onSelectSound, onDone, onBack }) => {
  const eventIds = Object.keys(EVENTS);
  const [currentEvent, setCurrentEvent] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [highlightedFile, setHighlightedFile] = useState(null);
  const [fileDurations, setFileDurations] = useState({});
  const [filter, setFilter] = useState("");
  const [activeCategory, setActiveCategory] = useState(null); // null = show category picker
  const [autoPreview, setAutoPreview] = useState(true);
  const [justSelected, setJustSelected] = useState(null); // brief confirmation flash
  const cancelRef = React.useRef(null);

  // Determine available categories with counts
  const hasCategories = game.files.some((f) => f.category);
  const { categories, counts } = hasCategories
    ? getCategories(game.files)
    : { categories: ["all"], counts: {} };
  const meaningfulCats = categories.filter((c) => c !== "all" && (counts[c] || 0) >= 2);
  const showCategoryPicker = meaningfulCats.length >= 2;

  // Sort files: voice first, then by priority
  const sortedFiles = hasCategories ? sortFilesByPriority(game.files) : game.files;

  // Filter files by category (no hard cap — SelectInput handles visible window)
  const categoryFiles = activeCategory && activeCategory !== "all"
    ? sortedFiles.filter((f) => f.category === activeCategory)
    : sortedFiles;

  // Stop current playback helper
  const stopPlayback = useCallback(() => {
    if (cancelRef.current) {
      cancelRef.current();
      cancelRef.current = null;
    }
    setPlaying(false);
    setElapsed(0);
  }, []);

  // Lazy-fetch duration for highlighted file
  useEffect(() => {
    if (highlightedFile && highlightedFile !== "_skip" && !fileDurations[highlightedFile]) {
      getWavDuration(highlightedFile).then((dur) => {
        if (dur != null) setFileDurations((d) => ({ ...d, [highlightedFile]: dur }));
      });
    }
  }, [highlightedFile]);

  // Auto-preview: play sound when highlighted file changes (with debounce)
  useEffect(() => {
    if (!autoPreview || !highlightedFile || highlightedFile === "_skip") {
      return;
    }
    // Cancel previous playback immediately
    if (cancelRef.current) {
      cancelRef.current();
      cancelRef.current = null;
    }
    setPlaying(false);
    setElapsed(0);
    // Debounce: wait 150ms before starting playback so scrubbing doesn't spam
    const timer = setTimeout(() => {
      setPlaying(true);
      setElapsed(0);
      const { promise, cancel } = playSoundWithCancel(highlightedFile);
      cancelRef.current = cancel;
      promise.catch(() => {}).finally(() => {
        cancelRef.current = null;
        setPlaying(false);
        setElapsed(0);
      });
    }, 150);
    return () => {
      clearTimeout(timer);
      if (cancelRef.current) {
        cancelRef.current();
        cancelRef.current = null;
      }
    };
  }, [highlightedFile, autoPreview]);

  useInput((input, key) => {
    if (key.tab) {
      // Tab cycles through events + Apply tab (if any sounds assigned)
      stopPlayback();
      const hasSounds = Object.values(sounds).some(Boolean);
      const tabCount = hasSounds ? eventIds.length + 1 : eventIds.length;
      setCurrentEvent((i) => (i + 1) % tabCount);
    } else if (key.escape) {
      if (playing) {
        stopPlayback();
      } else if (filter) {
        setFilter("");
      } else if (activeCategory !== null && showCategoryPicker) {
        stopPlayback();
        setActiveCategory(null);
      } else {
        stopPlayback();
        onBack();
      }
    } else if (input === "p" && !key.ctrl && !key.meta) {
      // Toggle auto-preview
      setAutoPreview((prev) => {
        if (prev) stopPlayback();
        return !prev;
      });
    } else if (activeCategory !== null) {
      if (key.backspace || key.delete) {
        setFilter((f) => f.slice(0, -1));
      } else if (input && input !== "p" && !key.ctrl && !key.meta && input.length === 1 && input.charCodeAt(0) >= 32) {
        setFilter((f) => f + input);
      }
    }
  });

  // Elapsed timer while playing
  useEffect(() => {
    if (!playing) return;
    setElapsed(0);
    const interval = setInterval(() => {
      setElapsed((e) => e + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [playing]);

  const eventId = eventIds[currentEvent];
  const eventInfo = EVENTS[eventId];
  const stepLabel = `(${currentEvent + 1}/${eventIds.length})`;

  const advance = useCallback((selectedFile, selectedEventId) => {
    stopPlayback();
    // Show confirmation flash
    if (selectedFile) {
      setJustSelected({ file: basename(selectedFile), event: EVENTS[selectedEventId]?.name || selectedEventId });
    }
    const doAdvance = () => {
      setJustSelected(null);
      // Move to next event that hasn't been assigned yet, or wrap around
      const nextUnassigned = eventIds.findIndex((eid, i) => i > currentEvent && !sounds[eid]);
      if (nextUnassigned >= 0) {
        setCurrentEvent(nextUnassigned);
      } else {
        // All done or wrapped — go to next sequential
        setCurrentEvent((i) => Math.min(i + 1, eventIds.length - 1));
      }
      setHighlightedFile(null);
      setActiveCategory(null);
      setFilter("");
    };
    if (selectedFile) {
      setTimeout(doAdvance, 600);
    } else {
      doAdvance();
    }
  }, [currentEvent, eventIds, sounds, stopPlayback]);

  const nowPlayingFile = playing && highlightedFile && highlightedFile !== "_skip"
    ? highlightedFile : null;

  const hasAnySounds = Object.values(sounds).some(Boolean);
  const allAssigned = eventIds.every((eid) => sounds[eid]);
  // currentEvent can be eventIds.length to mean "Done" tab
  const onDoneTab = currentEvent >= eventIds.length;

  const headerBox = h(Box, { marginLeft: 2, marginBottom: 1, flexDirection: "column", borderStyle: "round", borderColor: nowPlayingFile ? "green" : ACCENT, paddingX: 2 },
    h(Text, { bold: true, color: nowPlayingFile ? "green" : ACCENT },
      `${game.name}`,
    ),
    h(Box, { marginTop: 0, gap: 2, overflowX: "hidden" },
      ...eventIds.map((eid, i) => {
        const assigned = sounds[eid];
        const isCurrent = i === currentEvent;
        const truncName = assigned ? basename(assigned).slice(0, 20) : null;
        const prefix = isCurrent ? "▸" : assigned ? "✓" : "·";
        const label = truncName
          ? `${prefix} ${EVENTS[eid].name}: ${truncName}`
          : `${prefix} ${EVENTS[eid].name}`;
        return h(Text, {
          key: eid,
          bold: isCurrent,
          color: isCurrent ? ACCENT : assigned ? "green" : "gray",
        }, label);
      }),
      h(Text, {
        key: "_done",
        bold: onDoneTab,
        color: onDoneTab ? ACCENT : hasAnySounds ? "green" : "gray",
      }, onDoneTab ? "▸ ✓ Apply" : hasAnySounds ? "· ✓ Apply" : "· Apply"),
      h(Text, { dimColor: true }, "(tab)"),
    ),
    onDoneTab
      ? h(Text, { dimColor: true }, "Press enter to apply your sound selections")
      : sounds[eventId]
        ? h(Text, { color: "green" }, `✓ ${basename(sounds[eventId])}  —  ${eventInfo.description}`)
        : h(Text, { dimColor: true }, `${eventInfo.description}`),
  );

  const nowPlayingBar = h(Box, { marginLeft: 2, height: 1 },
    justSelected
      ? h(Text, { color: "green", bold: true }, `  ✓ Selected "${justSelected.file}" for ${justSelected.event}`)
      : nowPlayingFile
        ? h(Box, null,
            h(Text, { color: "green", bold: true }, h(Spinner, { type: "dots" })),
            h(Text, { color: "green", bold: true }, ` Now playing: ${basename(nowPlayingFile)}  ${elapsed}s / ${MAX_PLAY_SECONDS}s max`),
          )
        : h(Text, { dimColor: true }, " "),
  );

  // Apply tab: show summary and confirm
  if (onDoneTab) {
    const confirmItems = [
      { label: "✓ Apply sounds", value: "apply" },
      { label: "← Back to editing", value: "back" },
    ];
    return h(Box, { flexDirection: "column" },
      headerBox,
      h(Box, { flexDirection: "column", marginLeft: 4, marginBottom: 1 },
        ...eventIds.map((eid) =>
          h(Text, { key: eid, color: sounds[eid] ? "green" : "gray" },
            sounds[eid] ? `  ✓ ${EVENTS[eid].name}: ${basename(sounds[eid])}` : `  · ${EVENTS[eid].name}: (skipped)`,
          ),
        ),
      ),
      h(Box, { marginLeft: 2 },
        h(SelectInput, { indicatorComponent: Indicator, itemComponent: Item,
          items: confirmItems,
          onSelect: (item) => {
            if (item.value === "apply") {
              stopPlayback();
              onDone();
            } else {
              setCurrentEvent(0);
            }
          },
        }),
      ),
      nowPlayingBar,
      h(NavHint, { back: true }),
    );
  }

  // Phase 0: Category picker
  if (activeCategory === null && showCategoryPicker) {
    const catItems = [
      ...meaningfulCats.map((cat) => ({
        label: `${CATEGORY_ICONS[cat] || "📁"}  ${CATEGORY_LABELS[cat] || cat}  (${counts[cat]} sounds)`,
        value: cat,
      })),
      { label: `${CATEGORY_ICONS.all}  All sounds  (${game.files.length})`, value: "all" },
      { label: "(skip this event)", value: "_skip" },
    ];

    return h(Box, { flexDirection: "column" },
      headerBox,
      h(Text, { bold: true, marginLeft: 4 }, "Pick a category:"),
      h(Box, { marginLeft: 2 },
        h(SelectInput, { indicatorComponent: Indicator, itemComponent: Item,
          items: catItems,
          onSelect: (item) => {
            if (item.value === "_skip") {
              advance();
            } else {
              setActiveCategory(item.value);
            }
          },
        }),
      ),
      nowPlayingBar,
      h(NavHint, { back: true }),
    );
  }

  // Build a reverse map: filePath -> event name(s) it's assigned to
  const assignedToMap = {};
  for (const eid of eventIds) {
    if (sounds[eid]) {
      (assignedToMap[sounds[eid]] ||= []).push(EVENTS[eid].name);
    }
  }

  // Phase 1: Browse and pick files (auto-preview plays on highlight)
  const filterLower = filter.toLowerCase();
  const allFileItems = categoryFiles.map((f) => {
    const dur = fileDurations[f.path];
    const durStr = dur != null ? ` (${dur}s${dur > MAX_PLAY_SECONDS ? `, preview ${MAX_PLAY_SECONDS}s` : ""})` : "";
    const catTag = (!activeCategory || activeCategory === "all") && f.category && f.category !== "other"
      ? `[${(CATEGORY_LABELS[f.category] || f.category).toUpperCase()}] ` : "";
    const name = f.displayName || f.name;
    const usedFor = assignedToMap[f.path];
    return {
      label: `${catTag}${name}${durStr}`,
      usedTag: usedFor ? `  ← ${usedFor.join(", ")}` : null,
      value: f.path,
    };
  });

  const filteredFiles = filter
    ? allFileItems.filter((i) => i.label.toLowerCase().includes(filterLower))
    : allFileItems;

  const fileItems = [
    ...filteredFiles,
    ...(!filter ? [{ label: "(skip this event)", value: "_skip" }] : []),
  ];

  const catLabel = activeCategory && activeCategory !== "all"
    ? `${CATEGORY_ICONS[activeCategory] || ""} ${CATEGORY_LABELS[activeCategory] || activeCategory}`
    : null;

  return h(Box, { flexDirection: "column" },
    headerBox,
    catLabel
      ? h(Text, { bold: true, color: ACCENT, marginLeft: 4 }, catLabel)
      : null,
    h(Box, { marginLeft: 4 },
      h(Text, { color: autoPreview ? "green" : "gray", bold: autoPreview },
        autoPreview ? "♫ Auto-preview ON" : "♫ Auto-preview OFF"
      ),
      h(Text, { dimColor: true }, "  (p to toggle)"),
    ),
    filter
      ? h(Box, { marginLeft: 4 },
          h(Text, { color: "yellow" }, "Filter: "),
          h(Text, { bold: true }, filter),
          h(Text, { dimColor: true }, ` (${filteredFiles.length} match${filteredFiles.length !== 1 ? "es" : ""})`),
        )
      : categoryFiles.length > 15
        ? h(Text, { dimColor: true, marginLeft: 4 }, "Type to filter...")
        : null,
    fileItems.length > 0
      ? h(Box, { marginLeft: 2 },
          h(SelectInput, { indicatorComponent: Indicator, itemComponent: FileItem,
            items: fileItems,
            limit: 15,
            onHighlight: (item) => {
              setHighlightedFile(item.value);
            },
            onSelect: (item) => {
              stopPlayback();
              if (item.value === "_skip") {
                advance(null, null);
              } else {
                onSelectSound(eventId, item.value);
                advance(item.value, eventId);
              }
            },
          }),
        )
      : h(Text, { color: "yellow", marginLeft: 4 }, "No matches."),
    nowPlayingBar,
    h(NavHint, { back: true, extra: "tab switch event" }),
  );
};

// ── Screen: Extracting ──────────────────────────────────────────
const ExtractingScreen = ({ game, onDone, onBack }) => {
  const [status, setStatus] = useState("Checking cache...");
  const [extracted, setExtracted] = useState(0);

  useInput((_, key) => { if (key.escape) onBack(); });

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        // Check cache first
        const cached = await getCachedExtraction(game.name);
        if (cached && cached.files.length > 0) {
          setStatus(`Found ${cached.files.length} cached sounds`);
          if (!cancelled) {
            onDone({
              files: cached.files.map((f) => ({
                path: f.path,
                name: f.name,
                displayName: f.displayName,
                category: f.category,
                dir: dirname(f.path),
              })),
              categories: cached.categories,
              fromCache: true,
            });
          }
          return;
        }

        const outputDir = join(tmpdir(), "klaudio-extract", game.name.replace(/[^a-zA-Z0-9]/g, "_"));
        const allOutputs = [];

        // Unity .resource files — extract FSB5 banks directly (no vgmstream needed for PCM16)
        const fsbFiles = []; // Vorbis .fsb files that need vgmstream conversion
        if (game.unityResources && game.unityResources.length > 0) {
          setStatus(`Extracting Unity audio from ${game.unityResources.length} resource file(s)...`);
          for (const resPath of game.unityResources) {
            if (cancelled) return;
            setStatus(`Extracting: ${basename(resPath)}`);
            try {
              const extracted = await extractUnityResource(resPath, outputDir);
              for (const f of extracted) {
                if (f.path.endsWith(".wav")) {
                  allOutputs.push(f.path);
                } else if (f.path.endsWith(".fsb")) {
                  fsbFiles.push({ path: f.path, name: f.name });
                }
              }
              setExtracted(allOutputs.length);
            } catch { /* skip */ }
          }
        }

        // Scan for packed audio files (Wwise/FMOD/BUN)
        let packedFiles = [];
        if (allOutputs.length === 0 || !game.unityResources?.length) {
          setStatus(`Scanning ${game.name} for packed audio...`);
          packedFiles = await findPackedAudioFiles(game.path, 30);
        }

        // Extract BUN files natively (SCUMM engine audio)
        const bunFiles = packedFiles.filter((f) => f.name.toLowerCase().endsWith(".bun"));
        const nonBunFiles = packedFiles.filter((f) => !f.name.toLowerCase().endsWith(".bun"));

        for (const file of bunFiles) {
          if (cancelled) return;
          setStatus(`Extracting SCUMM audio: ${file.name}`);
          try {
            const bunOutputs = await extractBunFile(file.path, outputDir, (msg) => {
              if (!cancelled) setStatus(msg);
            });
            allOutputs.push(...bunOutputs);
            setExtracted(allOutputs.length);
          } catch { /* skip */ }
        }

        // Convert extracted .fsb Vorbis files via vgmstream, or handle non-BUN packed audio
        const needsVgmstream = fsbFiles.length > 0 || nonBunFiles.length > 0;
        if (needsVgmstream) {
          // Get vgmstream-cli (downloads if needed)
          setStatus("Getting vgmstream-cli...");
          const vgmstream = await getVgmstreamPath((msg) => {
            if (!cancelled) setStatus(msg);
          });

          // Convert Unity-extracted .fsb files
          for (const fsb of fsbFiles) {
            if (cancelled) return;
            setStatus(`Converting: ${fsb.name}`);
            try {
              const outputs = await extractToWav(fsb.path, outputDir, vgmstream);
              allOutputs.push(...outputs);
              setExtracted(allOutputs.length);
            } catch { /* skip */ }
          }

          // Convert non-BUN packed audio via vgmstream
          for (const file of nonBunFiles) {
            if (cancelled) return;
            setStatus(`Extracting: ${file.name}`);
            try {
              const outputs = await extractToWav(file.path, outputDir, vgmstream);
              allOutputs.push(...outputs);
              setExtracted(allOutputs.length);
            } catch { /* skip */ }
          }
        }

        if (allOutputs.length === 0 && fsbFiles.length === 0 && packedFiles.length === 0) {
          if (!cancelled) onDone({ files: [], error: "No extractable audio files found" });
          return;
        }

        if (!cancelled) {
          // Cache the results with category metadata
          const rawFiles = allOutputs.map((p) => ({ path: p, name: basename(p) }));
          setStatus("Caching extracted sounds...");
          const manifest = await cacheExtraction(game.name, rawFiles, game.path);

          onDone({
            files: manifest.files.map((f) => ({
              path: f.path,
              name: f.name,
              displayName: f.displayName,
              category: f.category,
              dir: dirname(f.path),
            })),
            categories: manifest.categories,
          });
        }
      } catch (err) {
        if (!cancelled) onDone({ files: [], error: err.message });
      }
    })();

    return () => { cancelled = true; };
  }, []);

  return h(Box, { flexDirection: "column" },
    h(Box, { marginLeft: 2, flexDirection: "column", borderStyle: "round", borderColor: ACCENT, paddingX: 2 },
      h(Text, { bold: true, color: ACCENT }, `Extracting audio from ${game.name}`),
      h(Box, { marginTop: 1 },
        h(Text, { color: ACCENT }, h(Spinner, { type: "dots" })),
        h(Text, null, ` ${status}`),
      ),
      extracted > 0
        ? h(Text, { color: "green" }, `  ${extracted} sound(s) extracted so far`)
        : null,
    ),
    h(NavHint, { back: true }),
  );
};

// ── Screen: Confirm ─────────────────────────────────────────────
const ConfirmScreen = ({ scope, sounds, onConfirm, onBack }) => {
  useInput((_, key) => { if (key.escape) onBack(); });

  const items = [
    { label: "✓  Yes, install!", value: "yes" },
    { label: "✗  No, go back", value: "no" },
  ];

  const soundEntries = Object.entries(sounds).filter(([_, path]) => path);

  return h(Box, { flexDirection: "column" },
    h(Text, { bold: true, marginLeft: 2 }, "  Ready to install:"),
    h(Box, { marginTop: 1, flexDirection: "column" },
      h(Text, { marginLeft: 4 }, `Scope: ${scope === "global" ? "Global (~/.claude)" : "This project (.claude/)"}`),
      ...soundEntries.map(([eid, path]) =>
        h(Text, { key: eid, marginLeft: 4 },
          `${EVENTS[eid].name} → ${basename(path)}`
        )
      ),
    ),
    h(Box, { marginTop: 1, marginLeft: 2 },
      h(SelectInput, { indicatorComponent: Indicator, itemComponent: Item, items, onSelect: (item) => {
        if (item.value === "yes") onConfirm();
        else onBack();
      }}),
    ),
    h(NavHint, { back: true }),
  );
};

// ── Screen: Installing ──────────────────────────────────────────
const InstallingScreen = ({ scope, sounds, onDone }) => {
  useEffect(() => {
    const validSounds = {};
    for (const [eventId, path] of Object.entries(sounds)) {
      if (path) validSounds[eventId] = path;
    }
    install({ scope, sounds: validSounds }).then(onDone).catch((err) => {
      onDone({ error: err.message });
    });
  }, []);

  return h(Box, { marginLeft: 2 },
    h(Text, { color: ACCENT }, h(Spinner, { type: "dots" })),
    h(Text, null, " Installing sounds..."),
  );
};

// ── Screen: Done ────────────────────────────────────────────────
const DoneScreen = ({ result }) => {
  const { exit } = useApp();

  useEffect(() => {
    // Play the "stop" sound as a demo if it was installed
    if (result.installedSounds?.stop) {
      playSoundWithCancel(result.installedSounds.stop).promise.catch(() => {});
    }
    const timer = setTimeout(() => exit(), 1500);
    return () => clearTimeout(timer);
  }, []);

  if (result.error) {
    return h(Box, { flexDirection: "column", marginLeft: 2 },
      h(Text, { color: "red", bold: true }, "  ✗ Installation failed:"),
      h(Text, { color: "red" }, `    ${result.error}`),
    );
  }

  return h(Box, { flexDirection: "column", marginLeft: 2 },
    h(Text, { color: "green", bold: true }, "  ✓ Sounds installed!"),
    h(Box, { marginTop: 1, flexDirection: "column" },
      h(Text, null, `  Sound files: ${result.soundsDir}`),
      h(Text, null, `  Config: ${result.settingsFile}`),
    ),
    h(Box, { marginTop: 1, flexDirection: "column" },
      h(Text, null, "  Your Claude Code sessions will now play sounds for:"),
      ...Object.keys(result.installedSounds).map((eventId) =>
        h(Text, { key: eventId, color: "green" }, `    • ${EVENTS[eventId].name}`)
      ),
    ),
    h(Box, { marginTop: 1 },
      h(Text, { dimColor: true }, "  To remove: npx klaudio --uninstall"),
    ),
  );
};

// ── Uninstall App ───────────────────────────────────────────────
const UninstallApp = () => {
  const { exit } = useApp();
  const [phase, setPhase] = useState("scope"); // scope | working | done | notfound
  const [scope, setScope] = useState(null);

  useEffect(() => {
    if (phase === "working" && scope) {
      uninstall(scope).then((ok) => {
        setPhase(ok ? "done" : "notfound");
        setTimeout(() => exit(), 500);
      });
    }
  }, [phase, scope]);

  if (phase === "scope") {
    return h(Box, { flexDirection: "column" },
      h(Header, null),
      h(ScopeScreen, {
        onNext: (s) => { setScope(s); setPhase("working"); },
      }),
    );
  }

  if (phase === "working") {
    return h(Box, { flexDirection: "column" },
      h(Header, null),
      h(Box, { marginLeft: 2 },
        h(Text, { color: ACCENT }, h(Spinner, { type: "dots" })),
        h(Text, null, " Removing sounds..."),
      ),
    );
  }

  if (phase === "done") {
    return h(Box, { flexDirection: "column" },
      h(Header, null),
      h(Text, { color: "green", marginLeft: 2 }, "  ✓ Klaudio hooks removed."),
    );
  }

  return h(Box, { flexDirection: "column" },
    h(Header, null),
    h(Text, { color: "yellow", marginLeft: 2 }, "  No Klaudio configuration found."),
  );
};

// ── Main Install App ────────────────────────────────────────────
const InstallApp = () => {
  const [screen, setScreen] = useState(SCREEN.SCOPE);
  const [scope, setScope] = useState(null);
  const [presetId, setPresetId] = useState(null);
  const [sounds, setSounds] = useState({});
  const [selectedGame, setSelectedGame] = useState(null);
  const [installResult, setInstallResult] = useState(null);

  const initSoundsFromPreset = useCallback((pid) => {
    const preset = PRESETS[pid];
    if (preset) setSounds({ ...preset.sounds });
  }, []);

  const content = (() => {
    switch (screen) {
      case SCREEN.SCOPE:
        return h(ScopeScreen, {
          onNext: (s) => {
            setScope(s);
            getExistingSounds(s).then((existing) => {
              if (Object.keys(existing).length > 0) setSounds(existing);
            });
            setScreen(SCREEN.PRESET);
          },
        });

      case SCREEN.PRESET:
        return h(PresetScreen, {
          onNext: (id) => {
            if (id === "_scan") {
              setScreen(SCREEN.GAME_PICK);
            } else if (id === "_custom") {
              const firstPreset = Object.keys(PRESETS)[0];
              setPresetId(firstPreset);
              initSoundsFromPreset(firstPreset);
              setScreen(SCREEN.PREVIEW);
            } else {
              setPresetId(id);
              initSoundsFromPreset(id);
              setScreen(SCREEN.PREVIEW);
            }
          },
          onBack: () => setScreen(SCREEN.SCOPE),
        });

      case SCREEN.PREVIEW:
        return h(PreviewScreen, {
          presetId,
          sounds,
          onAccept: (finalSounds) => {
            setSounds(finalSounds);
            setScreen(SCREEN.CONFIRM);
          },
          onBack: () => setScreen(SCREEN.PRESET),
          onUpdateSound: (eventId, path) => {
            setSounds((prev) => {
              const next = { ...prev };
              if (path === null) delete next[eventId];
              else next[eventId] = path;
              return next;
            });
          },
        });

      case SCREEN.GAME_PICK:
        return h(GamePickScreen, {
          onNext: (gameName, gamesList) => {
            const game = gamesList.find((g) => g.name === gameName);
            const catFiles = categorizeLooseFiles(game.files);
            setSelectedGame({ ...game, files: catFiles });
            setScreen(SCREEN.GAME_SOUNDS);
          },
          onExtract: (gameName, gamesList) => {
            const game = gamesList.find((g) => g.name === gameName);
            setSelectedGame(game);
            setScreen(SCREEN.EXTRACTING);
          },
          onBack: () => setScreen(SCREEN.PRESET),
        });

      case SCREEN.GAME_SOUNDS:
        return h(GameSoundsScreen, {
          game: selectedGame,
          sounds,
          onSelectSound: (eventId, path) => {
            setSounds((prev) => ({ ...prev, [eventId]: path }));
          },
          onDone: () => {
            setScreen(SCREEN.CONFIRM);
          },
          onBack: () => setScreen(SCREEN.GAME_PICK),
        });

      case SCREEN.EXTRACTING:
        return h(ExtractingScreen, {
          game: selectedGame,
          onDone: (result) => {
            if (result.error || result.files.length === 0) {
              // Go back to game pick — extraction failed
              setScreen(SCREEN.GAME_PICK);
            } else {
              // Update the selected game with extracted files and go to sound picker
              setSelectedGame({
                ...selectedGame,
                files: result.files,
                fileCount: result.files.length,
                hasAudio: true,
              });
              setScreen(SCREEN.GAME_SOUNDS);
            }
          },
          onBack: () => setScreen(SCREEN.GAME_PICK),
        });

      case SCREEN.CONFIRM:
        return h(ConfirmScreen, {
          scope,
          sounds,
          onConfirm: () => setScreen(SCREEN.INSTALLING),
          onBack: () => {
            if (selectedGame) setScreen(SCREEN.GAME_SOUNDS);
            else setScreen(SCREEN.PREVIEW);
          },
        });

      case SCREEN.INSTALLING:
        return h(InstallingScreen, {
          scope,
          sounds,
          onDone: (result) => {
            setInstallResult(result);
            setScreen(SCREEN.DONE);
          },
        });

      case SCREEN.DONE:
        return h(DoneScreen, { result: installResult });

      default:
        return h(Text, { color: "red" }, "Unknown screen");
    }
  })();

  return h(Box, { flexDirection: "column" },
    h(Header, null),
    content,
  );
};

// ── Entry ───────────────────────────────────────────────────────
export async function run() {
  const AppComponent = isUninstallMode ? UninstallApp : InstallApp;
  const instance = render(h(AppComponent));
  await instance.waitUntilExit();
}
