import type { NeedsFixing } from './record-sync.ts'

/** Flag-off builds stay on this device. A Firebase build swaps in Firestore. */
export const cloudTransport = false

export async function cloudSyncPass(control: { requestAgain: () => void; light?: boolean; foreground?: boolean; now?: () => number }): Promise<'synced' | 'pending' | 'idle' | 'local' | 'quota' | { state: 'rejected'; message: string; items: NeedsFixing[] }> {
  void control
  return 'idle'
}
