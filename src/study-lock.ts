export type StudyLock = {
  generation: number
  uid: string | null
  dbName: string
}

let generation = 0
let boundUid: string | null = null
let boundDb: string | null = null

export function captureStudyLock(): StudyLock {
  return { generation, uid: boundUid, dbName: boundDb ?? '' }
}

export function studyLockCurrent(lock: StudyLock): boolean {
  return lock.generation === generation && lock.uid === boundUid
}

export function hasStudyBinding(): boolean {
  return boundDb !== null
}

/** Switch the database reads and writes are allowed to touch. Drops in-flight work. */
export function bindStudyDatabase(next: { uid: string | null; dbName: string }): StudyLock {
  generation += 1
  boundUid = next.uid
  boundDb = next.dbName
  return captureStudyLock()
}

export function clearStudyBinding(): void {
  generation += 1
  boundUid = null
  boundDb = null
}
