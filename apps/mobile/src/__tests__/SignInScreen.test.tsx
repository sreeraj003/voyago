import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react-native';
import SignInScreen from '../../app/(auth)/sign-in';
import { getAuthMethods, signIn } from '../api/auth';
import { ApiRequestError } from '../api/http';

jest.mock('../api/auth', () => ({ signIn: jest.fn(), getAuthMethods: jest.fn() }));
jest.mock('expo-router', () => ({ router: { navigate: jest.fn() } }));
jest.mock('react-native-safe-area-context', () => {
  const { View } = jest.requireActual<{ View: unknown }>('react-native');
  return { SafeAreaView: View };
});

const mockedSignIn = jest.mocked(signIn);

function renderScreen() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  return render(
    <QueryClientProvider client={client}>
      <SignInScreen />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  jest.mocked(getAuthMethods).mockResolvedValue({
    password: true,
    phoneOtp: false,
    google: false,
    apple: false,
    emailDelivery: false,
  });
});

describe('SignInScreen', () => {
  it('signs in with the entered credentials', async () => {
    mockedSignIn.mockResolvedValueOnce();
    await renderScreen();
    await fireEvent.changeText(screen.getByLabelText('Email'), ' rider@example.com ');
    await fireEvent.changeText(screen.getByLabelText('Password'), 'a long password');
    await fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));
    expect(mockedSignIn).toHaveBeenCalledWith('rider@example.com', 'a long password');
  });

  it('shows the generic error from the server', async () => {
    mockedSignIn.mockRejectedValueOnce(new ApiRequestError(401, 'Invalid email or password'));
    await renderScreen();
    await fireEvent.changeText(screen.getByLabelText('Email'), 'rider@example.com');
    await fireEvent.changeText(screen.getByLabelText('Password'), 'wrong password');
    await fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password');
  });

  it('hides Google and Apple buttons while their keys are not set', async () => {
    await renderScreen();
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Continue with Google' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Continue with Apple' })).toBeNull();
  });
});
