// Recurring report schedules shared by the scheduling skills. A schedule is chosen in the
// site's (or user's) IANA time zone; host schedulers such as the Claude desktop app evaluate
// cron in the computer's own zone, so `hostCron` translates it and says when the two drift.
// Nothing here creates a job: the skill hands the result to the host's scheduler.

export const FREQUENCIES = ["daily", "weekdays", "weekly"];
export const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export function validZone(zone) {
  if (typeof zone !== "string" || !zone) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone }).format();
    return true;
  } catch {
    return false;
  }
}

// { frequency, time: "HH:MM", timezone, day? } -> normalized copy; throws a user-readable error.
export function checkSchedule(s) {
  const frequency = s?.frequency ?? "daily";
  if (!FREQUENCIES.includes(frequency)) throw new Error(`frequency must be ${FREQUENCIES.join(", ")}`);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s?.time ?? "")) throw new Error("time must be HH:MM (24-hour)");
  if (!validZone(s?.timezone)) throw new Error("timezone must be an IANA name such as America/Chicago");
  const out = { frequency, time: s.time, timezone: s.timezone };
  if (frequency === "weekly") {
    const day = String(s.day ?? "").toLowerCase().slice(0, 3);
    if (!DAYS.includes(day)) throw new Error("weekly schedules need day: mon, tue, wed, thu, fri, sat or sun");
    out.day = day;
  }
  return out;
}

// Wall-clock parts of an instant in a zone.
function parts(ms, zone) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, wd: DAYS.indexOf(p.weekday.toLowerCase().slice(0, 3)) };
}

const offsetMin = (ms, zone) => {
  const p = parts(ms, zone);
  return Math.round((Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - Math.floor(ms / 60000) * 60000) / 60000);
};

// The instant a zone's wall clock shows y-mo-d h:mi (first match across a DST change).
function instantAt(y, mo, d, h, mi, zone) {
  let t = Date.UTC(y, mo - 1, d, h, mi);
  for (let i = 0; i < 3; i++) t = Date.UTC(y, mo - 1, d, h, mi) - offsetMin(t, zone) * 60000;
  return t;
}

const shiftDays = (list, by) => list.map(x => (x + by + 7) % 7).sort((a, b) => a - b);
const dayField = list => {
  if (list.length === 7) return "*";
  const runs = [];
  for (const x of list) {
    const last = runs.at(-1);
    if (last && x === last[1] + 1) last[1] = x;
    else runs.push([x, x]);
  }
  return runs.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(",");
};

// Cron for the host computer's zone, plus a note when the site and host change clocks on
// different dates (then the run moves by the difference for part of the year).
export function hostCron(schedule, { hostZone = Intl.DateTimeFormat().resolvedOptions().timeZone, now = Date.now() } = {}) {
  const s = checkSchedule(schedule);
  const [h, mi] = s.time.split(":").map(Number);
  const today = parts(now, s.timezone);
  const at = instantAt(today.y, today.mo, today.d, h, mi, s.timezone);
  const there = parts(at, s.timezone), here = parts(at, hostZone);
  const shift = (here.wd - there.wd + 7) % 7 === 6 ? -1 : (here.wd - there.wd + 7) % 7;
  const days = s.frequency === "daily" ? [0, 1, 2, 3, 4, 5, 6] : s.frequency === "weekdays" ? [1, 2, 3, 4, 5] : [DAYS.indexOf(s.day)];
  const cron = `${here.mi} ${here.h} * * ${dayField(shiftDays(days, shift))}`;
  // Weekly samples over the coming year catch clock changes a week or more apart.
  const drift = Array.from({ length: 53 }, (_, i) => now + i * 7 * 86400e3)
    .map(t => offsetMin(t, s.timezone) - offsetMin(t, hostZone));
  const varies = new Set(drift).size > 1;
  return {
    cron, hostZone, schedule: s,
    describe: describeSchedule(s),
    note: varies
      ? `${s.timezone} and this computer (${hostZone}) change clocks on different dates, so for part of the year the run starts up to ${Math.max(...drift) - Math.min(...drift)} minutes off ${s.time} site time. Update the job after a clock change if exact timing matters.`
      : null,
  };
}

export function describeSchedule(s) {
  const when = s.frequency === "daily" ? "Every day" : s.frequency === "weekdays" ? "Weekdays (Mon-Fri)" : `Every ${s.day[0].toUpperCase()}${s.day.slice(1)}`;
  return `${when} at ${s.time} ${s.timezone}`;
}

// Next run instant for a schedule, for display ("next run Tue 07:00 CDT").
export function nextRun(schedule, now = Date.now()) {
  const s = checkSchedule(schedule);
  const [h, mi] = s.time.split(":").map(Number);
  const allowed = s.frequency === "daily" ? [0, 1, 2, 3, 4, 5, 6] : s.frequency === "weekdays" ? [1, 2, 3, 4, 5] : [DAYS.indexOf(s.day)];
  const p = parts(now, s.timezone);
  for (let i = 0; i < 8; i++) {
    const d = new Date(Date.UTC(p.y, p.mo - 1, p.d + i));
    const t = instantAt(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), h, mi, s.timezone);
    if (t > now && allowed.includes(d.getUTCDay())) return new Date(t).toISOString();
  }
  return null;
}

// Kebab-case job names: also the host task ID and the saved file name.
export const JOB_NAME = /^[a-z0-9][a-z0-9-]{0,59}$/;
export const jobSlug = value => String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "report";
