import {
  installCrashReporter,
  reportError,
  resetCrashReporter,
  routeFromSegments,
  setCurrentRoute,
  toReport,
} from '../monitoring/crash-reporter';

describe('crash reporter', () => {
  afterEach(() => resetCrashReporter());

  it('reports route patterns without group names or filled-in values', () => {
    expect(routeFromSegments(['(tabs)', 'trips', '[id]'])).toBe('/trips/[id]');
    expect(routeFromSegments([])).toBe('/');
  });

  it('builds a report from the error only', () => {
    setCurrentRoute(['trips', '[id]']);
    const report = toReport(new TypeError('x is undefined'), true);
    expect(report).toMatchObject({
      message: 'TypeError: x is undefined',
      fatal: true,
      route: '/trips/[id]',
    });
    expect(['ios', 'android', 'web']).toContain(report.platform);
    expect(Object.keys(report).sort()).toEqual(
      ['appVersion', 'fatal', 'message', 'platform', 'route', 'stack'].sort(),
    );
  });

  it('posts to the API, swallows failures and stops after ten reports', async () => {
    const fetchImpl = jest.fn(() => Promise.reject(new Error('offline')));
    for (let i = 0; i < 12; i += 1) {
      await expect(reportError(new Error('boom'), false, fetchImpl)).resolves.toBeUndefined();
    }
    expect(fetchImpl).toHaveBeenCalledTimes(10);
    expect(fetchImpl.mock.calls[0]).toEqual([
      expect.stringMatching(/\/client-errors$/),
      expect.objectContaining({ method: 'POST' }),
    ]);
  });

  it('keeps React Native’s own handler running after reporting', () => {
    const previous = jest.fn();
    let installed: ((error: unknown, isFatal?: boolean) => void) | undefined;
    installCrashReporter({
      getGlobalHandler: () => previous,
      setGlobalHandler: (handler) => {
        installed = handler;
      },
    });
    const error = new Error('crash');
    installed!(error, true);
    expect(previous).toHaveBeenCalledWith(error, true);
  });
});
