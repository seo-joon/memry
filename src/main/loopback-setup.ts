// SIDE-EFFECT import only. Runs at module-import time, BEFORE app is ready, so the
// electron-audio-loopback Chromium feature switches are appended before the GPU/render
// processes spin up. main/index.ts imports this FIRST.
import { initMain } from 'electron-audio-loopback'

initMain()
