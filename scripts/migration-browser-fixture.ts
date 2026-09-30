// Served only by the test's Vite server; never included by the application entry.
import { initializeApp } from 'firebase/app'
import { connectFirestoreEmulator, initializeFirestore, memoryLocalCache } from 'firebase/firestore'
import { setCloudFirestore } from '../src/cloud-handle.ts'
import { bindStudyDatabase } from '../src/study-lock.ts'
import { accountDatabaseName } from '../src/user.ts'
import { cloudSyncPass } from '../src/cloud-sync.ts'

export async function openAccount(uid: string, host: string): Promise<string> {
  const app = initializeApp({ apiKey: 'demo-key', projectId: 'demo-german-flashcards', appId: 'demo-app' }, crypto.randomUUID())
  const db = initializeFirestore(app, { localCache: memoryLocalCache() })
  const [hostname, port] = host.split(':')
  connectFirestoreEmulator(db, hostname, Number(port), { mockUserToken: { sub: uid, user_id: uid } })
  setCloudFirestore(db)
  bindStudyDatabase({ uid, dbName: accountDatabaseName(uid) })
  let repeat = false
  let result: Awaited<ReturnType<typeof cloudSyncPass>>
  do {
    repeat = false
    result = await cloudSyncPass({ requestAgain: () => { repeat = true } })
  } while (repeat)
  return typeof result === 'string' ? result : result.message
}
