export type TimelineWindow = [number, number];
export function clampWindow(
  start: number,
  span: number,
  duration: number,
): TimelineWindow {
  const width = Math.max(Math.min(1, duration), Math.min(duration, span));
  const left = Math.max(0, Math.min(duration - width, start));
  return [left, left + width];
}
export function zoomWindow(
  view: TimelineWindow,
  factor: number,
  ratio: number,
  duration: number,
): TimelineWindow {
  const r = Math.max(0, Math.min(1, ratio));
  const span = Math.max(
    Math.min(1, duration),
    Math.min(duration, (view[1] - view[0]) * factor),
  );
  return clampWindow(
    view[0] + (view[1] - view[0]) * r - span * r,
    span,
    duration,
  );
}
