import { type GeoPoint, type PlaceSuggestion } from '@voyago/shared';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { getPlace, newSessionToken, searchPlaces } from '../api/maps-media';
import { formatCoords } from '../trips/trip-form';
import { radius, spacing, typography } from '../theme/tokens';
import { useTheme } from '../theme/use-theme';
import { Button, TextField } from './Form';

type Props = {
  label: string;
  name: string;
  coords: string;
  onChange: (value: { name: string; coords: string }) => void;
  searchEnabled: boolean;
  nameError?: string;
  coordsError?: string;
  hint?: string;
};

/**
 * A place: search Google Maps by name (through the API) and pick a result, which fills the
 * coordinates. Coordinates can also be typed, and must be when search isn't configured.
 */
export function PlaceField({
  label,
  name,
  coords,
  onChange,
  searchEnabled,
  nameError,
  coordsError,
  hint,
}: Props) {
  const { colors } = useTheme();
  // Manual entry is chosen by the user; search is also off until the server reports it is set up.
  const [manual, setManual] = useState(false);
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const session = useRef(newSessionToken());

  const searching = searchEnabled && !manual && query.trim().length >= 2;
  const visible = searching ? suggestions : [];

  useEffect(() => {
    if (!searching) return;
    const timer = setTimeout(() => {
      searchPlaces(query.trim(), session.current)
        .then((found) => {
          setSuggestions(found);
          setMessage(found.length === 0 ? 'No places found' : null);
        })
        .catch(() => setMessage('Place search is unavailable. Enter coordinates instead.'));
    }, 300);
    return () => clearTimeout(timer);
  }, [query, searching]);

  const choose = async (suggestion: PlaceSuggestion) => {
    try {
      const place = await getPlace(suggestion.placeId, session.current);
      onChange({ name: place.name, coords: formatCoords(place.point) });
      setQuery('');
      setSuggestions([]);
      session.current = newSessionToken();
    } catch {
      setMessage('Could not load that place. Try again.');
    }
  };

  if (!searchEnabled || manual) {
    return (
      <View style={styles.wrap}>
        <TextField
          label={label}
          value={name}
          onChangeText={(value) => onChange({ name: value, coords })}
          error={nameError}
        />
        <TextField
          label={`${label} coordinates`}
          value={coords}
          onChangeText={(value) => onChange({ name, coords: value })}
          placeholder="13.0358, 77.5970"
          hint={hint ?? 'Latitude, longitude. In Google Maps, long-press a spot to copy them.'}
          error={coordsError}
        />
        {searchEnabled ? (
          <Button title="Search places instead" variant="link" onPress={() => setManual(false)} />
        ) : null}
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      <TextField
        label={label}
        value={query}
        onChangeText={setQuery}
        placeholder={name || 'Search Google Maps'}
        hint={name ? `Selected: ${name} (${coords})` : hint}
        error={nameError ?? coordsError}
      />
      {visible.length > 0 ? (
        <View
          accessibilityRole="list"
          style={[styles.list, { borderColor: colors.border, backgroundColor: colors.surface }]}
        >
          {visible.map((suggestion) => (
            <Pressable
              key={suggestion.placeId}
              accessibilityRole="button"
              accessibilityLabel={`${suggestion.primaryText}${suggestion.secondaryText ? `, ${suggestion.secondaryText}` : ''}`}
              onPress={() => void choose(suggestion)}
              style={[styles.item, { borderBottomColor: colors.border }]}
            >
              <Text style={[styles.primary, { color: colors.text }]}>{suggestion.primaryText}</Text>
              {suggestion.secondaryText ? (
                <Text style={[styles.secondary, { color: colors.textMuted }]}>
                  {suggestion.secondaryText}
                </Text>
              ) : null}
            </Pressable>
          ))}
          <Text style={[styles.attribution, { color: colors.textMuted }]}>Results from Google</Text>
        </View>
      ) : null}
      {searching && message ? (
        <Text style={[styles.secondary, { color: colors.textMuted }]}>{message}</Text>
      ) : null}
      <Button title="Enter coordinates instead" variant="link" onPress={() => setManual(true)} />
    </View>
  );
}

export const pointLabel = (point: GeoPoint | null) => (point ? formatCoords(point) : '');

const styles = StyleSheet.create({
  wrap: { gap: spacing.xs },
  list: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.sm, overflow: 'hidden' },
  item: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    minHeight: 44,
  },
  primary: { ...typography.body },
  secondary: { ...typography.caption },
  attribution: { ...typography.caption, padding: spacing.sm, textAlign: 'right' },
});
