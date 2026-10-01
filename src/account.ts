import type { AccountHooks } from './account-hooks.ts'

/** Flag-off builds stay on this device. The public build swaps in Google sign-in. */
export const accountSignIn: boolean = false

export async function prepareAccount(hooks: AccountHooks): Promise<void> {
  void hooks
}

export function markAccountBooted(): void {}

export function accountHomeNote(): string {
  return ''
}

export function accountBadge(): string {
  return ''
}

export function accountSyncText(): string {
  return ''
}

export function onAccountSync(fn: () => void): () => void {
  void fn
  return () => {}
}

export function accountPanelHtml(): string {
  return ''
}

export function bindAccountPanel(hooks: AccountHooks): void {
  void hooks
}

export async function syncAccountNow(): Promise<void> {}

export function noteLocalChange(): void {}
