import type { Firestore } from 'firebase/firestore'

let current: Firestore | null = null

export function setCloudFirestore(db: Firestore | null): void {
  current = db
}

export function cloudFirestore(): Firestore | null {
  return current
}
