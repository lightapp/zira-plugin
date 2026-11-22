# Other widget families and settings

Use this reference to choose an appropriate family and explain its capabilities. The native helper saves analytical widgets, headers, filters, readings tables, AI summaries, indicators and shortcuts (see native-widgets.md and [operational widgets](operational-widgets.md)). Other operational families require Zira's editor; do not send them through an unvalidated raw payload escape hatch or imply they were created. Their web AI support differs from the plugin helper's support.

Source contract: Zira web widget editors and `src/ai/dashboards/widgets/*`, inspected 2026-10-14. UI-only fields can exceed the web AI schema. Use live editor controls as the authority if they differ; never infer missing IDs from another site.

## Indicator (type 11) and Live Data (type 22)

Use `dashboard_widgets` with `type: "indicator"` for last-reading indicators; see [the validated contract](operational-widgets.md). Type 11 uses `filters`, while type 22 uses `nextGenWidgetSettings`. They are different widgets. The existing `dashboards edit` flow handles the documented live-count field edits; creating Live Data is outside the indicator contract.

An Indicator shows latest saved readings; Live Data shows the device's live messages and requires a compatible source. A live message metric is not necessarily a historical meter-schema metric. Discover the appropriate metric catalog and freshness.

Shared settings: `name`, `description`, `deviceId`, `primaryMetric`, `secondaryMetric`, `withMetricName`, `withSecondaryName`, `primaryLabel`, `secondaryLabel`, `isPrimaryComma`, `isSecondaryComma`, `isCenterLabel`, `hideHeader`, `fontSize`, `displayAsTable`, `tableMetrics`, `conditions`. The Indicator also carries `siteId` when needed.

Labels customize displayed text; comma flags control numeric formatting; primary/secondary metrics provide large/small values; `displayAsTable` uses ordered `{metricId,displayName}` rows instead. Font size is a relative multiplier. Conditions contain `formula:[{metric,operator,value,contact}]` (logical connector to the next row, null at the end), `popupAlert`, `popupAlertTitle`, `isColor/color`, `isBackgroundColor/backgroundColor`, `isBackgroundColorAlert/backgroundColorAlert`. Choose operators appropriate to the metric type. Popup conditions have a user-visible side effect; don't enable alerts merely to add a widget.

## Streaming (type 21)

`name`, `description`, `deviceId`, `rotation`. Select an eligible camera; rotation changes presentation. The current editor also supports `showSnapshotName`, `marksOnly` (restrict displayed snapshot context to marks) and `snapshotNamePosition` (`topLeft`, `topRight`, `bottomLeft`, `bottomRight`). Use the editor for these modes. Adding a viewing tile does not authorize remote recording, sampling or camera configuration changes.

## QA snapshots (type 23)

`name`, `description`, `dataSourceId` (eligible VisionHub source), `pageSize` (typically 12/24/48/96), `columnCount` (1–6), `dispositionFilter` (`all|defects`), `defectFilters` (actual defect prefixes), `fontSize` (`small|medium|large`). The editor additionally has `displayMode`, `showMarkButtons`, `showIntersections`. Intersections apply to pallet crossings, mainly single-image mode; gallery/list cards may be too small. The latest AI schema can omit these editor-only review controls. Widget configuration is distinct from marking a real QA image; authoring must not submit review decisions.

## Tasks: list (9), statistics (12), board (13)

These widgets read tasks, not camera readings. `channelIds` uses the available **system IDs** in the web task context despite its name. Shared filters: `status`, `assignee`, `priority`, `createdBy`, `dueDateFrom`, `dueDateTo`, `doneDateFrom`; dates are relative day offsets, null means unbounded. Statuses commonly 5 Open, 10 In Progress, 15 On Hold, 20 Done; resolve actual context. Don't invent member/system IDs or enable notification actions.

List: `name`, shared filters, `sortByValue` (`status.id|priority.id|dueDate|auditInfo.createdDate|auditInfo.lastModifiedDate`), `sortDirection` (`asc|desc`), `columns` from `name,assignee,system,status,priority,dueDate,modifiedDate,createdDate,timeSpent,doneDate,actions`.

Board: list sorting plus `groupByValue` (`task_status_id|task_priority_id|assignee_id|system_id|due_date_this_week|due_date_next_week`); `excludeDueDates` contains 0 Sunday…6 Saturday for due-date grouping.

Statistics: `groupByValue` (`task_status_id|task_priority_id|assignee_id|system_id`), `chartType` (`pie|columns`), `labelKey` (`numberOfTasks|totalTimeSpent`). Count versus logged work hours are different measures. These enums differ from Data Research numeric chart IDs. Hashtags are not currently supported by the web AI task schema.

## Shortcuts (7), Feed (14), embedded/custom (19)

Use `dashboard_widgets` with `type: "shortcuts"` to create or replace ordered dashboard/HTTP(S) links, including adding/removing/reordering individual links; see [the validated contract](operational-widgets.md). Forms and documents remain outside that contract. The web AI schema instead uses `name,description,hideHeader,shortcuts:[{title,description,targetKey,displayModeId}]`. `targetKey` resolves to an actual dashboard/form/document/web destination in context; the persisted call-to-action envelope is not a Data Research setting. Links don't execute the destination workflow.

Feed: choose an accessible channel and filters for alerts, reports, people, tasks and hashtags. The editor stores feed-specific filters; don't reuse reading metric/operator IDs. A feed view does not post a message or subscribe recipients.

AI Insights (18) is covered by the helper's `aiSummary` family. Read [AI summary settings and payload](ai-summary.md) for source selection, the distinct `filters` envelope and backend/transport prerequisites. Do not route it to the web editor as an unsupported family.

Embedded/custom (type 19): the helper supports both modes as `embedded` and `custom`. Read [company-level dashboards](company-dashboards.md). Data Research component IDs 8/9 are these modes, not standard analytics chart types. They are not arbitrary HTML/JavaScript execution. Prefer a native `dataResearch` widget when the dashboard's own site sources answer the question; use `custom` when a chart needs data sources from several sites, and `embedded` to reuse a chart that already exists on another dashboard.
