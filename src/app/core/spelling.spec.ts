import { autoFix, checkSpelling } from './spelling';

describe('checkSpelling', () => {
  it('accepts clean Lingala and French loanwords', () => {
    expect(checkSpelling('Mbote! Ozali malamu?')).toEqual([]);
    expect(checkSpelling('Crédit na yo ekomi na compte na yo.')).toEqual([]);
    expect(checkSpelling('S’il vous plaît, zela moke.')).toEqual([]);
  });

  it('flags each rule', () => {
    expect(checkSpelling('Niongo ezali 1500 FC.')).toEqual(['digits', 'abbreviation']);
    expect(checkSpelling('Lɛlɔ')).toContain('open-vowels');
    expect(checkSpelling('mbóka')).toContain('tone-marks');
    expect(checkSpelling('Ezali dix %')).toContain('symbols');
    expect(checkSpelling('Nazali ko kende.')).toContain('spacing');
    expect(checkSpelling('a'.repeat(260))).toContain('too-long');
  });
});

describe('autoFix', () => {
  it('maps open vowels and strips tone marks but keeps French accents', () => {
    expect(autoFix('Mɔ́tɔ akɛ́ndɛ́ lobi.')).toBe('Moto akende lobi.');
    expect(autoFix('mbóka malámu')).toBe('mboka malamu');
    expect(autoFix('Café, déjà, pâte, très')).toBe('Café, déjà, pâte, très');
  });
});
