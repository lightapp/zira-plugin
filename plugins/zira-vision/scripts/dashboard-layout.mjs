// Shared layout wire contract. React-grid-layout's transient `moved` flag is not persisted
// by the agent route. Fractional saved dimensions are valid; do not round user layouts.
export const COLS = { lg:12, md:12, sm:6, xs:2, xxs:2 };
export const ROW_KEYS = ['i','x','y','w','h','minW','minH','maxW','maxH','static','isDraggable','isResizable','resizeHandles','isBounded'];
export const cleanRow = row => Object.fromEntries(ROW_KEYS.filter(k => row[k] !== undefined).map(k => [k, k === 'i' ? String(row[k]) : row[k]]));
export const overlaps = (a,b) => a.x < b.x+b.w && a.x+a.w > b.x && a.y < b.y+b.h && a.y+a.h > b.y;
export function validateLayout(layout, widgetIds) {
  if (!layout || !Array.isArray(layout.lg)) throw new Error('Layout requires an lg array');
  for (const [bp, rows] of Object.entries(layout)) {
    if (!Object.hasOwn(COLS,bp) || !Array.isArray(rows) || rows.length > 200) throw new Error(`Invalid layout breakpoint ${bp}`);
    const seen = new Set();
    for (const row of rows) {
      if (!row || Object.keys(row).some(k => !ROW_KEYS.includes(k)) || !widgetIds.has(String(row.i)) || seen.has(String(row.i))) throw new Error(`Unknown, duplicate or invalid layout row at ${bp}`);
      seen.add(String(row.i));
      if (!['x','y','w','h'].every(k => Number.isFinite(row[k])) || row.x < 0 || row.y < 0 || row.w <= 0 || row.h <= 0 || row.x+row.w > COLS[bp])
        throw new Error(`Invalid saved layout at ${bp}; use dashboards edit with layout or copyLayout to repair it before adding widgets`);
    }
  }
  return layout;
}
