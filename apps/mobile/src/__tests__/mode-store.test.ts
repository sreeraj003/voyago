import { useModeStore } from '../store/mode-store';

describe('mode store', () => {
  afterEach(() => useModeStore.setState({ mode: 'RIDE' }));

  it('starts in Ride mode', () => {
    expect(useModeStore.getState().mode).toBe('RIDE');
  });

  it('switches to Travel mode', () => {
    useModeStore.getState().setMode('TRAVEL');
    expect(useModeStore.getState().mode).toBe('TRAVEL');
  });
});
