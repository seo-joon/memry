# Memry

A lightweight, single-user note-taking app (macOS first) with an AI meeting/lecture
helper. Write markdown with **Obsidian-style live preview** (LaTeX, images, and
`[[wikilinks]]` render in place), record a meeting, and the transcript is dropped
straight into your note.

Built with **Electron + electron-vite + vanilla TypeScript** (no React). Notes are plain
`.md` files in a vault folder (`~/Documents/Memry` by default), organized into folders.

## Setup

```bash
npm install
# If you see "Error: Electron uninstall" on first run, the Electron binary download
# was skipped during install — fetch it once:
node node_modules/electron/install.js

cp .env.example .env   # then add your key (optional — app runs in stub mode without it)
```

`.env` keys (optional for v1):
- `OPENAI_API_KEY` — cloud transcription (Whisper). Blank → transcript shows a stub.

In the packaged app there is no `.env` file. Open Settings (sliders button,
top right) and paste your keys there instead. They stay on that Mac, encrypted
with the login Keychain.

## Run

```bash
npm run dev        # launch with hot reload
npm run typecheck  # type-check main + renderer
npm run build      # production bundle into out/
npm run package    # build a .dmg (electron-builder)
```

## Features

- **Live-preview markdown editor** (CodeMirror 6): headings, bold/italic, inline code,
  KaTeX LaTeX (`$…$`, `$$…$$`), images, links, and `[[wikilinks]]` render inline. The raw
  markdown for a construct reappears when your cursor enters it (like Obsidian). Click a
  wikilink to open/create that note.
- **Folder tree sidebar** (Obsidian-style): nested folders + flat notes. Create notes and
  folders, double-click a name to rename, drag-drop to move, right-click for a menu.
- **Quick Notes** live in their own `Quick Notes/` folder.
- **Meeting/lecture transcription**: pick a listening mode — **microphone**, **system
  audio**, or **recording device** — then Start. Audio is chunked every 15s and transcribed
  live; on Stop the transcript is appended to the open note. Soft 2-hour cap.
- **Sticky notes**: press **⌘⇧Space** anywhere to pop the quick-capture overlay. **⌘↵**
  files the thought to `Quick Notes/`; **⌘⇧↵** (or "Keep as sticky") pins it as a persistent,
  resizable floating sticky instead. Stickies survive relaunch; "+" spawns another, "×" closes.

## Notes on macOS permissions

- **Microphone**: prompted on first record.
- **System audio**: needs **Screen Recording** permission (System Settings → Privacy &
  Security → Screen Recording), then a relaunch. BlackHole or a similar loopback device
  also works as a microphone-mode input.

## Architecture

```
src/
  shared/ipc.ts     # the single IPC contract (channels + types + window.api shape)
  main/             # app lifecycle, windows, vault file I/O, global shortcut, stickies,
    services/       #   transcription (Whisper), transcript buffer
  preload/          # contextBridge: builds window.api from the contract
  renderer/         # editor + live preview, file-tree sidebar, recorder, transcription UI,
    editor/         #   editor + livepreview engine + wikilink helper
                    #   plus the overlay (quick capture) and sticky windows
```

API keys live only in the main process. See `BLUEPRINT.md` for the original design.

## Known v1 limitations

- No auth, minimal input sanitization, no AI-usage guardrails (it's a personal app).
- Transcription degrades to a stub (never crashes) when the key is absent or a call fails.
- Live preview covers the common constructs (headings, bold/italic, code, links, images,
  math, wikilinks); design polish and an inline tab-to-accept suggestion UX for transcripts
  are future work.
