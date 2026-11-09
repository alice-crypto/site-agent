const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function localTime(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map(({ type, value }) => [type, value]),
  );
  return {
    day: DAYS.indexOf(parts.weekday.toLowerCase()),
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function toMinutes(hhmm) {
  const [hours, minutes] = hhmm.split(':').map(Number);
  return hours * 60 + minutes;
}

function allowsDay(window, dayIndex) {
  return !window.days || window.days.includes(DAYS[dayIndex]);
}

function inWindow(window, { day, minutes }) {
  const start = toMinutes(window.start);
  const end = toMinutes(window.end);
  if (start <= end) return allowsDay(window, day) && minutes >= start && minutes < end;
  // Plage à cheval sur minuit : « days » désigne le jour où elle commence.
  if (minutes >= start) return allowsDay(window, day);
  return minutes < end && allowsDay(window, (day + 6) % 7);
}

export function scheduleStatus(date, schedule) {
  const now = localTime(date, schedule.timezone);

  const freeze = schedule.freezes.find(({ from, to }) => now.date >= from && now.date <= to);
  if (freeze) return { allowed: false, frozen: true, reason: `gel du ${freeze.from} au ${freeze.to}` };

  if (!schedule.windows.length || schedule.windows.some((window) => inWindow(window, now))) {
    return { allowed: true, frozen: false, reason: null };
  }
  return { allowed: false, frozen: false, reason: 'hors plage autorisée' };
}
