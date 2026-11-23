import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { ACCOUNT_DELETION_ERASED, ACCOUNT_DELETION_KEPT } from '@voyago/shared';
import { router } from 'expo-router';
import AccountScreen from '../../app/me/account';
import { deleteAccount, getDeletionStatus } from '../api/account';
import { ApiRequestError } from '../api/http';

jest.mock('../api/account', () => ({
  deleteAccount: jest.fn(),
  exportMyData: jest.fn(),
  getDeletionStatus: jest.fn(),
}));
jest.mock('expo-router', () => ({ router: { replace: jest.fn() } }));
jest.mock('react-native-safe-area-context', () => {
  const { View } = jest.requireActual<{ View: unknown }>('react-native');
  return { SafeAreaView: View };
});

const base = {
  passwordRequired: true,
  erased: ACCOUNT_DELETION_ERASED,
  kept: ACCOUNT_DELETION_KEPT,
};

async function renderScreen() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  await render(
    <QueryClientProvider client={client}>
      <AccountScreen />
    </QueryClientProvider>,
  );
}

describe('AccountScreen', () => {
  afterEach(() => jest.clearAllMocks());

  it('lists what must be settled before deleting, with no delete button', async () => {
    jest.mocked(getDeletionStatus).mockResolvedValue({
      ...base,
      canDelete: false,
      blockers: [{ code: 'OPEN_BOOKINGS', message: 'Cancel your upcoming bookings first.' }],
    });
    await renderScreen();
    expect(await screen.findByText('• Cancel your upcoming bookings first.')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Delete my account' })).toBeNull();
  });

  it('deletes only after DELETE is typed, then leaves for sign-in', async () => {
    jest.mocked(getDeletionStatus).mockResolvedValue({ ...base, canDelete: true, blockers: [] });
    jest.mocked(deleteAccount).mockResolvedValueOnce();
    await renderScreen();
    const button = await screen.findByRole('button', { name: 'Delete my account' });
    expect(button).toBeDisabled();
    await fireEvent.changeText(screen.getByLabelText('Password'), 'secret');
    await fireEvent.changeText(screen.getByLabelText('Type DELETE to confirm'), 'DELETE');
    await fireEvent.press(screen.getByRole('button', { name: 'Delete my account' }));
    expect(deleteAccount).toHaveBeenCalledWith({ confirm: 'DELETE', password: 'secret' });
    expect(router.replace).toHaveBeenCalledWith('/sign-in');
  });

  it('shows the server’s reason when the password is wrong', async () => {
    jest.mocked(getDeletionStatus).mockResolvedValue({ ...base, canDelete: true, blockers: [] });
    jest
      .mocked(deleteAccount)
      .mockRejectedValueOnce(new ApiRequestError(401, 'The password is not right'));
    await renderScreen();
    await fireEvent.changeText(await screen.findByLabelText('Password'), 'nope');
    await fireEvent.changeText(screen.getByLabelText('Type DELETE to confirm'), 'DELETE');
    await fireEvent.press(screen.getByRole('button', { name: 'Delete my account' }));
    expect(await screen.findByText('The password is not right')).toBeOnTheScreen();
    expect(router.replace).not.toHaveBeenCalled();
  });
});
