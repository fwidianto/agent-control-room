export type RuntimeIcon = 'codex' | 'claude' | 'neutral'

export function runtimeIcon(runtime: unknown): RuntimeIcon {
  if (runtime === 'codex') return 'codex'
  if (runtime === 'claude') return 'claude'
  return 'neutral'
}
