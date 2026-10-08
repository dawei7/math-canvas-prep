import { describe, expect, it } from 'vitest';
import { startsWithHaystack, wordsFit } from '../src/index.js';

describe('the words of a visual record against the text of the region', () => {
  it('finds the first three words as typed, whatever the text layer prints for apostrophes and quotes', () => {
    expect(wordsFit("Exercise 7.3 Euler's formula", 'Exercise 7.3 Euler’s formula (which relates the exponential) states')).toBe(true);
    expect(wordsFit('Exercise 7.3 Euler’s formula', "Exercise 7.3 Euler's formula which relates")).toBe(true);
    expect(wordsFit('Exercise 7.3 "Euler" says', 'Exercise 7.3 “Euler” says that')).toBe(true);
  });

  it('still refuses words that are not there, and finds scrambled or umlaut-split pieces by their words', () => {
    expect(wordsFit('Exercise 7.3 Gauss formula', 'Exercise 7.3 Euler’s formula (which relates')).toBe(false);
    expect(wordsFit('Aufgabe 3 Primzahlen über', 'Aufgabe 3 Primzahlen ¨uber die Menge')).toBe(true);
    expect(wordsFit('formula Exercise 7.3', 'Exercise 7.3 Euler formula')).toBe(true);
  });

  it('looks for the words of a cell without text of its own in the line that comes into it from the left', () => {
    const picture = { text: '', entering: [{ text: 'over 222 .' }] };
    expect(wordsFit('222 .', startsWithHaystack(picture))).toBe(true);
    expect(wordsFit('223 .', startsWithHaystack(picture))).toBe(false);
    // A cell that has text keeps its own text.
    expect(startsWithHaystack({ text: 'Find the sum', entering: [{ text: 'over 222 .' }] })).toBe('Find the sum');
  });
});
