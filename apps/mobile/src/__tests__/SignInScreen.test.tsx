import { fireEvent, render, screen } from '@testing-library/react-native';
import SignInScreen from '../../app/(auth)/sign-in';
import { signIn } from '../api/auth';
import { ApiRequestError } from '../api/http';

jest.mock('../api/auth', () => ({ signIn: jest.fn() }));
jest.mock('expo-router', () => ({ router: { navigate: jest.fn() } }));
jest.mock('react-native-safe-area-context', () => {
  const { View } = jest.requireActual<{ View: unknown }>('react-native');
  return { SafeAreaView: View };
});

const mockedSignIn = jest.mocked(signIn);

describe('SignInScreen', () => {
  it('signs in with the entered credentials', async () => {
    mockedSignIn.mockResolvedValueOnce();
    await render(<SignInScreen />);
    await fireEvent.changeText(screen.getByLabelText('Email'), ' rider@example.com ');
    await fireEvent.changeText(screen.getByLabelText('Password'), 'a long password');
    await fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));
    expect(mockedSignIn).toHaveBeenCalledWith('rider@example.com', 'a long password');
  });

  it('shows the generic error from the server', async () => {
    mockedSignIn.mockRejectedValueOnce(new ApiRequestError(401, 'Invalid email or password'));
    await render(<SignInScreen />);
    await fireEvent.changeText(screen.getByLabelText('Email'), 'rider@example.com');
    await fireEvent.changeText(screen.getByLabelText('Password'), 'wrong password');
    await fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password');
  });
});
