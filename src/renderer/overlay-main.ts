import './style.css'

const input = document.getElementById('overlay-input') as HTMLTextAreaElement
const stickyBtn = document.getElementById('overlay-sticky') as HTMLButtonElement
const saveStickyBtn = document.getElementById('overlay-save-sticky') as HTMLButtonElement
const closeBtn = document.getElementById('overlay-close') as HTMLButtonElement
const hintEl = document.getElementById('overlay-hint') as HTMLElement
const hintDefault = hintEl.innerHTML
let confirming = false

// Grab focus whenever the overlay appears so the user can type immediately.
// window 'focus' alone isn't reliable for a type:'panel' showInactive() — main
// also pushes an explicit `overlay:focusInput` IPC right after showing.
function focusInput(): void {
  input.focus()
}
focusInput()
window.addEventListener('focus', focusInput)
window.api.overlay.onFocusInput(focusInput)

// Save the thought to the Quick Notes folder. Main hides the box on save, so
// there is no toggle afterwards (toggling a hidden box would reopen it).
// Shows a short confirmation first so saving never feels silent.
async function save(): Promise<void> {
  if (confirming) return
  const text = input.value.trim()
  if (!text) {
    window.api.overlay.toggle()
    return
  }
  confirming = true
  input.value = ''
  input.disabled = true
  hintEl.textContent = 'Saved to Quick Notes'
  setTimeout(() => {
    void window.api.overlay.save(text).finally(() => {
      confirming = false
      input.disabled = false
      input.value = ''
      hintEl.innerHTML = hintDefault
    })
  }, 650)
}

// Spawn an empty sticky note alongside the overlay. Quick-note text is left
// untouched — the "+" is just a "give me a fresh sticky" affordance, distinct
// from "save as sticky" which commits the current text and dismisses.
async function spawnEmptySticky(): Promise<void> {
  await window.api.stickies.create()
}

// Save the current thought as a sticky. Clears the input so the user can keep
// jotting, but leaves the overlay open (matches the "+" button's stay-open feel).
async function saveAsSticky(): Promise<void> {
  const text = input.value.trim()
  if (text) await window.api.stickies.create(text)
  input.value = ''
}

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault()
    if (e.shiftKey) void saveAsSticky()
    else void save()
  } else if (e.key === 'Escape') {
    // Esc dismisses every panel (overlay + all stickies) without deleting any.
    e.preventDefault()
    window.api.panels.hideAll()
  }
})

stickyBtn.addEventListener('click', () => void spawnEmptySticky())
saveStickyBtn.addEventListener('click', () => void saveAsSticky())
closeBtn.addEventListener('click', () => {
  input.value = ''
  window.api.overlay.toggle()
})
