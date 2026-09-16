import { ipcMain, dialog, BrowserWindow } from 'electron'
import type { Rectangle } from 'electron'
import { CH } from '../shared/ipc'
import type { CreateNote, SessionId, SettingsKeys } from '../shared/ipc'
import {
  readVaultTree,
  readNote,
  createNote,
  updateNote,
  createFolder,
  moveItem,
  deleteItem,
  createQuickNote,
  getVaultPath,
  setVaultPath,
  resolveAsset,
  writeAsset
} from './vault'
import { transcribe } from './services/transcription'
import { cleanup } from './services/cleanup'
import { getUserKeys, saveUserKeys } from './keys'
import { resetOpenAI } from './services/openai-client'
import { runAnalysis, replaceEntry, readEntries, deleteEntry } from './services/analysis'
import { suggest } from './services/suggest'
import { startSession, appendChunk, endSession } from './services/transcript-buffer'
import {
  ensureMicAccess,
  screenAccessStatus,
  openScreenRecordingSettings,
  repairScreenRecording
} from './audio-permissions'
import { getOverlayWindow, setQuickCaptureEnabled, setCloseTabEnabled } from './windows'
import { getKeybinds, setKeybind } from './prefs'
import { createSticky, getStickyText, updateSticky, closeSticky, setStickiesVisible } from './stickies'

export function registerIpc(): void {
  // --- vault / notes ---
  ipcMain.handle(CH.vaultTree, () => readVaultTree())
  ipcMain.handle(CH.noteRead, (_e, id: string) => readNote(id))
  ipcMain.handle(CH.noteCreate, (_e, n: CreateNote) => createNote(n))
  ipcMain.handle(CH.noteUpdate, (_e, id: string, md: string) => updateNote(id, md))
  ipcMain.handle(CH.folderCreate, (_e, parent: string, name: string) => createFolder(parent, name))
  ipcMain.handle(CH.vaultMove, (_e, src: string, dest: string) => moveItem(src, dest))
  ipcMain.handle(CH.vaultDelete, (_e, path: string) => deleteItem(path))
  ipcMain.handle(CH.vaultPath, () => getVaultPath())
  ipcMain.handle(CH.vaultAsset, (_e, rel: string) => resolveAsset(rel))
  ipcMain.handle(CH.vaultWriteAsset, (_e, filename: string, base64: string) =>
    writeAsset(filename, base64)
  )
  ipcMain.handle(CH.vaultPick, async () => {
    const res = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    if (res.canceled || res.filePaths.length === 0) return null
    const picked = res.filePaths[0]
    setVaultPath(picked)
    return picked
  })

  // --- transcription ---
  ipcMain.handle(CH.transStart, () => startSession())
  // Fire-and-forget audio chunk: transcribe then append, push any non-empty delta to that renderer.
  ipcMain.on(CH.transChunk, async (event, sid: SessionId, audio: ArrayBuffer, mime: string) => {
    const text = await transcribe(Buffer.from(audio), mime)
    const delta = appendChunk(sid, text)
    if (delta) event.sender.send(CH.transAppend, { sessionId: sid, delta })
  })
  // Stop = "we have all the chunks". Pull the raw transcript out of the buffer,
  // then one Haiku pass to clean it up (fix misheard words, drop [BLANK_AUDIO]
  // tags, join fragments) before it lands in the note. Cleanup is best-effort —
  // it falls back to the raw text if the key is missing or the call fails.
  ipcMain.handle(CH.transStop, async (_e, sid: SessionId) => {
    const raw = endSession(sid)
    if (!raw.trim()) return raw
    return await cleanup(raw)
  })

  // --- analysis (renderer triggers explicitly after a transcript lands) ---
  ipcMain.handle(CH.analysisRun, (_e, noteId: string, transcript: string) =>
    runAnalysis(noteId, transcript)
  )
  ipcMain.handle(CH.analysisReplace, (_e, noteId: string, entryId: string, transcript: string) =>
    replaceEntry(noteId, entryId, transcript)
  )
  ipcMain.handle(CH.analysisList, (_e, noteId: string) => readEntries(noteId))
  ipcMain.handle(CH.analysisDelete, (_e, noteId: string, entryId: string) =>
    deleteEntry(noteId, entryId)
  )

  // --- inline suggestions (fires per debounced keystroke) ---
  ipcMain.handle(CH.suggestComplete, (_e, noteId: string, paragraph: string) =>
    suggest(noteId, paragraph)
  )

  // --- settings (per-Mac API keys) ---
  ipcMain.handle(CH.settingsGet, () => getUserKeys())
  ipcMain.handle(CH.settingsSet, async (_e, keys: SettingsKeys) => {
    await saveUserKeys(keys)
    // Keys apply at once: transcription reads env per call, the OpenAI client
    // needs its cached instance dropped.
    if (keys.openaiApiKey.trim()) process.env.OPENAI_API_KEY = keys.openaiApiKey.trim()
    else delete process.env.OPENAI_API_KEY
    if (keys.groqApiKey.trim()) process.env.GROQ_API_KEY = keys.groqApiKey.trim()
    else delete process.env.GROQ_API_KEY
    resetOpenAI()
  })

  // --- shortcut toggles ---
  ipcMain.handle(CH.keybindsGet, () => getKeybinds())
  ipcMain.handle(CH.keybindsSet, async (_e, id: string, on: boolean) => {
    const map = await setKeybind(id, on)
    // The two main-owned shortcuts apply at once; renderer-owned ones are
    // picked up live in the editor window.
    if (id === 'quickCapture') {
      const overlay = getOverlayWindow()
      if (overlay) setQuickCaptureEnabled(on, overlay)
    } else if (id === 'closeTab') {
      setCloseTabEnabled(on)
    }
    return map
  })

  // --- audio permissions ---
  ipcMain.handle(CH.micEnsure, () => ensureMicAccess())
  ipcMain.handle(CH.screenStatus, () => screenAccessStatus())
  ipcMain.on(CH.screenOpen, () => openScreenRecordingSettings())
  ipcMain.handle(CH.screenRepair, () => repairScreenRecording())

  // --- overlay quick capture ---
  ipcMain.handle(CH.overlaySave, async (_e, text: string) => {
    const meta = await createQuickNote(text)
    getOverlayWindow()?.hide()
    return meta
  })
  ipcMain.on(CH.overlayToggle, () => {
    const overlay = getOverlayWindow()
    if (!overlay) return
    if (overlay.isVisible()) overlay.hide()
    else overlay.showInactive()
  })

  // Esc in the overlay or any sticky pipes through here. Hide everything (overlay
  // + every sticky window) without deleting any sticky's data — they reappear on
  // the next ⌘⇧Space toggle.
  ipcMain.on(CH.panelsHideAll, () => {
    const overlay = getOverlayWindow()
    if (overlay?.isVisible()) overlay.hide()
    setStickiesVisible(false)
  })

  // --- sticky notes ---
  // When a sticky calls create(), anchor the new one to its position so a fresh
  // window doesn't pile directly on top of the one that spawned it.
  ipcMain.handle(CH.stickyCreate, (e, text?: string) => {
    const sender = BrowserWindow.fromWebContents(e.sender)
    const bounds: Rectangle | undefined = sender?.getBounds()
    const anchor = bounds ? { x: bounds.x + 24, y: bounds.y + 24 } : undefined
    return createSticky(text, anchor)
  })
  ipcMain.handle(CH.stickyGet, (_e, id: string) => getStickyText(id))
  ipcMain.on(CH.stickyUpdate, (_e, id: string, text: string) => updateSticky(id, text))
  ipcMain.on(CH.stickyClose, (_e, id: string) => closeSticky(id))
}
