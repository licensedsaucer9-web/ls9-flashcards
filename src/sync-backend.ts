import type { NeedsFixing } from './record-sync.ts'

/** Flag-off builds stay on this device. A Firebase build swaps in Firestore. */
export const cloudTransport = false

export async function cloudSyncPass(control: { requestAgain: () => void }): Promise<'synced' | 'pending' | 'idle' | 'local' | { state: 'rejected'; message: string; items: NeedsFixing[] }> {
  void control
  return 'idle'
}
