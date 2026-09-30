/** Flag-off builds keep the GitHub transport. The cloud module is swapped in at build time. */
export const cloudTransport = false

export async function cloudSyncPass(control: { requestAgain: () => void }): Promise<'synced' | 'pending' | 'idle'> {
  void control
  return 'idle'
}
