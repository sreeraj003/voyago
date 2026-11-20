import {
  activeFilterCount,
  coarsen,
  dateRange,
  defaultFilters,
  toQueryString,
  toSearchQuery,
} from '../discovery/filters';

describe('discovery filters', () => {
  it('sends only the mode and sort by default, with no location', () => {
    const query = toSearchQuery({
      text: '  ',
      mode: 'RIDE',
      filters: defaultFilters(),
      location: null,
    });
    expect(query).toEqual({ mode: 'RIDE', sort: 'relevance', limit: 20 });
    expect(activeFilterCount(defaultFilters())).toBe(0);
  });

  it('rounds the location to about 100 m before sending it', () => {
    expect(coarsen({ latitude: 12.971612, longitude: 77.594566 })).toEqual({
      latitude: 12.972,
      longitude: 77.595,
    });
    const query = toSearchQuery({
      text: '',
      mode: 'RIDE',
      filters: { ...defaultFilters(), radiusKm: 50, sort: 'proximity' },
      location: { latitude: 12.971612, longitude: 77.594566 },
    });
    expect(query).toMatchObject({ lat: 12.972, lng: 77.595, radiusKm: 50, sort: 'proximity' });
  });

  it('falls back from distance sorting without a location', () => {
    const query = toSearchQuery({
      text: 'coorg',
      mode: 'TRAVEL',
      filters: { ...defaultFilters(), sort: 'proximity' },
      location: null,
    });
    expect(query.sort).toBe('relevance');
    expect(query).not.toHaveProperty('lat');
  });

  it('applies mode-specific filters only to that mode', () => {
    const filters = {
      ...defaultFilters(),
      activityTypes: ['TREK'],
      bikeCategory: 'ADVENTURE',
      engineCc: '350',
      maxBudgetRupees: '1500',
      minSeats: '2',
      difficulty: ['EASY', 'MODERATE'],
      includeFull: true,
    };
    expect(activeFilterCount(filters)).toBe(7);
    const ride = toSearchQuery({ text: '', mode: 'RIDE', filters, location: null });
    expect(ride).toMatchObject({
      bikeCategory: 'ADVENTURE',
      engineCc: 350,
      budgetMaxPaise: 150_000,
      minSeats: 2,
      difficulty: 'EASY,MODERATE',
      status: 'PUBLISHED,FULL',
    });
    expect(ride).not.toHaveProperty('activityType');
    const travel = toSearchQuery({ text: '', mode: 'TRAVEL', filters, location: null });
    expect(travel).toMatchObject({ activityType: 'TREK' });
    expect(travel).not.toHaveProperty('bikeCategory');
    expect(travel).not.toHaveProperty('engineCc');
  });

  it('ignores numbers that are not positive whole numbers', () => {
    const query = toSearchQuery({
      text: '',
      mode: 'RIDE',
      filters: { ...defaultFilters(), maxBudgetRupees: 'abc', minSeats: '1.5', engineCc: '-3' },
      location: null,
    });
    expect(query).toEqual({ mode: 'RIDE', sort: 'relevance', limit: 20 });
  });

  it('turns date windows into ranges', () => {
    const friday = new Date(2026, 10, 20, 10, 0);
    expect(dateRange('any', friday)).toEqual({});
    const weekend = dateRange('weekend', friday);
    expect(new Date(weekend.to ?? '').getDate()).toBe(22);
    const week = dateRange('week', friday);
    expect(new Date(week.to ?? '').getDate()).toBe(27);
  });

  it('builds query strings without empty values', () => {
    expect(toQueryString({ q: 'nandi hills', cursor: undefined, limit: 20, to: '' })).toBe(
      'q=nandi+hills&limit=20',
    );
  });
});
