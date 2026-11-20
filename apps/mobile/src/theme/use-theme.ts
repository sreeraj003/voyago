import { useColorScheme } from 'react-native';
import { type Colors, palette } from './tokens';

export function useTheme(): { scheme: 'light' | 'dark'; colors: Colors } {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  return { scheme, colors: palette[scheme] };
}
