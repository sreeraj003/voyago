import { geographyPoint, setPointSql } from './geo.js';

describe('geo helpers', () => {
  it('binds coordinates as parameters in longitude, latitude order', () => {
    const sql = geographyPoint({ latitude: 12.9716, longitude: 77.5946 });
    expect(sql.sql).toContain('ST_MakePoint(?, ?)');
    expect(sql.values).toEqual([77.5946, 12.9716]);
  });

  it('rejects out-of-range coordinates before building SQL', () => {
    expect(() => geographyPoint({ latitude: 91, longitude: 0 })).toThrow();
  });

  it('only writes whitelisted geography columns', () => {
    const sql = setPointSql('trips', 'origin', '00000000-0000-0000-0000-000000000001', {
      latitude: 13.37,
      longitude: 77.68,
    });
    expect(sql.sql).toContain('UPDATE "trips" SET "origin"');
    expect(() =>
      // @ts-expect-error: not a geography column
      setPointSql('trips', 'title', '00000000-0000-0000-0000-000000000001', {
        latitude: 0,
        longitude: 0,
      }),
    ).toThrow('not a writable geography column');
  });
});
