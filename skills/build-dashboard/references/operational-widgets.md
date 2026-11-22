# Native indicators and shortcuts

Use the local MCP `dashboard_widgets` tool with `command: "context"` / `"save"`, the normal company/site/dashboard scope, and a spec outside the plugin. Preview before apply; reuse the user's authorization for the exact change. Apply with the preview's `--expected` revision. Read back and verify in the browser. Do not click through the editor to create/modify these widgets.

These payloads need backend admission for widget types 11 and 7 and the requested POST/PUT action. An older backend rejects them. Report that dependency and retain the spec; do not claim a preview was saved. The earlier platform #248 draft admits shortcut updates only. A mixed batch attempts these families before charts, but remains non-atomic; after an unknown/partial result inspect the receipt and state, never replay.

## Indicator: latest saved reading, not a live message

```json
{
  "version": 1,
  "widgets": [{
    "key": "status",
    "type": "indicator",
    "settings": {
      "name": "Line status",
      "deviceId": "4",
      "primaryMetric": "86",
      "primaryLabel": "Current state",
      "fontSize": 1.2,
      "conditions": [{
        "isColor": true,
        "color": "#008800",
        "formula": [{"metric":{"id":"86"},"operator":"=","value":"1","contact":null}]
      }]
    }
  }]
}
```

Replace example IDs/values with discovered data. The selected source must be attached to the dashboard. All primary/secondary, table and condition metrics must belong to that source. `siteId` is filled from verified context. Keep the metric's actual data type/allowed values; numeric/list equality is `=`, text equality is `EQUALS`. Multi-row conditions use `AND`/`OR` on every row except the last, whose `contact` is null.

Optional settings: `secondaryMetric`, labels, `withMetricName`, `withSecondaryName`, `isPrimaryComma`, `isSecondaryComma`, `withTime`, `withSubmitter`, `isCenterLabel`, `hideHeader`, font size 0.5–3. Table mode uses `displayAsTable: true` and ordered `tableMetrics: [{"metricId":"86","displayName":"State"}]` (stored metric-ID strings are also accepted). Conditions may set hex text/background colors and explicit browser popup alerts, with optional auto-dismiss. The preview reports `browserAlerts`; do not add alerts unless requested. Form popups/customization are excluded. Lookup configs must match the selected metric's discovered schema and reference an attached source.

For updates, include `widgetId`, `type`, `key`, `settings.name` and only changed settings. Omitted indicator settings are preserved from the read-back, including color rules and table order; `conditions: []` explicitly clears the rules. Changing device revalidates all retained metric references. For example, a font-size-only edit does not reset conditions. Widget/component/argument range overrides are preserved.

The saved type is `11` / `KpiLastReading`, component/argument `13` / `LastReading`, with settings in the argument's `filters`. This differs from a type-22 live-data tile. Check freshness in the browser; a last reading is not proof the device is online.

## Shortcuts: ordered native navigation

```json
{
  "version": 1,
  "widgets": [{
    "key": "reports",
    "type": "shortcuts",
    "settings": {
      "name": "Reports",
      "hideHeader": false,
      "shortcuts": [
        {"title":"Production","dashboardId":"12"},
        {"title":"Old calibration","url":"https://example.com/saved-report","description":"Previous report","displayModeId":"1"}
      ]
    }
  }]
}
```

Each entry has exactly one `dashboardId` or `url`, a title, optional description, and optional `displayModeId: "1"` (new tab); null/omitted means same tab. Dashboard targets are read and checked for same-site membership, including classic dashboards. HTTP(S) links preserve the supplied URL exactly; credential-bearing and executable URLs are refused. Navigation dashboards need no attached data sources. Maximum 20 shortcuts and 50 distinct dashboard target reads per batch. Forms/documents are not in this authoring contract.

An update with `widgetId` replaces the complete ordered shortcut list. Read the existing widget first; retain unrelated links and original URLs, and preserve requested ordering such as old calibration links last. The native payload has one component per link, type `9`, with a `CallToAction` argument type `11`; it does not put shortcuts in analytical settings. `hideHeader` lives in the first argument's filters. This edits links, not their destinations. For changing only existing dashboard target IDs/text, `dashboards edit` remains available.

## Layout failures

A settings-only batch sends no layout update. For additions/moves, preview validates the entire outgoing layout before any writes. If an old phone/tablet row is out of bounds, use `dashboards edit` with `"copyLayout":{"from":"lg","to":["md","sm","xs"]}` (include `xxs` when present) or exact rows, preview/apply, then fetch fresh widget context. This preserves unrelated widget settings. Browser use is for checking the result.
