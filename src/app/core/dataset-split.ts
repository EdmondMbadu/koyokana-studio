/** Keep alternate takes and duplicate transcripts together, preventing eval leakage. */
export function datasetSplits(
  clips: { id: string; sentenceId: string; text: string }[],
  percent: number,
): Map<string, 'train' | 'eval'> {
  if (!Number.isFinite(percent) || percent <= 0 || percent >= 100) {
    throw new Error('Evaluation percentage must be between 0 and 100.');
  }
  const parent = clips.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const keys = new Map<string, number>();
  const textKeys = clips.map((clip) => clip.text.toLowerCase()
    .replace(/ɛ/g, 'e').replace(/ɔ/g, 'o').replace(/œ/g, 'oe').replace(/æ/g, 'ae')
    .replace(/[’ʼ]/g, "'").replace(/[–—]/g, '-')
    .normalize('NFKD').replace(/\p{M}/gu, '')
    .replace(/[.,;:!?…"«»]/g, ' ').replace(/\s+/g, ' ').trim());
  clips.forEach((clip, i) => {
    for (const key of [`text:${textKeys[i]}`, ...(clip.sentenceId ? [`sentence:${clip.sentenceId}`] : [])]) {
      const previous = keys.get(key);
      if (previous !== undefined) parent[find(i)] = find(previous);
      keys.set(key, i);
    }
  });
  const groupKeys = new Map<number, string>();
  clips.forEach((_, i) => {
    const root = find(i);
    const key = textKeys[i]!;
    const current = groupKeys.get(root);
    if (current === undefined || key < current) groupKeys.set(root, key);
  });
  return new Map(clips.map((clip, i) => {
    const key = groupKeys.get(find(i))!;
    let hash = 0x811c9dc5;
    for (let n = 0; n < key.length; n++) hash = Math.imul(hash ^ key.charCodeAt(n), 0x01000193);
    return [clip.id, (hash >>> 0) % 1000 < percent * 10 ? 'eval' : 'train'];
  }));
}
