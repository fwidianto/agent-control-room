export function isCanvasClickGesture(originX: number, originY: number, endX: number, endY: number, didDrag: boolean, threshold: number): boolean {
  return !didDrag && Math.abs(endX - originX) + Math.abs(endY - originY) < threshold
}
