const clock = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23"
});
const time = /^([01]\d|2[0-3]):[0-5]\d$/;

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T00:00:00Z");
  return Number.isFinite(+date) && date.toISOString().slice(0, 10) === value;
}

function windowFor(value, label) {
  if (value?.start === "" && value?.end === "") return null;
  if (typeof value?.start !== "string" || typeof value?.end !== "string" ||
      !time.test(value.start) || !time.test(value.end) || value.start === value.end) {
    throw new Error(label + " needs two different times, or both times blank.");
  }
  return { start: value.start, end: value.end };
}

export function validateSchedule(value) {
  if (!Array.isArray(value?.breaks) || value.breaks.length > 20) {
    throw new Error("You can save up to 20 date ranges.");
  }
  const schoolNights = windowFor(value.schoolNights, "School nights");
  const weekend = windowFor(value.weekend, "Weekend nights");
  const breaks = value.breaks.map((entry) => {
    const name = typeof entry?.name === "string" ? entry.name.trim() : "";
    if (!name || name.length > 60) throw new Error("Give each date range a name of up to 60 characters.");
    if (!validDate(entry.from) || !validDate(entry.through) || entry.from > entry.through) {
      throw new Error("Enter a valid first and last date for " + name + ".");
    }
    return { name, from: entry.from, through: entry.through, hours: windowFor(entry, name) };
  }).sort((a, b) => a.from.localeCompare(b.from));
  if (breaks.some((entry, i) => i > 0 && breaks[i - 1].through >= entry.from)) {
    throw new Error("Date ranges overlap. Each night can belong to one date range.");
  }
  return { schoolNights, weekend, breaks };
}

export function activeBedtime(schedule, now = new Date()) {
  if (!schedule) return null;
  const parts = Object.fromEntries(clock.formatToParts(now).map(({ type, value }) => [type, value]));
  const today = [parts.year, parts.month, parts.day].join("-");
  const current = parts.hour + ":" + parts.minute;
  const date = new Date(today + "T12:00:00Z");
  const night = (day) => {
    const stamp = day.toISOString().slice(0, 10);
    const special = schedule.breaks.find(({ from, through }) => from <= stamp && stamp <= through);
    if (special) return { name: special.name, hours: special.hours };
    const weekend = [5, 6].includes(day.getUTCDay());
    return { name: weekend ? "Weekend nights" : "School nights", hours: weekend ? schedule.weekend : schedule.schoolNights };
  };
  const tonight = night(date);
  date.setUTCDate(date.getUTCDate() - 1);
  const lastNight = night(date);
  const isToday = tonight.hours && current >= tonight.hours.start &&
    (tonight.hours.start > tonight.hours.end || current < tonight.hours.end);
  if (isToday) return { name: tonight.name, end: tonight.hours.end };
  if (lastNight.hours && lastNight.hours.start > lastNight.hours.end && current < lastNight.hours.end) {
    return { name: lastNight.name, end: lastNight.hours.end };
  }
  return null;
}
