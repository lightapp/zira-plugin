# Writing an AI report sample in chat

Before anything is saved, the user sees a sample of the report written the way Zira writes each
scheduled run. These rules mirror Zira's report writer (zira-web `src/components/agents/utils.ts`,
`getMessages`); keep them in step with it.

## Data

Use the preview's `sample` block (`ai-report.mjs create|draft` without `--apply`, or `show`):

- For each entry in `sample.requests`, run health-report's reader from the invoking skill directory:
  `node ../health-report/scripts/health-report.mjs agent-data --dashboard-id ID --widget-ids ID,ID --from FROM --to TO --interval "INTERVAL" --company-id ID --site-id ID --profile prod`
  with `from`, `to` and `interval` from `sample`.
- Write only from what it returns. `missing` or `ambiguous` widgets and `status: unavailable` are
  unavailable data, not zero. Never invent values, targets or comparisons, and never compare with an earlier period: the scheduled run reads only the covered period.
- `sample.clipped` means the period is longer than seven days; the sample uses the latest seven days.
  Say so under the sample.
- `sample.notSampled` widgets are read by Zira's run but not by the sample reader. Name them under
  the sample.
- If the reader fails (for example HTTP 503) or returns nothing, still show the report's layout with
  `—` in place of each value. Say plainly that live values could not be read, so the sample shows
  the layout only.

## Writing it

Follow the report's `question` exactly, then these rules, as Zira does:

- Answer directly, with no introduction. Never mention the answer styles or how you are answering.
- Apply every chosen `answerStyle` strictly: Use Emojis, Use Table, Write Shortly, Use Bullet Points,
  Include Comparisons, Use Colors, Drill down.
- State the covered period in a heading or the opening line, with its dates, for example
  “**Last week (28 Sep – 4 Oct)**”. For today, this week or this month, say it runs up to the send time.
- Write Markdown: headings, lists, bold and tables where they fit.
- Colours: Zira wraps a highlighted value in `<span style="color:…">`, green (#5fdd8f) for good,
  yellow for medium and red (#ff5555) for bad. Chat does not render that HTML, so show the value
  with 🟢, 🟡 or 🔴 in front, and say once that these appear as coloured text in the report.
- When every widget is empty, the whole report is exactly:
  **"No data available for the provided chart. Try to change the time range."**
  When only some are empty, answer from the rest and name the empty ones in one short line.

## Showing it

Put the sample between two lines: `**Sample report**`, the time the data was read, then a
horizontal rule; after the sample, another rule. Render it as Markdown, not inside a code block.
Then say in one line that each scheduled run is written fresh by Zira's AI from that run's data,
so the numbers and wording change, but the content, layout and style follow these instructions.
Ask whether to keep it or change it. After any change to the instructions, style, widgets or
period, write a new sample before asking to save.
