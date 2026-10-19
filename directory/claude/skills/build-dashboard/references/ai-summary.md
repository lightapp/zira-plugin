# AI summary / AI Insights widget

Use `type: "aiSummary"` for a native AI Insights widget (Zira type `18`, Agent NextGen).
Do not substitute a static report paragraph, a chart's `agentQuestion`, a legacy Agent widget
or an emailed report. The helper saves configuration; Zira generates the answer when rendered
or refreshed. Saving configuration does not verify that generation succeeded.

Read dashboard context first. `aiSummarySources` lists eligible existing Data Research widgets.
Select the smallest set that answers the user's question: totals, relevant distributions and
comparisons. Source selection is explicit; never silently select every widget. Only analytical
type `15` sources in the same dashboard are supported here. The web editor also offers Indicator
and embedded/custom sources; those require separate source-scope support and are not accepted
by this helper. Headers, filters, readings tables and other AI summaries cannot supply context.

## Spec

```json
{
  "version": 1,
  "widgets": [{
    "key": "summary",
    "type": "aiSummary",
    "settings": {
      "name": "Production summary",
      "description": "Explain the selected production totals and length mix.",
      "question": "Summarize the selected range using the supplied widgets. State totals and the dominant lengths, distinguish observations from possible actions, and identify missing evidence. Do not infer current stock from production counts. If data is empty, say so rather than inventing a result.",
      "widgetIds": ["123"],
      "widgetKeys": [],
      "answerStyle": ["Write Shortly", "Use Bullet Points"],
      "answerExample": "",
      "fontSize": 1
    }
  }]
}
```

`123` is illustrative; use an ID from context. `widgetIds` selects saved sources without updating
them. `widgetKeys` selects analytical widgets created or updated in the same batch; the helper
saves those first and replaces keys with returned IDs. Together choose 1–100 distinct sources.
Unknown, foreign, recursive and duplicate sources are rejected before any write.

| Setting | Meaning |
| --- | --- |
| `name`, `description` | Title (up to 120 characters) and purpose (up to 4,000) |
| `question` | Required instruction, up to 16,000 characters; use plain text unless preserving existing editor formatting |
| `widgetIds`, `widgetKeys` | Existing same-dashboard source IDs and local draft keys; defaults to empty arrays |
| `answerStyle` | Unique choices from `Use Emojis`, `Use Table`, `Write Shortly`, `Use Bullet Points`, `Include Comparisons`, `Use Colors`, `Drill down`; defaults to `[]` |
| `answerExample` | Optional saved example, up to 32,000 characters; defaults to empty. The current dashboard renderer does not use it in the generation call. Never store invented production results as an example |
| `fontSize` | Text multiplier, 0.5–3 in 0.1 steps; defaults to 1 |

Draft the question from the actual decision and source capabilities. Include confirmed units,
weighting, time basis and important limitations where needed. Comparisons and drill-down styles
do not supply missing baseline/detail data. For length/inventory questions, observed incoming and
post-cut counts are production flow, not current available stock. Sales suggestions should state
the need to verify physical stock and other suitability constraints rather than assert availability.

## Native payload and edits

The saved envelope is `type:{id:"18",name:"Agent NextGen"}`, with one component and argument
of type `{id:"16",name:"List"}`, placement index 1, `func:null`. The argument's **`filters`**
holds `{question,answerStyle,description,widgetIds,answerExample,fontSize}`. There is no
`nextGenWidgetSettings`, `device`, `agentId`, schedule, recipient or answer-generation call.
Do not use the Data Research payload shape for AI Insights.

For updates, reconstruct complete settings from the widget's name and
`components[0].arguments[0].filters`; retain existing question, styles and source IDs unless
the user requested changes. Supply `widgetId`. The helper preserves range/interval overrides
and existing layout. It verifies saved `filters`, not the chart settings envelope.

Use the same preview/revision/apply/receipt flow as other widgets. Authorization failures must
retain the draft and identify the blocked capability; do not switch to browser writes or other
credentials when the user requested server tooling. Browser inspection may verify rendering
after an authorized save, but it is not the authoring transport. No AI generation, dashboard
mutation or schedule is implied by a request to develop or test the skill itself.

The current plugin helper is a local internal-API client, **not an MCP server**. If the user
specifies MCP, discover a connected Zira server and check its advertised write tools and schemas
before acting. Do not invent tool names or describe CLI calls as MCP. If no suitable MCP tool is
available, report that transport gap and keep the draft; the undeployed read-only zira-mcp
service does not provide widget writes. Production type-18 backend admission was deployed on
2026-10-14; other environments require verification. Deployment/fixture checks alone do not
establish live widget creation or generated-answer correctness.
