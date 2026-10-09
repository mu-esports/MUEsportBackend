/** Pack continuous multi-day spans into separate lanes within a Sunday–Saturday week. End dates are inclusive. */
export function calendarSpans<T extends { id: string; start: string; end: string }>(events: T[], week: string[]) {
  const lanes: number[] = []
  return events
    .filter(
      (e) =>
        e.start.slice(0, 10) !== e.end.slice(0, 10) && e.start.slice(0, 10) <= week[6] && e.end.slice(0, 10) >= week[0],
    )
    .sort((a, b) => a.start.localeCompare(b.start) || b.end.localeCompare(a.end) || a.id.localeCompare(b.id))
    .map((event) => {
      const start = event.start.slice(0, 10),
        end = event.end.slice(0, 10)
      const from = week.findIndex((day) => day >= start),
        to = 6 - [...week].reverse().findIndex((day) => day <= end)
      let lane = lanes.findIndex((last) => last < from)
      if (lane < 0) lane = lanes.length
      lanes[lane] = to
      return { event, from, to, lane, continuesBefore: start < week[0], continuesAfter: end > week[6] }
    })
}
