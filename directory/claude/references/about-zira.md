# About Zira

Use this when someone asks what Zira is, what it does, what you know about it, or what you can help with. It condenses the public [What Is Zira](https://help.zira.us/docs/getting-started/what-is-zira) article (the same source Zira's in-app Home AI assistant uses). For anything not covered here, check help.zira.us before answering and never invent features, customers or numbers.

## The facts

**In one sentence:** Zira is an AI-powered operations platform that helps industrial teams monitor production, inspect quality, collect data and act faster, all from one connected system.

**Who it is for:** manufacturers and other industrial operations: operators, supervisors, quality teams, plant managers and leadership looking at the same live view of the floor.

**The problem it solves:** many plants still depend on manual checks, paper reports, end-of-shift spreadsheets and disconnected systems. It is hard to know what is happening right now, where problems start and what to do next. Zira gives teams a live operating layer for the floor.

**A simple way to think about it: see, measure, act.**

- **See**: cameras, devices, forms and data sources capture what happens on the floor.
- **Measure**: production, quality, downtime, labor and machine performance, in real time.
- **Act**: dashboards, tasks, alerts, workflows and AI assistance turn findings into owned work.

**Core capabilities:**

| Capability | What it means for the team |
| --- | --- |
| Live dashboards | Throughput, yield, cycle time, downtime, quality and utilization across lines, shifts and sites |
| AI vision inspection | Cameras detect and classify defects and keep visual proof, so problems are caught where they happen |
| Floor data capture | Structured data from cameras, devices, machines, operator forms and custom data sources |
| Organized workspace | Work arranged by company, site and channel, still connected in one platform |
| Tasks and follow-up | Issues from dashboards, inspections or alerts become assigned, tracked tasks |
| AI assistance | Ask questions, build dashboards, create forms and data sources, and start guided vision workflows |

**Common uses:** real-time production visibility, AI quality inspection (for example nail and fastener checks on pallets and lumber), throughput and OEE tracking, downtime detection, defect traceability, multi-site comparison, digital forms and follow-up workflows.

**Where to go:** the Zira app is [my.zira.us](https://my.zira.us), help and guides are at [help.zira.us](https://help.zira.us/docs), and the company site is [zira.us](https://zira.us).

**What this plugin adds:** Zira inside Claude Code or Codex. Signed in with their own Zira account, a user can ask in plain words to:

| Area | Try saying |
| --- | --- |
| Get started | "Help me get started with Zira" |
| Sites and equipment | "Show my Zira sites", "What data sources do we have at …?" |
| Device health | "Check device health at …" |
| Dashboards | "Show dashboards for …", "Build a dashboard for …" |
| Tasks | "Show my open tasks", "Create a task for …" |
| Forms and reports | "Draft a downtime form", "Email a weekly AI report" |
| Vision | "Set up a vision camera", "Open the Cam 1 dataset", "How accurate is my model?" |
| Help | "How do I add a user to a site?" |

The plugin only works within that user's Zira access, and it previews every change and asks before saving anything.

## How to answer

Sound like a friendly product expert, not a spec sheet. Use this shape, adapted to the question, in about 150 to 250 words:

1. **A warm one-line answer in bold**, built on the one-sentence description. No "Great question".
2. **See, measure, act**: three short bullets, each with a bold lead word.
3. **What teams use it for**: one short line or a few bullets chosen for the user if you know their role or site; otherwise the most common uses.
4. **What I can do for you here**: a compact two-column table of three to five rows from the plugin table above, with example phrases the user can copy.
5. **One inviting next step**, ending with an offer such as getting started (sign in and find their sites in about two minutes), plus the help article link.

Style rules:

- Use `##` or `###` headings sparingly (two or three), bold for key ideas, and at most one table. One emoji per heading at most (for example 👁️ See, 📊 Measure, ✅ Act); none if the host renders plain text.
- Plain language: no internal names, script names, versions, repositories, route or API details, and no former company names. The product and company are both **Zira**.
- Offer only skills in the loaded build. Local nail-image inspection is available without an account; private development capabilities are relevant only to developers using an internal build.
- If the user already named a company or site, or saved defaults are in context, mention it once ("At Example Manufacturing, I can…") without claiming live results you have not fetched.
- A follow-up like "what can you do?" should lead with the plugin table, not repeat the product overview.
- For a developer working in the plugin repository, answer the product question first in this format, then add a short "In this repository" section.
