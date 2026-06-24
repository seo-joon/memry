# Memry — Build Blueprint

A small, DRY, single-user macOS note-taking app: Electron + Vite + vanilla TypeScript (no React), Obsidian-style markdown vault, live KaTeX, `[[wikilinks]]`, AI meeting/lecture transcription with a Claude-powered merge shown in a toggleable VSCode-style diff, and a global-shortcut sticky-note overlay.

---

## 0. Conflict resolution (decisions baked into this blueprint)

These were the disagreements across the 5 research inputs; resolved once here so the rest of the doc is internally consistent.

| Topic | Inputs disagreed | Decision & why |
|---|---|---|
| Electron version | `^33` (audio layer) vs `^31` (shell) | **`electron@^33.0.0`**. The audio layer is the binding constraint: v33 has the official `audio:'loopback'` enum but a flaky Chromium loopback path, so we use the `electron-audio-loopback` shim. Drop the shim only if upgrading to 39+. |
| electron-builder | `^25` vs `^24.13` | **`^25.0.0`** — newer, `hardenedRuntime` defaults true. |
| Build tooling | electron-vite vs hand-rolled | **electron-vite `^2.3`** — one `electron.vite.config.ts` for all 3 targets, HMR, two HTML entries from one renderer build. |
| Main-process language | `.js` CommonJS (transcription) vs `.ts` ESM | **TypeScript everywhere.** Transcription/merge services are rewritten as `.ts`, compiled by electron-vite. |
| IPC channel names | three different schemes | **One contract in `src/shared/ipc.ts`** (see §3). Transcription/merge channels reconciled below. |
| What crosses transcription IPC | text (shell input) vs audio ArrayBuffer (transcription input) | **Audio ArrayBuffer crosses renderer→main; transcript text streams main→renderer.** Keys live in main, so main must do the Whisper call. Finding-5's "pushChunk(text)" shape is corrected to "pushChunk(arrayBuffer)". |
| Chunking | timeslice vs stop/restart | **Stop/restart the recorder every N seconds** so each blob is a self-contained webm file. Both inputs flag that timeslice fragments after the first are headerless and Whisper rejects them. This is the single biggest correctness pitfall. |
| Markdown live preview | in-editor decorations (b) vs split preview pane (a) | **Split editor + preview pane (a)** for v1. ~60 lines vs 300+; reuses markdown-it pipeline for graph/read-only later. |
| Merge model | Haiku default | **`claude-haiku-4-5`** default via `MEMRY_MERGE_MODEL`; no `thinking`/`effort` on Haiku. Override to Sonnet/Opus by env. |
| Screen-recording permission | "required + relaunch" vs "Sonoma+ uses CoreAudio Tap" | Keep `NSScreenCaptureUsageDescription` + the relaunch/`getMediaAccessStatus('screen')` UX, since on Electron 33 we explicitly take the `getDisplayMedia` loopback path. Documented as "system mode only". |

---

## 1. High-level architecture

Three processes, two windows, one vault folder.

- **Main process** (`src/main/`): app lifecycle, both `BrowserWindow`s, the global shortcut, ALL disk I/O (`vault.ts`), and ALL secret-bearing network calls (Whisper transcription, Claude merge). `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` are read here only.
- **Preload** (`src/preload/index.ts`): thin typed `contextBridge` surface built from the `CH` constants. `contextIsolation:true`, `nodeIntegration:false`. Same preload for both windows.
- **Renderer** (`src/renderer/`): two HTML entry points (`index.html` editor, `overlay.html` sticky-note) sharing modules. Owns the CodeMirror editor, markdown preview, the `Recorder` (Web Audio / `MediaRecorder` lives only here — main has no audio API), and the merge-diff UI.
- **Shared** (`src/shared/ipc.ts`): the one IPC contract (channel names + types), imported by all three.
- **Vault**: a folder of `.md` files (default `~/Documents/Memry`, overridable). A "quick note" from the overlay is just a timestamped `.md` in the same folder — no separate store.

Data flow for transcription (system or mic):
```
Renderer Recorder --(N-sec self-contained webm blob)--> ipcRenderer.send(transChunk, sessionId, arrayBuffer, mimeType)
Main transcript-buffer.appendChunk -> transcription.transcribe (Whisper REST) -> append to per-session text
Main --(webContents.send transAppend {sessionId, delta})--> Renderer live transcript pane
... on stop: renderer invoke(transStop) -> final transcript -> invoke(mergeRequest, noteId, transcript)
Main merge.mergeNotes (Claude) -> {merged, suggestions} -> Renderer MergeDiffView (unifiedMergeView)
```

---

## 2. Pinned dependency set (conflict-free)

Node 20+ assumed (dev machine confirmed Node v22) so global `fetch`/`FormData`/`Blob` are used in main — no axios/node-fetch/form-data/openai-sdk.

### runtime deps
```
electron-audio-loopback   ^1.0.0     # Chromium loopback switches + getLoopbackAudioMediaStream() (drop on Electron 39+)
dotenv                    ^16.4.7    # load API keys in MAIN at startup
@anthropic-ai/sdk         ^0.74.0    # Claude merge (MAIN only)
codemirror                ^6.0.2     # CM6 meta-package (state/view/commands/language/...)
@codemirror/lang-markdown ^6.5.0     # markdown highlighting for editor + diff
@codemirror/merge         ^6.12.1    # unifiedMergeView for the accept/reject diff
@codemirror/view          ^6.26.0    # explicit for clean keymap/EditorView imports
@codemirror/state         ^6.6.0     # explicit for Compartment/Transaction imports
@codemirror/commands      ^6.10.3    # history + default keymap (undo/redo)
markdown-it               ^14.2.0    # markdown -> HTML preview
@vscode/markdown-it-katex ^1.1.2     # maintained KaTeX plugin ($...$ / $$...$$); NOT the abandoned markdown-it-katex
katex                     ^0.16.47   # math engine + katex.min.css
```

### dev deps
```
electron                  ^33.0.0    # runtime; v33 has audio:'loopback' enum (shim covers the flaky Chromium path)
electron-vite             ^2.3.0     # single-config build (main/preload/renderer), HMR, two HTML entries
vite                      ^5.4.0     # peer bundler/dev server
electron-builder          ^25.0.0    # dmg packaging, signing, notarize, entitlements + Info.plist injection
typescript                ^5.4.0     # vanilla TS across all three processes
@types/node               ^20.0.0    # fs/path typings for main+preload
@types/markdown-it        ^14.1.0    # markdown-it ships no types
@types/katex              ^0.16.7    # katex types
```

> **CM6 dedupe note:** because we import from both `codemirror` and scoped `@codemirror/*`, npm must dedupe to ONE copy of `@codemirror/state`/`view`. The `^6.x` ranges above are mutually compatible; if dev sees "Calls to EditorState from different module instances", run `npm dedupe`.

---

## 3. THE IPC CONTRACT (single source of truth) — `src/shared/ipc.ts`

Defined ONCE. Preload builds the bridge from it; main registers handlers from it; renderer imports the `Api` type. Adding a channel = one line here + one line in preload + one handler in main.

```ts
// src/shared/ipc.ts
export const CH = {
  // --- vault / notes (invoke = request/response) ---
  noteList:     'note:list',      // () => NoteMeta[]
  noteRead:     'note:read',      // (id: string) => string
  noteCreate:   'note:create',    // (CreateNote) => NoteMeta
  noteUpdate:   'note:update',    // (id: string, md: string) => void
  noteDelete:   'note:delete',    // (id: string) => void
  vaultPath:    'vault:path',     // () => string
  vaultPick:    'vault:pick',     // () => string | null   (folder dialog)
  vaultAsset:   'vault:asset',    // (relPath) => string   (resolve for memry:// — optional helper)

  // --- transcription (control plane = invoke; audio stream = send) ---
  transStart:   'trans:start',    // (noteId: string) => SessionId
  transChunk:   'trans:chunk',    // (SessionId, arrayBuffer, mimeType) -> void   RENDERER->MAIN, fire-and-forget
  transAppend:  'trans:append',   // MAIN->RENDERER push: { sessionId, delta }
  transStop:    'trans:stop',     // (SessionId) => string  (final accumulated transcript)

  // --- AI merge ---
  mergeRequest: 'merge:request',  // (noteId: string, transcript: string) => MergeResult

  // --- audio permissions / capability gating ---
  micEnsure:    'audio:micEnsure',   // () => boolean  (prompt mic if not-determined)
  screenStatus: 'audio:screenStatus',// () => MediaAccessStatus  (read-only)
  screenOpen:   'audio:screenOpen',  // () => void  (deep-link System Settings > Screen Recording)

  // --- overlay sticky note ---
  overlaySave:   'overlay:save',  // (text: string) => NoteMeta  (quick note -> vault, then hide)
  overlayToggle: 'overlay:toggle' // () => void  (renderer-driven hide; shortcut also toggles in main)
} as const

export interface NoteMeta { id: string; title: string; mtime: number; quick: boolean }
export interface CreateNote { title?: string; body?: string; quick?: boolean }
export type SessionId = string
export type MediaAccessStatus = 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown'
export interface MergeResult { merged: string; suggestions: string[]; stub?: boolean }

// The exact shape preload exposes as window.api — derived ONCE, reused everywhere.
export interface Api {
  notes: {
    list(): Promise<NoteMeta[]>
    read(id: string): Promise<string>
    create(n: CreateNote): Promise<NoteMeta>
    update(id: string, md: string): Promise<void>
    delete(id: string): Promise<void>
  }
  vault: { path(): Promise<string>; pick(): Promise<string | null>; asset(rel: string): Promise<string> }
  transcription: {
    start(noteId: string): Promise<SessionId>
    pushChunk(s: SessionId, audio: ArrayBuffer, mimeType: string): void  // fire-and-forget audio
    onAppend(cb: (p: { sessionId: SessionId; delta: string }) => void): () => void  // subscribe; returns unsubscribe
    stop(s: SessionId): Promise<string>
  }
  merge(noteId: string, transcript: string): Promise<MergeResult>
  audio: { ensureMic(): Promise<boolean>; screenStatus(): Promise<MediaAccessStatus>; openScreenSettings(): void }
  overlay: { save(text: string): Promise<NoteMeta>; toggle(): void }
}
```

**Contract rules:**
- Secrets (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) never appear in any channel payload or in `Api`. They live in main process module scope only.
- `transChunk` is `ipcRenderer.send` (audio is fire-and-forget; do not await every chunk). Everything else `invoke`.
- `transAppend` is the only main→renderer push; renderer subscribes via `transcription.onAppend(cb)` which wraps `ipcRenderer.on` and returns an unsubscribe to prevent listener leaks across sessions.

---

## 4. Complete directory / file tree (one line per file)

```
memry/
├─ package.json                         # scripts + electron-builder mac/dmg block (§6, §7)
├─ electron.vite.config.ts              # one config, 3 targets; renderer input map = editor.html + overlay.html
├─ tsconfig.json                        # references node + web tsconfigs
├─ tsconfig.node.json                   # main + preload scope (CommonJS/ESNext, @types/node, NO dom)
├─ tsconfig.web.json                    # renderer scope (DOM lib, no node types)
├─ .env                                 # OPENAI_API_KEY, ANTHROPIC_API_KEY, MEMRY_MERGE_MODEL (gitignored)
├─ .env.example                         # documents the three vars, no values
├─ .gitignore                           # node_modules, out, dist, .env, .DS_Store
├─ CLAUDE.md                            # (existing) behavioral guidelines
├─ build/
│  ├─ entitlements.mac.plist            # hardened-runtime entitlements (jit, audio-input, microphone, lib-validation)
│  └─ icon.icns                         # app icon for dmg
├─ src/
│  ├─ shared/
│  │  └─ ipc.ts                         # THE IPC contract: CH constants + all types + Api (§3)
│  ├─ main/
│  │  ├─ index.ts                       # app lifecycle: loopback init -> whenReady -> windows + ipc + shortcut; will-quit cleanup
│  │  ├─ loopback-setup.ts              # electron-audio-loopback initMain() BEFORE app ready (sets Chromium switches)
│  │  ├─ protocol.ts                    # register+handle memry:// privileged scheme to serve vault images under contextIsolation
│  │  ├─ windows.ts                     # createEditor() + createOverlay() + registerOverlayToggle() (global shortcut)
│  │  ├─ vault.ts                       # ALL disk I/O: list/read/create/update/del + quick(); quick note = timestamped .md
│  │  ├─ ipc.ts                         # registers every handler from CH; routes to vault / transcription / merge
│  │  ├─ audio-permissions.ts           # ensureMicAccess(), screenAccessStatus(), openScreenRecordingSettings()
│  │  └─ services/
│  │     ├─ transcription.ts            # transcribe(buffer, mimeType) -> Promise<string>; Whisper REST; graceful stub; never throws
│  │     ├─ transcript-buffer.ts        # per-session Map accumulator + soft 2h cap; appendChunk/getTranscript/endSession
│  │     └─ merge.ts                    # mergeNotes(notes, transcript) -> MergeResult; Claude via SDK; structured output; stub fallback
│  ├─ preload/
│  │  └─ index.ts                       # contextBridge 'api' built from CH (§3); also exposes onAppend subscribe wrapper
│  └─ renderer/
│     ├─ index.html                     # editor window entry; <div id=editor> + <div id=preview> + sidebar + transcript pane
│     ├─ overlay.html                   # sticky-note entry; <textarea> + save; transparent/frameless body
│     ├─ editor-main.ts                 # editor window bootstrap: vault sidebar, mountWorkspace, recorder controls, merge launch
│     ├─ overlay-main.ts                # overlay bootstrap: focus textarea, Cmd+Enter -> overlay.save, Esc -> overlay.toggle
│     ├─ global.d.ts                    # declare global { interface Window { api: Api } } from shared/ipc
│     ├─ style.css                      # app + overlay styles; imports katex CSS path note (CSS imported in preview.ts)
│     ├─ recorder.ts                    # DRY Recorder class: mode-parameterized stream acquisition; stop/restart chunking
│     ├─ transcription-ui.ts            # mode toggle (mic/system/recording), start/stop, pipes chunks to IPC, renders live deltas
│     ├─ merge-view.ts                  # MergeDiffView: unifiedMergeView, per-chunk accept/reject, toggle via Compartment, commit
│     ├─ merge-launch.ts                # openSmartMerge(): invoke mergeRequest, mount MergeDiffView + suggestions panel
│     └─ editor/
│        ├─ editor.ts                   # CM6 wrapper: createEditor/getContent/setContent/wrapSelection/destroy
│        ├─ preview.ts                  # renderMarkdown(src)->HTML: KaTeX + [[wikilink]] rule + memry:// rewrite; imports katex CSS
│        ├─ wikilink.ts                 # single WIKILINK_RE + extractWikiLinks() (shared: preview rule + future graph)
│        └─ workspace.ts                # mountWorkspace(editorEl, previewEl): wire editor->debounced preview + link delegation
└─ out/                                 # electron-vite build output: out/{main,preload,renderer} (gitignored)
```

---

## 5. Per-area implementation notes

### 5.1 App shell & windows (`src/main/`)

- `index.ts` order is load-bearing: `import './loopback-setup'` (runs `initMain()` at import time, BEFORE `app.whenReady`), `import 'dotenv/config'` early, register the `memry://` scheme as privileged (`protocol.registerSchemeAsPrivileged([{ scheme:'memry', privileges:{ standard:true, secure:true, supportFetchAPI:true }}])`) BEFORE `whenReady`. Then on `whenReady`: `protocol.handle('memry', ...)`, `createEditor()`, `createOverlay()` (kept hidden), `registerIpc(getOverlay)`, `registerOverlayToggle(overlay)`. On `will-quit`: `globalShortcut.unregisterAll()`.
- Both windows use the SAME preload `join(__dirname, '../preload/index.js')`, `contextIsolation:true`, `nodeIntegration:false`, `sandbox:false` (preload bundles `../shared` via CJS require chain).
- Overlay: `frame:false, transparent:true, alwaysOnTop:true` + `setAlwaysOnTop(true,'screen-saver')`, `skipTaskbar:true`, `resizable:false`, `show:false`. Position top-right of cursor's display, then `showInactive()` so it never steals focus; call `overlay.webContents.focus()` after to allow immediate typing.
- Global shortcut `CommandOrControl+Shift+Space`: ONE callback branching on `overlay.isVisible()` (same shortcut toggles). Check `globalShortcut.register()`'s boolean return — if false (combo owned by another app), log and you may fall back to an alternate combo.
- Dev vs prod window load: dev `${process.env.ELECTRON_RENDERER_URL}/overlay.html`; prod `loadFile(out/renderer/overlay.html)`. The HTML filename (not the rollup input key) drives the dev URL — mismatch = blank overlay in packaged build.

### 5.2 Vault (`src/main/vault.ts`)

- Root default `join(app.getPath('documents'), 'Memry')`, overridable via `vault:pick` dialog. `mkdir(root,{recursive:true})` before reads.
- `list/read/update/del` are thin `fs/promises` wrappers. `quick(text)` writes `quick-<ISO-with-dashes>.md` in the SAME folder — quick notes are regular notes flagged by `quick:` filename prefix. Minimal sanitization only (single-user app); no path-traversal hardening beyond keeping ids as bare filenames joined to root.

### 5.3 Markdown editor + preview (`src/renderer/editor/`)

- `editor.ts`: CM6 `EditorView` with `history()`, `defaultKeymap`+`historyKeymap`, `markdown()`, `EditorView.lineWrapping`, an `updateListener` firing `onChange(doc)` on `docChanged`. `setContent` dispatches with `Transaction.addToHistory.of(false)` so disk loads don't pollute undo. `wrapSelection(before, after?)` is the DRY primitive for bold/italic/code toolbar buttons.
- `preview.ts`: ONE shared `MarkdownIt({ html:false, linkify:true })`. `.use(katexPlugin, { throwOnError:false, strict:false })` so a bad `$\frac$` shows red, not a dead document. Custom inline rule registered with `ruler.before('link', 'wikilink', ...)` emitting `<a class="wikilink" data-target="...">`. `patchAttr` rewrites relative `img src` / `link href` to `memry://vault/...`; external links get `target=_blank rel=noopener`. **Import `'katex/dist/katex.min.css'` exactly once here** (Vite bundles the fonts).
- `wikilink.ts`: the ONLY `WIKILINK_RE = /\[\[([^\[\]|]+?)(?:\|([^\[\]]+?))?\]\]/g`, used by the preview rule (reset `lastIndex` before `exec`) and by `extractWikiLinks` (stateless `matchAll`) for the future graph.
- `workspace.ts`: `mountWorkspace(editorEl, previewEl, initial)` debounces preview render ~150ms; delegates `previewEl` clicks — wikilinks dispatch a `open-note` CustomEvent; external links go through main `shell.openExternal`.
- CSP for the renderer: `img-src 'self' memry: data:`, `style-src 'self' 'unsafe-inline'` (KaTeX inline styles), `font-src 'self'`. No external CDN.

### 5.4 Audio capture (`src/renderer/recorder.ts`)

- ONE `Recorder` class parameterized by `mode: 'microphone' | 'system' | 'recording'`; only `acquireStream(mode)` differs:
  - `microphone` / `recording`: `getUserMedia({ audio:{ echoCancellation:false, noiseSuppression:false, channelCount:1 }, video:false })`. (BlackHole, if installed, shows up here as a normal input — zero extra code, the documented fallback.)
  - `system`: `getLoopbackAudioMediaStream()` from the shim (handles the "request video, discard track" dance and sets the Chromium switches). Throw a clear error if no audio track ("grant Screen Recording + relaunch, or use BlackHole").
- **Chunking = stop/restart, NOT timeslice.** Run `MediaRecorder` with `mimeType:'audio/webm;codecs=opus'`, and a `setInterval` (or recursive timeout) that every N seconds (default 15s) calls `recorder.stop()` then immediately `recorder.start()` so each `ondataavailable` blob is a complete, self-contained webm file Whisper can decode. Each blob -> `await blob.arrayBuffer()` -> `window.api.transcription.pushChunk(sessionId, arrayBuffer, blob.type)`.
- `transcription-ui.ts`: mode toggle UI; before `system` mode, call `audio.screenStatus()`; if not `granted`, show banner + `audio.openScreenSettings()` and note the purple indicator + relaunch caveat. Before `microphone`, call `audio.ensureMic()`.

### 5.5 Cloud transcription (`src/main/services/`)

- `transcription.ts`: `transcribe(buffer, mimeType)` — reads `OPENAI_API_KEY` once at module load. No key → return `STUB = '[transcription unavailable — set OPENAI_API_KEY]'` (no network). Else POST `https://api.openai.com/v1/audio/transcriptions` with global `FormData` (`file` Blob, `model:'whisper-1'`, `response_format:'text'`), `Authorization` header only (do NOT set `Content-Type` — undici sets the multipart boundary), 60s `AbortController` timeout. Any non-2xx/throw/timeout → log + return `STUB`. **Never throws.**
- `transcript-buffer.ts`: `Map<sessionId,{text,startedAt,capped}>`. `appendChunk` enforces soft 2h cap (`MEETING_CAP_MS = 2*60*60*1000`): past cap, return a one-time `'[meeting cap reached — transcription paused]'` then `''`. Otherwise space-join the delta. `getTranscript`/`endSession` round it out. No AI-cost guardrails beyond the time cap (single-user app).
- IPC wiring (`src/main/ipc.ts`): `transStart` creates a session id; `transChunk` (`ipcMain.on`) does `Buffer.from(arrayBuffer)` then `appendChunk`, and on a non-empty delta `event.sender.send(CH.transAppend, { sessionId, delta })`; `transStop` returns `getTranscript` and `endSession`.

### 5.6 Claude merge (`src/main/services/merge.ts`) + diff UI (`src/renderer/merge-view.ts`)

- `merge.ts`: `MODEL = process.env.MEMRY_MERGE_MODEL ?? 'claude-haiku-4-5'`. No `ANTHROPIC_API_KEY` → `stub(notes, reason)` (returns `merged===notes` so the diff mounts with zero chunks, plus one suggestion explaining the skip). Else `new Anthropic()` (reads key from env), `messages.create({ model, max_tokens:8000, system, output_config:{ format: json_schema {merged, suggestions} }, messages:[{role:'user', content:'<notes>…</notes><transcript>…</transcript>'}] })`. **No `thinking`/`effort` on Haiku** (errors). Parse first text block as JSON; any throw → `stub`. System prompt instructs surgical edits ("prefer adding/expanding over reflowing existing lines") so diff chunks stay small.
- `merge-view.ts`: `MergeDiffView` mounts CM6 `EditorView` with `doc = merged` (the editable 'b' side) and `unifiedMergeView({ original: userNotes /* read-only 'a' */, mergeControls:true, gutter:true, highlightChanges:true, allowInlineDiffs:true, collapseUnchanged:{margin:3,minSize:4} })` inside a `Compartment`. Per-chunk accept/reject buttons are built-in. Detect decisions via `updateListener` + `tr.isUserEvent('accept')` / `tr.isUserEvent('revert')` (reject fires `'revert'`, NOT `'reject'`). `toggleDiff()` reconfigures the compartment to `[]` (plain editor) vs `unifiedMergeView(...)` — preserves doc/undo. `getMerged()` = `view.state.doc.toString()`. `commit()` calls `window.api.notes.update(filePath, getMerged())`.
- `merge-launch.ts`: `openSmartMerge(parent, suggestionsEl, notes, transcript, filePath)` → `await window.api.merge(...)`, render suggestions as `<li>`s, mount `MergeDiffView`.

---

## 6. npm scripts (`package.json`)

```json
{
  "name": "memry",
  "version": "0.1.0",
  "main": "./out/main/index.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "preview": "electron-vite preview",
    "typecheck": "tsc -p tsconfig.node.json --noEmit && tsc -p tsconfig.web.json --noEmit",
    "package": "electron-vite build && electron-builder --mac dmg"
  }
}
```

---

## 7. macOS entitlements & Info.plist

### `build/entitlements.mac.plist`
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
  <key>com.apple.security.device.audio-input</key><true/>
  <key>com.apple.security.device.microphone</key><true/>
</dict></plist>
```

### `package.json` → `build` block (electron-builder)
```json
{
  "build": {
    "appId": "com.memry.app",
    "productName": "Memry",
    "files": ["out/**/*"],
    "mac": {
      "target": ["dmg"],
      "category": "public.app-category.productivity",
      "hardenedRuntime": true,
      "gatekeeperAssess": false,
      "entitlements": "build/entitlements.mac.plist",
      "entitlementsInherit": "build/entitlements.mac.plist",
      "extendInfo": {
        "NSMicrophoneUsageDescription": "Memry records meeting and lecture audio to generate live transcripts.",
        "NSScreenCaptureUsageDescription": "Memry captures system audio while transcribing meetings and lectures."
      }
    }
  }
}
```

**Permission facts that bite if ignored:**
- `NSMicrophoneUsageDescription` is **mandatory** — the app hard-crashes the instant `getUserMedia` touches the mic without it. Do NOT duplicate the key (electron-builder #7514).
- Screen Recording (system-audio mode) has **no** Info.plist usage key beyond `NSScreenCaptureUsageDescription`; macOS shows its own prompt on first `getDisplayMedia` loopback. `askForMediaAccess('screen')` is NOT valid — only `getMediaAccessStatus('screen')` reads it. First grant usually needs an app **relaunch** before loopback produces sound. Loopback shows the purple Control-Center indicator and captures post-mixer audio (level follows the system volume).
- No camera / `NSCameraUsageDescription` — the loopback video track is requested then immediately discarded; the webcam is never used.
- Notarization for distribution needs `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` env vars; entitlements still apply locally for dev without it.

---

## 8. tsconfig split

- `tsconfig.node.json`: `lib:["ESNext"]`, `types:["node"]`, scopes `src/main/**` + `src/preload/**` + `src/shared/**`. No DOM lib.
- `tsconfig.web.json`: `lib:["ESNext","DOM","DOM.Iterable"]`, scopes `src/renderer/**` + `src/shared/**`. No node types.
- `tsconfig.json`: `references` both. The `@quick-start/electron` vanilla-ts scaffold sets this up — reuse it; a single tsconfig leaks DOM types into main / node types into renderer.

---

## 9. Graceful-degradation contract (verify before shipping)

1. Unset `OPENAI_API_KEY` → app still records; transcript pane fills with the stub string; nothing crashes.
2. Unset `ANTHROPIC_API_KEY` → merge returns `merged===original`; diff mounts with zero chunks; suggestion explains the skip; the user's note is never lost.
3. System-audio mode with Screen Recording denied → clear banner + deep-link, mic mode still works.
4. Malformed `$...$` → red KaTeX error inline, rest of the document renders.
5. Meeting exceeds 2h → one-time cap notice, local note keeps recording, no further API calls.

These are the success criteria the implementation loops against; AI failing first-shot is acceptable as long as each path degrades to stub/basic behavior.