import { ApiStatus } from '../../src/components/ApiStatus';
import { ComingSoon } from '../../src/components/ComingSoon';
import { Screen } from '../../src/components/Screen';

export default function ProfileScreen() {
  return (
    <Screen title="Profile">
      <ApiStatus />
      <ComingSoon feature="Sign in, profile and travel preferences" milestone="milestone 4" />
    </Screen>
  );
}
