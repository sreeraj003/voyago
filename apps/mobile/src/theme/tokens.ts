/** Design tokens shared by every screen. Light and dark palettes use the same keys. */
export const palette = {
  light: {
    background: '#F7F7F5',
    surface: '#FFFFFF',
    text: '#16181D',
    textMuted: '#5F6673',
    border: '#E3E4E8',
    ride: '#E2572B',
    travel: '#1E8C8A',
    onAccent: '#FFFFFF',
    success: '#1F8A4C',
    danger: '#C2362B',
  },
  dark: {
    background: '#0F1115',
    surface: '#181B21',
    text: '#ECEEF2',
    textMuted: '#9AA1AD',
    border: '#2A2E37',
    ride: '#FF7A4D',
    travel: '#3CC2BF',
    onAccent: '#0F1115',
    success: '#4CC27F',
    danger: '#FF7A6E',
  },
} as const;

export type ColorScheme = keyof typeof palette;
export type Colors = { [K in keyof (typeof palette)['light']]: string };

export const spacing = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 } as const;
export const radius = { sm: 8, md: 12, lg: 20, pill: 999 } as const;
export const typography = {
  title: { fontSize: 28, fontWeight: '700' },
  heading: { fontSize: 20, fontWeight: '600' },
  body: { fontSize: 16, fontWeight: '400' },
  caption: { fontSize: 13, fontWeight: '400' },
} as const;
