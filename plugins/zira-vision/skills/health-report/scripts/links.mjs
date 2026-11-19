export function dataSourceUrl(report, id) {
  const origin = {
    prod: "https://my.zira.us",
    integ: "https://zira-webinteg.zira.us",
  }[report.sourceProfile];
  return origin && /^\d+$/.test(String(id))
    ? `${origin}/data-sources/${id}`
    : null;
}
