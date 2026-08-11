export function normalizeTargetCount(value, fallback = 4) {
  const number = Number(value);
  if ([4, 6, 8].includes(number)) return number;
  return [4, 6, 8].includes(Number(fallback)) ? Number(fallback) : 4;
}

export function createSlotAssignments(artifactIds, count) {
  const target = normalizeTargetCount(count);
  const unique = [...new Set((artifactIds || []).map(String))].slice(0, target);
  return Array.from({ length: target }, (_value, index) => unique[index] || null);
}

export function assignArtifact(assignments, artifactId, targetIndex, allowedArtifactIds) {
  const next = [...assignments];
  const id = String(artifactId || '');
  const index = Number(targetIndex);
  const allowed = new Set((allowedArtifactIds || []).map(String));
  if (!id || !allowed.has(id) || !Number.isInteger(index) || index < 0 || index >= next.length) return next;
  const sourceIndex = next.indexOf(id);
  if (sourceIndex === index) return next;
  if (sourceIndex >= 0) {
    const displaced = next[index] || null;
    next[index] = id;
    next[sourceIndex] = displaced;
  } else {
    next[index] = id;
  }
  return next;
}

export function moveSlot(assignments, sourceIndex, targetIndex) {
  const next = [...assignments];
  const source = Number(sourceIndex);
  const target = Number(targetIndex);
  if (![source, target].every((index) => Number.isInteger(index) && index >= 0 && index < next.length) || source === target) return next;
  [next[source], next[target]] = [next[target], next[source]];
  return next;
}

export function clearSlot(assignments, index) {
  const next = [...assignments];
  const target = Number(index);
  if (Number.isInteger(target) && target >= 0 && target < next.length) next[target] = null;
  return next;
}

export function validateSlotAssignments(assignments, selectedArtifactIds, count) {
  const target = normalizeTargetCount(count);
  const selected = new Set((selectedArtifactIds || []).map(String));
  if (!Array.isArray(assignments) || assignments.length !== target) return false;
  if (assignments.some((id) => !id || !selected.has(String(id)))) return false;
  return new Set(assignments.map(String)).size === assignments.length;
}
