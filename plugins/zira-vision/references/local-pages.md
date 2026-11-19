# Handing over local pages

Readings reports, health and device-status dashboards, model evaluations and review pages are HTML files on this computer. People come back to them hours or days later, after the chat's helpers and background processes have stopped, so every answer that produces one must leave a link that still works then.

## In the answer

- **End with an "Open" line**, on its own line: `**Open the report:** [<title>](<file URL>)`, using `dashboard`, `evaluation` or `review page` in place of `report` when that's what it is. Use the absolute `file://` URL the helper returned (`url`, `savedUrl`), never a relative path, `~` or a path only in backticks. That saved copy opens without any helper, sign-in or running chat. Escape the title as Markdown link text.
- **When a live page is running** (a served readings report or review page), add it on the same line: `· [live page](<http://127.0.0.1…>)`, plus what it adds, for example "loads more dates while open". Never give only the `127.0.0.1` address; it stops working when its helper stops.
- Say what the saved copy holds (sites, period) so a later reader knows what they are opening.

## Showing it now

Open the page in the host's browser as soon as it exists: the live URL when there is one, otherwise the file. In the Claude desktop app's in-app browser, open the live `127.0.0.1` URL; it may not be allowed to open files in hidden folders such as the readings cache. A live readings report stays up while that page is open and for 2 idle hours after it closes.

## Coming back later

When someone asks for an earlier report ("open last week's Trimsaw report", "the link stopped working"), find it instead of rebuilding: `readings.mjs reports` lists recent readings reports with their saved `url` and any `liveUrl`; dashboards are at the path the skill printed or its fixed `latest` location. To load more dates, run `readings.mjs serve --report <path>` again. It returns the same address the old link used, so an open tab works again after a reload.

## Privacy

These pages hold customer data. Keep them in the plugin's private folders. Do not copy them into a project folder, attach them or publish them to make a link; sharing is a separate step the user asks for (see the skill's sharing guidance).
