import { fireEvent, render, screen } from '@testing-library/react-native';
import { ModeSelector } from '../components/ModeSelector';
import { useModeStore } from '../store/mode-store';

describe('ModeSelector', () => {
  afterEach(() => useModeStore.setState({ mode: 'RIDE' }));

  it('marks Ride as selected by default and switches to Travel on press', async () => {
    await render(<ModeSelector />);
    expect(screen.getByRole('tab', { name: 'Ride' })).toBeSelected();

    await fireEvent.press(screen.getByRole('tab', { name: 'Travel' }));

    expect(useModeStore.getState().mode).toBe('TRAVEL');
    expect(screen.getByRole('tab', { name: 'Travel' })).toBeSelected();
  });
});
