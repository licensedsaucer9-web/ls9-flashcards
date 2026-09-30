export type AccountHooks = {
  toast(message: string): void
  ensureSeed(): Promise<number>
  onIdentityChanged(): void
  setTabs(visible: boolean): void
}
