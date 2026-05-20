import { describe, it, expect } from 'vitest';
import { parseDescription, descriptionLabel } from './description.js';

describe('parseDescription', () => {
  it('splits "[source] label"', () => {
    expect(parseDescription('[cal] арнона')).toEqual({ source: 'cal', label: 'арнона' });
  });

  it('returns the whole string as label when no prefix', () => {
    expect(parseDescription('groceries')).toEqual({ source: '', label: 'groceries' });
  });

  it('tolerates extra whitespace after the prefix', () => {
    expect(parseDescription('[cal]   арнона')).toEqual({ source: 'cal', label: 'арнона' });
  });

  it('requires whitespace between bracket and label', () => {
    // `[cal]X` is not a valid prefix — treat as opaque description.
    expect(parseDescription('[cal]X')).toEqual({ source: '', label: '[cal]X' });
  });

  it('preserves brackets inside the label', () => {
    expect(parseDescription('[cc] groceries [tesco]')).toEqual({
      source: 'cc',
      label: 'groceries [tesco]',
    });
  });

  it('descriptionLabel returns just the label half', () => {
    expect(descriptionLabel('[cal] арнона')).toBe('арнона');
    expect(descriptionLabel('groceries')).toBe('groceries');
  });
});
