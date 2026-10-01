import { cloudFirestore } from './cloud-handle.ts'
import { publicFirebaseWeb } from './firebase-web.ts'
import { accountDeckId } from './cloud-push.ts'
import { copyMappedLegacyProfile } from './db.ts'
import { esc } from './dom.ts'
import { validateMapping, type MigrationMapping } from './migration-data.ts'
import { captureStudyLock, studyLockCurrent } from './study-lock.ts'
import { listUsers } from './user.ts'
import { syncNow } from './sync.ts'

function activeProjectId(): string {
  return import.meta.env.VITE_FIREBASE_PROJECT_ID || publicFirebaseWeb.projectId
}

export function migrationPanelHtml(): string {
  if (!listUsers().length) return ''
  return `<details class="setting">
    <summary>Recover a legacy profile on this device</summary>
    <p class="note">Use the mapping file confirmed during migration. The original profile stays on this device. Repeat on every device with reviews that have not synced.</p>
    <label>Reviewed mapping file <input id="migration-map" type="file" accept="application/json,.json"></label>
    <label>Local profile <select id="migration-profile" disabled></select></label>
    <label><input id="migration-confirm" type="checkbox"> I confirm this profile belongs to my signed-in account.</label>
    <button id="migration-copy" class="secondary" type="button" disabled>Copy local progress and vocabulary</button>
    <p class="note" id="migration-result" role="status"></p>
  </details>`
}

export function bindMigrationPanel(): void {
  const file = document.getElementById('migration-map') as HTMLInputElement | null
  const profile = document.getElementById('migration-profile') as HTMLSelectElement | null
  const confirm = document.getElementById('migration-confirm') as HTMLInputElement | null
  const copy = document.getElementById('migration-copy') as HTMLButtonElement | null
  const result = document.getElementById('migration-result')
  if (!file || !profile || !confirm || !copy || !result) return
  const lock = captureStudyLock()
  let mapping: MigrationMapping | null = null
  let busy = false
  const update = () => { copy.disabled = busy || !mapping || !profile.value || !confirm.checked || !studyLockCurrent(lock) }
  file.addEventListener('change', () => {
    mapping = null
    profile.innerHTML = ''
    profile.disabled = true
    confirm.checked = false
    update()
    const selected = file.files?.[0]
    if (!selected) return
    void selected.text().then((text) => {
      if (!studyLockCurrent(lock) || file.files?.[0] !== selected) return
      const parsed = validateMapping(JSON.parse(text))
      if (parsed.projectId !== activeProjectId()) throw new Error('Mapping is for a different Firebase project')
      const candidates = listUsers().filter((user) => Object.hasOwn(parsed.profiles, user.slug) && parsed.profiles[user.slug] === lock.uid)
      if (!candidates.length) throw new Error('No local profile is mapped to this signed-in account')
      mapping = parsed
      profile.innerHTML = candidates.map((user) => `<option value="${esc(user.slug)}">${esc(user.name)} (${esc(user.slug)})</option>`).join('')
      profile.disabled = false
      result.textContent = 'Confirm the named profile, then copy it.'
      update()
    }).catch((error) => { result.textContent = error.message; update() })
  })
  confirm.addEventListener('change', update)
  copy.addEventListener('click', () => {
    if (copy.disabled || !mapping || !studyLockCurrent(lock)) return
    const chosen = mapping
    const selectedProfile = profile.value
    busy = true
    update()
    void (async () => {
      const db = cloudFirestore()
      if (!db || !lock.uid) throw new Error('Sign in before copying')
      const deckId = await accountDeckId(db, lock.uid)
      if (!studyLockCurrent(lock)) return
      const copied = await copyMappedLegacyProfile(selectedProfile, chosen, activeProjectId(), deckId)
      if (!studyLockCurrent(lock)) return
      result.textContent = copied.state === 'skipped' ? 'No mapped local data to copy.'
        : `${copied.cards} cards and ${copied.tombstones} deletions checked. Saved on this device; syncing now.`
      await syncNow()
    })().catch((error) => { if (studyLockCurrent(lock)) result.textContent = error.message })
      .finally(() => { busy = false; update() })
  })
}
