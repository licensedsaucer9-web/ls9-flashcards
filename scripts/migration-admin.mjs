import { initializeApp, cert, deleteApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { readPrivateJson, credentialPath } from './migration-files.mjs'
import { same } from './migration-core.mjs'

export async function adminStore(projectId, { emulator = false, credential = 'service-account.json' } = {}) {
  const host = process.env.FIRESTORE_EMULATOR_HOST
  if (emulator && (!host || !projectId.startsWith('demo-'))) throw new Error('Emulator mode requires FIRESTORE_EMULATOR_HOST and a demo-* project')
  if (!emulator && host) throw new Error('Unset FIRESTORE_EMULATOR_HOST for a live import, or explicitly use --emulator')
  let options
  if (emulator) {
    // A synthetic, unregistered certificate avoids ambient credential/metadata
    // discovery. Emulator mode overrides authentication and never uses this key
    // to obtain a real token; the key is not written to disk or printed.
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    options = { projectId, credential: cert({ projectId, clientEmail: 'emulator@example.test',
      privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }) }
  }
  if (!emulator) {
    const serviceAccount = readPrivateJson(credentialPath(credential))
    if (serviceAccount.project_id !== projectId) throw new Error('Service account project does not match the mapping')
    options = { projectId, credential: cert(serviceAccount) }
  }
  const app = initializeApp(options, `migration-${randomUUID()}`)
  const db = getFirestore(app)
  return {
    get: async (path) => (await db.doc(path).get()).data() ?? null,
    list: async (path) => (await db.collection(path).get()).docs.map((row) => ({ id: row.id, data: row.data() })),
    // Includes ids whose document is gone but a subcollection still has documents.
    listDocumentIds: async (path) => (await db.collection(path).listDocuments()).map((ref) => ref.id),
    listSubcollections: async (path) => (await db.doc(path).listCollections()).map((col) => col.id),
    atomic: (paths, compute) => db.runTransaction(async (tx) => {
      const refs = paths.map((path) => db.doc(path))
      const snaps = await tx.getAll(...refs)
      const before = snaps.map((snap) => snap.data() ?? null)
      const after = compute(before)
      after.forEach((data, index) => { if (!same(data, before[index])) tx.set(refs[index], data) })
    }),
    close: async () => { await db.terminate(); await deleteApp(app) },
  }
}
