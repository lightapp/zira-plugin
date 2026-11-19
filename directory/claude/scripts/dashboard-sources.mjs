// Which of a dashboard's data sources belong to the selected site. Kept apart from
// dashboard-widgets.mjs so the read-only cross-site path and the write guard share one lookup.
import { id, siteDataSources } from "./client.mjs";

// The site's data sources by ID, plus the dashboard's data sources that live at another site.
// With allowCrossSite (the read-only context) those are admitted so a home page that reads several
// sites can be described. Saving never passes allowCrossSite: every data source of a dashboard that
// is written must belong to the selected site.
export async function sourceInventory(call, site, dashboard, allowCrossSite = false) {
  const inventory = new Map((await siteDataSources(call, site)).map(d => [String(d.id), d]));
  const crossSiteSources = [];
  for (const d of dashboard?.devices ?? []) {
    const key = String(d?.id ?? "");
    if (!id(key) || inventory.has(key)) continue;
    const siteId = d.site?.id ?? d.siteId;
    crossSiteSources.push({ id: key, name: String(d.name ?? ""), siteId: siteId == null ? null : String(siteId) });
    if (allowCrossSite) inventory.set(key, d);
  }
  return { inventory, crossSiteSources };
}
