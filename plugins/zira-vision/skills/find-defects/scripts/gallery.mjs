// Pure browser/Node helpers. Display crops never change model inputs or saved box coordinates.
export function contentRect(item, width, height) {
  const pad = item.pad, content = item.content;
  if (!Array.isArray(pad) || !Array.isArray(content) ||
      ![...pad, ...content].every(Number.isFinite) || pad.length !== 2 || content.length !== 2 ||
      pad.some(n => n < 0) || content.some(n => n <= 0) || pad[0] + content[0] > width || pad[1] + content[1] > height)
    return [0, 0, width, height];
  return [...pad, ...content];
}

// What a mark from the gallery decides: every proposal on the image, or the slice itself when nothing was
// found or labeled there. Other images need the image view to choose box by box.
export function galleryKeys(item) {
  if (item.candidates.length) return item.candidates.map((_, i) => String(i));
  return !item.truth?.length && !item.others?.length ? ["slice"] : [];
}

export function galleryOrder(items, decisions, targets, { status = 'all', search = '', sort = 'score-desc' } = {}) {
  const query = search.trim().toLowerCase();
  const score = item => Math.max(0, ...item.candidates.map(c => c.score || 0));
  return items.map((_, i) => i).filter(i => {
    const item = items[i], choices = decisions[item.image]?.boxes || {}, values = Object.values(choices);
    const touched = values.length > 0, pending = item.candidates.some((_, n) => !(String(n) in choices));
    const accepted = values.some(v => targets.includes(v)), unsure = values.includes('skip');
    return item.image.toLowerCase().includes(query) && (status === 'all' ||
      (status === 'todo' && (item.candidates.length ? pending : !touched)) ||
      (status === 'accepted' && accepted) || (status === 'unsure' && unsure) ||
      (status === 'rejected' && touched && !pending && !accepted && !unsure));
  }).sort((a, b) => {
    const names = items[a].image.localeCompare(items[b].image, undefined, { numeric: true });
    if (sort === 'name-asc') return names;
    if (sort === 'name-desc') return -names;
    return (sort === 'score-asc' ? 1 : -1) * (score(items[a]) - score(items[b])) || names;
  });
}
