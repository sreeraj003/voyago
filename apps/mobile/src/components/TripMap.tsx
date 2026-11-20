import { type GeoPoint, type TripCard } from '@voyago/shared';
import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import MapView, { Circle, Marker } from 'react-native-maps';
import { spacing, typography } from '../theme/tokens';
import { useTheme } from '../theme/use-theme';

const BENGALURU: GeoPoint = { latitude: 12.9716, longitude: 77.5946 };

/**
 * Map of results. Meeting points are approximate, so each trip is drawn as a 1 km circle with a
 * marker, never as an exact pin. Uses Google Maps on Android and Apple Maps on iOS.
 */
export function TripMap({ trips, centre }: { trips: TripCard[]; centre: GeoPoint | null }) {
  const { colors } = useTheme();
  const focus = centre ?? trips[0]?.origin.point ?? BENGALURU;
  return (
    <View style={styles.wrap}>
      <MapView
        style={styles.map}
        initialRegion={{ ...focus, latitudeDelta: 0.6, longitudeDelta: 0.6 }}
        showsUserLocation={false}
        accessibilityLabel="Map of trip meeting areas"
      >
        {trips.map((trip) => (
          <View key={trip.id}>
            <Circle
              center={trip.origin.point}
              radius={1000}
              strokeColor={trip.mode === 'RIDE' ? colors.ride : colors.travel}
              fillColor="rgba(30,140,138,0.12)"
            />
            <Marker
              coordinate={trip.origin.point}
              title={trip.title}
              description={`Meets near ${trip.origin.name}`}
              pinColor={trip.mode === 'RIDE' ? colors.ride : colors.travel}
              onCalloutPress={() => router.push(`/trips/${trip.id}`)}
            />
          </View>
        ))}
      </MapView>
      <Text style={[styles.caption, { color: colors.textMuted }]}>
        Circles show the meeting area. The exact spot is shared with people on the trip.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.xs },
  map: { width: '100%', height: 420, borderRadius: 12 },
  caption: { ...typography.caption },
});
