import { type GeoPoint, type TripCard } from '@voyago/shared';
import { Linking, StyleSheet, Text, View } from 'react-native';
import { spacing, typography } from '../theme/tokens';
import { useTheme } from '../theme/use-theme';
import { Button, FormMessage } from './Form';

/**
 * Web build: the native map isn't available, so list the meeting areas with links that open
 * Google Maps at the approximate point.
 */
export function TripMap({ trips }: { trips: TripCard[]; centre: GeoPoint | null }) {
  const { colors } = useTheme();
  return (
    <View style={styles.wrap}>
      <FormMessage tone="info">
        The interactive map is in the Voyago app. Here you can open each meeting area in Google
        Maps.
      </FormMessage>
      {trips.map((trip) => (
        <View key={trip.id} style={styles.row}>
          <Text style={[styles.body, { color: colors.text }]} numberOfLines={1}>
            {trip.title}: near {trip.origin.name}
          </Text>
          <Button
            title="Open area in Google Maps"
            variant="link"
            onPress={() =>
              void Linking.openURL(
                `https://www.google.com/maps/search/?api=1&query=${trip.origin.point.latitude},${trip.origin.point.longitude}`,
              )
            }
          />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.sm },
  row: { gap: 0 },
  body: { ...typography.body },
});
