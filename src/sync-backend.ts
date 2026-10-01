/** Flag-off builds stay on this device. A Firebase build swaps in Firestore. */
export const cloudTransport = false

export async function cloudSyncPass(control: { requestAgain: () => void }): Promise<'synced' | 'pending' | 'idle' | { state: 'rejected'; message: string }> {
  void control
  return 'idle'
}
