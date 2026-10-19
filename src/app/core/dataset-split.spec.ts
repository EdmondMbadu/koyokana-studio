import { datasetSplits } from './dataset-split';

describe('datasetSplits', () => {
  const clips = [
    { id: 'a', sentenceId: 's1', text: 'Mbote yaya.' },
    { id: 'b', sentenceId: 's1', text: 'Mbote papa.' },
    { id: 'c', sentenceId: 's2', text: 'MBOTE PAPA!' },
    { id: 'd', sentenceId: 's3', text: 'Matondi mingi.' },
  ];
  it('groups repeated takes, duplicate text and transitive links', () => {
    for (let percent = 1; percent < 100; percent++) {
      const split = datasetSplits(clips, percent);
      expect(split.get('a')).toBe(split.get('b'));
      expect(split.get('b')).toBe(split.get('c'));
    }
  });
  it('is independent of input order and clip IDs', () => {
    const normal = datasetSplits(clips, 5);
    const reversed = datasetSplits([...clips].reverse(), 5);
    for (const clip of clips) expect(reversed.get(clip.id)).toBe(normal.get(clip.id));
    expect(datasetSplits([{ ...clips[0]!, id: 'new' }], 5).get('new'))
      .toBe(datasetSplits([clips[0]!], 5).get('a'));
  });
});
