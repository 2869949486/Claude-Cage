export const tokenMetrics = [
  ["total", "全部 Token"], ["input_tokens", "输入"], ["output_tokens", "输出"],
  ["cache_read_input_tokens", "缓存读取"], ["cache_creation_input_tokens", "缓存写入"],
];
export const tokenFields = tokenMetrics.slice(1).map(([key]) => key);
const dayMillis = 86400000;
const isoDate = (millis) => new Date(millis).toISOString().slice(0, 10);
export function localToday() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`;
}
export function metricValue(day, metric) {
  if (!day) return null;
  return metric === "total" ? tokenFields.reduce((sum, field) => sum + (day[field] || 0), 0) : day[metric] || 0;
}
export function summarizeUsage(rows, { model = "all", source = "all" } = {}) {
  const days = new Map();
  for (const row of rows || []) {
    if (model !== "all" && row.model !== model || source !== "all" && row.source !== source) continue;
    const day = days.get(row.date) || { date: row.date, requests: 0, ...Object.fromEntries(tokenFields.map(field => [field,0])) };
    for (const field of [...tokenFields,"requests"]) day[field] += row[field] || 0;
    days.set(row.date, day);
  }
  return days;
}
export function yearCalendar(year) {
  const start = Date.UTC(Number(year), 0, 1);
  const end = Date.UTC(Number(year) + 1, 0, 1);
  const padding = (new Date(start).getUTCDay() + 6) % 7;
  return Array.from({ length: (end - start) / dayMillis }, (_,index) => ({
    date: isoDate(start + index * dayMillis), column: Math.floor((index + padding) / 7), row: (index + padding) % 7,
  }));
}
export function usageSeries(calendar, days, metric, mode, today) {
  const buckets = [];
  for (const item of calendar) {
    if (item.date > today) continue;
    const value = metricValue(days.get(item.date), metric);
    if (mode !== "weekly") buckets.push({ date: item.date, value });
    else {
      let bucket = buckets.at(-1);
      if (!bucket || bucket.column !== item.column) {
        bucket = { date: item.date, value: null, column: item.column };
        buckets.push(bucket);
      }
      if (value !== null) bucket.value = (bucket.value || 0) + value;
    }
  }
  if (mode === "cumulative") {
    let sum = 0, recorded = false;
    return buckets.map(bucket => {
      if (bucket.value !== null) { sum += bucket.value; recorded = true; }
      return { ...bucket, value: recorded ? sum : null };
    });
  }
  return buckets;
}
export function compactTokens(value) {
  return new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}
export function heatLevel(value, max) {
  if (value === null) return -1;
  if (value === 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil(value / Math.max(1,max) * 4)));
}
