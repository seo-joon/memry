// THE single source of truth for inter-process communication.
// - main/ipc.ts registers a handler for every channel here.
// - preload/index.ts builds the `window.api` bridge from these constants.
// - renderer imports the `Api` type to stay in sync.
// Adding a channel = one line in CH + one wrapper in preload + one handler in main.

export const CH = {
  // --- vault / notes (invoke = request/response) ---
  vaultTree: 'vault:tree', // () => VaultTree   (nested folders + flat notes)
  noteRead: 'note:read', // (id) => string
  noteCreate: 'note:create', // (CreateNote) => TreeNote
  noteUpdate: 'note:update', // (id, md) => void
  folderCreate: 'vault:folderCreate', // (parentPath, name) => string  (new folder path)
  vaultMove: 'vault:move', // (src, dest) => string  (final path; rename + move, notes & folders)
  vaultDelete: 'vault:delete', // (path) => void  (note or folder, recursive)
  vaultPath: 'vault:path', // () => string
  vaultPick: 'vault:pick', // () => string | null   (folder dialog)
  vaultAsset: 'vault:asset', // (relPath) => string  (resolve for memry://)
  vaultWriteAsset: 'vault:writeAsset', // (filename, base64) => string  (rel path written to vault root, collision-deduped)

  // --- transcription (control plane = invoke; audio stream = send) ---
  transStart: 'trans:start', // (noteId) => SessionId
  transChunk: 'trans:chunk', // (SessionId, ArrayBuffer, mimeType) => void  RENDERER->MAIN, fire-and-forget
  transAppend: 'trans:append', // MAIN->RENDERER push: { sessionId, delta }
  transStop: 'trans:stop', // (SessionId) => string  (final accumulated transcript)

  // --- audio permissions / capability gating ---
  micEnsure: 'audio:micEnsure', // () => boolean  (prompt mic if not-determined)
  screenStatus: 'audio:screenStatus', // () => MediaAccessStatus  (read-only)
  screenOpen: 'audio:screenOpen', // () => void  (deep-link System Settings > Screen Recording)
  screenRepair: 'audio:screenRepair', // () => boolean  (reset own entry + relaunch)

  // --- overlay quick capture ---
  overlaySave: 'overlay:save', // (text) => TreeNote  (quick note -> Quick Notes folder, then hide)
  overlayToggle: 'overlay:toggle', // () => void  (renderer-driven hide; shortcut also toggles in main)
  overlayFocusInput: 'overlay:focusInput', // MAIN->RENDERER push: re-focus textarea after a panel-style showInactive

  // --- panels (overlay + all stickies) ---
  panelsHideAll: 'panels:hideAll', // RENDERER->MAIN, fire-and-forget. Hide everything (no deletes).

  // --- sticky notes (persistent floating windows) ---
  stickyCreate: 'sticky:create', // (text?) => string  (new sticky id)
  stickyGet: 'sticky:get', // (id) => string  (initial text for a restored window)
  stickyUpdate: 'sticky:update', // (id, text) => void  RENDERER->MAIN, fire-and-forget autosave
  stickyClose: 'sticky:close', // (id) => void  RENDERER->MAIN

  // --- editor window shortcuts (main intercepts default menu accelerators) ---
  editorCloseTab: 'editor:closeTab', // MAIN->RENDERER push when ⌘W is pressed

  // --- analysis (one entry per recording; sidecar stores AnalysisEntry[]) ---
  analysisRun: 'analysis:run', // (noteId, transcript) => AnalysisEntry  (appends)
  analysisReplace: 'analysis:replace', // (noteId, entryId, transcript) => AnalysisEntry (re-analyze)
  analysisList: 'analysis:list', // (noteId) => AnalysisEntry[]
  analysisDelete: 'analysis:delete', // (noteId, entryId) => void

  // --- inline suggestions (cheap model, fed analysis result as context) ---
  suggestComplete: 'suggest:complete', // (noteId, paragraph) => string

  // --- settings (per-Mac API keys; kept out of the installer) ---
  settingsGet: 'settings:get', // () => SettingsKeys
  settingsSet: 'settings:set', // (keys) => void

  // --- shortcut toggles (stored in userData/settings.json) ---
  keybindsGet: 'keybinds:get', // () => KeybindMap
  keybindsSet: 'keybinds:set' // (id, on) => KeybindMap
} as const

// A note in the vault tree. `id` is the vault-relative path (POSIX separators, includes .md).
export interface TreeNote {
  id: string
  title: string
  mtime: number
  quick: boolean
}

// A folder in the vault tree. The root folder has name '' and path ''.
export interface TreeFolder {
  name: string
  path: string
  folders: TreeFolder[]
  notes: TreeNote[]
}

export interface VaultTree {
  root: TreeFolder
}

export interface CreateNote {
  title?: string
  body?: string
  quick?: boolean
  folder?: string // parent folder (vault-relative path); default = root
}

export type SessionId = string

export type MediaAccessStatus =
  | 'not-determined'
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'unknown'

export interface TransAppendPayload {
  sessionId: SessionId
  delta: string
}

// API keys stored on this Mac only (Settings panel). Never bundled, never synced.
export interface SettingsKeys {
  openaiApiKey: string
  groqApiKey: string
}

// Shortcut on/off map, keyed by the ids in shared/keybinds.
export type KeybindMap = Record<string, boolean>

// A topic surfaced from the transcript. `sources` are verbatim quotes from the
// transcript that justify the node — used to render the click-into description.
export interface AnalysisNode {
  id: string
  title: string
  description: string
  sources: string[]
}

// A connection between two nodes with a short natural-language label.
export interface AnalysisEdge {
  from: string
  to: string
  label: string
}

export interface AnalysisResult {
  summary: string
  nodes: AnalysisNode[]
  edges: AnalysisEdge[]
}

// One stored analysis pass — every recording produces one entry; the sidecar
// holds AnalysisEntry[] so multiple meetings in the same note keep their own
// summary + graph. `sourceText` is the transcript that generated this entry,
// preserved so the re-analyze button can re-run on the same text.
export interface AnalysisEntry {
  id: string
  createdAt: number
  label: string
  sourceText: string
  result: AnalysisResult
}

// The exact shape preload exposes as window.api — derived ONCE, reused everywhere.
export interface Api {
  notes: {
    read(id: string): Promise<string>
    create(n: CreateNote): Promise<TreeNote>
    update(id: string, md: string): Promise<void>
  }
  vault: {
    tree(): Promise<VaultTree>
    path(): Promise<string>
    pick(): Promise<string | null>
    asset(rel: string): Promise<string>
    writeAsset(filename: string, base64: string): Promise<string>
    folderCreate(parentPath: string, name: string): Promise<string>
    move(src: string, dest: string): Promise<string>
    delete(path: string): Promise<void>
  }
  transcription: {
    start(noteId: string): Promise<SessionId>
    pushChunk(s: SessionId, audio: ArrayBuffer, mimeType: string): void // fire-and-forget audio
    onAppend(cb: (p: TransAppendPayload) => void): () => void // subscribe; returns unsubscribe
    stop(s: SessionId): Promise<string>
  }
  audio: {
    ensureMic(): Promise<boolean>
    screenStatus(): Promise<MediaAccessStatus>
    openScreenSettings(): void
    repairScreen(): Promise<boolean>
    // System-audio loopback (handled by electron-audio-loopback's initMain in the
    // main process). Renderer enables it, calls getDisplayMedia, then disables it.
    enableLoopback(): Promise<void>
    disableLoopback(): Promise<void>
  }
  overlay: {
    save(text: string): Promise<TreeNote>
    toggle(): void
    onFocusInput(cb: () => void): () => void
  }
  panels: {
    hideAll(): void
  }
  stickies: {
    create(text?: string): Promise<string>
    get(id: string): Promise<string>
    update(id: string, text: string): void
    close(id: string): void
  }
  editor: {
    onCloseTab(cb: () => void): () => void // subscribe to ⌘W intercept; returns unsubscribe
  }
  analysis: {
    run(noteId: string, transcript: string): Promise<AnalysisEntry>
    replace(noteId: string, entryId: string, transcript: string): Promise<AnalysisEntry>
    list(noteId: string): Promise<AnalysisEntry[]>
    delete(noteId: string, entryId: string): Promise<void>
  }
  suggest: {
    complete(noteId: string, paragraph: string): Promise<string>
  }
  settings: {
    get(): Promise<SettingsKeys>
    set(keys: SettingsKeys): Promise<void>
  }
  keybinds: {
    get(): Promise<KeybindMap>
    set(id: string, on: boolean): Promise<KeybindMap>
  }
}
