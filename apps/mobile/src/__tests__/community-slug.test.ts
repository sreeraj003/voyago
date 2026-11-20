import { slugify } from '../communities/slug';

describe('slugify', () => {
  it('turns a name into a community address', () => {
    expect(slugify('Nandi Hills Riders!')).toBe('nandi-hills-riders');
    expect(slugify('  Coorg -- Trekkers  ')).toBe('coorg-trekkers');
    expect(slugify('Café Racers')).toBe('cafe-racers');
  });

  it('keeps addresses within 60 characters without a trailing hyphen', () => {
    const slug = slugify(`${'a'.repeat(59)} b`);
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith('-')).toBe(false);
  });
});
