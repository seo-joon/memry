import { contextBridge, ipcRenderer } from 'electron'
import { CH } from '../shared/ipc'
import type { Api, Theme, TransAppendPayload } from '../shared/ipc'

const api: Api = {
  notes: {
    read: (id) => ipcRenderer.invoke(CH.noteRead, id),
    create: (n) => ipcRenderer.invoke(CH.noteCreate, n),
    update: (id, md) => ipcRenderer.invoke(CH.noteUpdate, id, md)
  },
  vault: {
    tree: () => ipcRenderer.invoke(CH.vaultTree),
    path: () => ipcRenderer.invoke(CH.vaultPath),
    pick: () => ipcRenderer.invoke(CH.vaultPick),
    asset: (rel) => ipcRenderer.invoke(CH.vaultAsset, rel),
    writeAsset: (filename, base64) => ipcRenderer.invoke(CH.vaultWriteAsset, filename, base64),
    folderCreate: (parent, name) => ipcRenderer.invoke(CH.folderCreate, parent, name),
    move: (src, dest) => ipcRenderer.invoke(CH.vaultMove, src, dest),
    delete: (path) => ipcRenderer.invoke(CH.vaultDelete, path)
  },
  transcription: {
    start: (noteId) => ipcRenderer.invoke(CH.transStart, noteId),
    pushChunk: (s, audio, mimeType) => ipcRenderer.send(CH.transChunk, s, audio, mimeType),
    onAppend: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, p: TransAppendPayload) => cb(p)
      ipcRenderer.on(CH.transAppend, listener)
      return () => ipcRenderer.removeListener(CH.transAppend, listener)
    },
    stop: (s) => ipcRenderer.invoke(CH.transStop, s)
  },
  audio: {
    ensureMic: () => ipcRenderer.invoke(CH.micEnsure),
    screenStatus: () => ipcRenderer.invoke(CH.screenStatus),
    openScreenSettings: () => ipcRenderer.send(CH.screenOpen),
    repairScreen: () => ipcRenderer.invoke(CH.screenRepair),
    // These two channels are registered by electron-audio-loopback's initMain() in main.
    enableLoopback: () => ipcRenderer.invoke('enable-loopback-audio'),
    disableLoopback: () => ipcRenderer.invoke('disable-loopback-audio')
  },
  overlay: {
    save: (text) => ipcRenderer.invoke(CH.overlaySave, text),
    toggle: () => ipcRenderer.send(CH.overlayToggle),
    onFocusInput: (cb) => {
      const listener = (): void => cb()
      ipcRenderer.on(CH.overlayFocusInput, listener)
      return () => ipcRenderer.removeListener(CH.overlayFocusInput, listener)
    }
  },
  panels: {
    hideAll: () => ipcRenderer.send(CH.panelsHideAll)
  },
  stickies: {
    create: (text) => ipcRenderer.invoke(CH.stickyCreate, text),
    get: (id) => ipcRenderer.invoke(CH.stickyGet, id),
    update: (id, text) => ipcRenderer.send(CH.stickyUpdate, id, text),
    close: (id) => ipcRenderer.send(CH.stickyClose, id)
  },
  editor: {
    onCloseTab: (cb) => {
      const listener = (): void => cb()
      ipcRenderer.on(CH.editorCloseTab, listener)
      return () => ipcRenderer.removeListener(CH.editorCloseTab, listener)
    }
  },
  analysis: {
    run: (noteId, transcript) => ipcRenderer.invoke(CH.analysisRun, noteId, transcript),
    replace: (noteId, entryId, transcript) =>
      ipcRenderer.invoke(CH.analysisReplace, noteId, entryId, transcript),
    list: (noteId) => ipcRenderer.invoke(CH.analysisList, noteId),
    delete: (noteId, entryId) => ipcRenderer.invoke(CH.analysisDelete, noteId, entryId)
  },
  suggest: {
    complete: (noteId, paragraph) => ipcRenderer.invoke(CH.suggestComplete, noteId, paragraph)
  },
  settings: {
    get: () => ipcRenderer.invoke(CH.settingsGet),
    set: (keys) => ipcRenderer.invoke(CH.settingsSet, keys)
  },
  keybinds: {
    get: () => ipcRenderer.invoke(CH.keybindsGet),
    set: (id, on) => ipcRenderer.invoke(CH.keybindsSet, id, on)
  },
  theme: {
    get: () => ipcRenderer.invoke(CH.themeGet),
    set: (t: Theme) => ipcRenderer.invoke(CH.themeSet, t),
    onChange: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, t: Theme): void => cb(t)
      ipcRenderer.on(CH.themeChanged, listener)
      return () => ipcRenderer.removeListener(CH.themeChanged, listener)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)
