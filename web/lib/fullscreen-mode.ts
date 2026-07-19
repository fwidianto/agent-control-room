export function installFullscreenMode(
  target: Pick<Window, 'addEventListener' | 'removeEventListener' | 'requestAnimationFrame' | 'cancelAnimationFrame'>,
  bodyStyle: Pick<CSSStyleDeclaration, 'overflow'>,
  onKeyDown: (event: KeyboardEvent) => void,
  onReady: () => void,
): () => void {
  const previousOverflow = bodyStyle.overflow
  bodyStyle.overflow = 'hidden'
  const frame = target.requestAnimationFrame(onReady)
  target.addEventListener('keydown', onKeyDown)
  return () => {
    target.cancelAnimationFrame(frame)
    target.removeEventListener('keydown', onKeyDown)
    bodyStyle.overflow = previousOverflow
  }
}

export function shouldProcessCameraCommand(lastProcessedId: number | undefined, commandId: number): boolean {
  return lastProcessedId !== commandId
}
