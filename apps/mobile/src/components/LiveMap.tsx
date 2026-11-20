import { type SosAlert, type Sharer } from '@voyago/shared';
import { StyleSheet, View } from 'react-native';
import MapView, { Marker } from 'react-native-maps';
import { freshness } from '../safety/live';
import { useTheme } from '../theme/use-theme';

/** Trip members who are sharing, and the location attached to any open SOS. */
export function LiveMap({ sharers, alerts }: { sharers: Sharer[]; alerts: SosAlert[] }) {
  const { colors } = useTheme();
  const points = [
    ...sharers.flatMap((s) => (s.location ? [s.location] : [])),
    ...alerts.flatMap((a) => (a.location ? [a.location] : [])),
  ];
  if (points.length === 0) return null;
  const lats = points.map((p) => p.latitude);
  const lngs = points.map((p) => p.longitude);
  const region = {
    latitude: (Math.min(...lats) + Math.max(...lats)) / 2,
    longitude: (Math.min(...lngs) + Math.max(...lngs)) / 2,
    latitudeDelta: Math.max(0.02, (Math.max(...lats) - Math.min(...lats)) * 1.5),
    longitudeDelta: Math.max(0.02, (Math.max(...lngs) - Math.min(...lngs)) * 1.5),
  };
  return (
    <View style={styles.wrap}>
      <MapView
        style={styles.map}
        initialRegion={region}
        showsUserLocation={false}
        accessibilityLabel="Map of trip members sharing their location"
      >
        {sharers.map((sharer) =>
          sharer.location ? (
            <Marker
              key={sharer.user.id}
              coordinate={sharer.location}
              title={sharer.user.displayName}
              description={freshness(sharer.location.recordedAt).label}
              pinColor={
                freshness(sharer.location.recordedAt).stale ? colors.textMuted : colors.travel
              }
            />
          ) : null,
        )}
        {alerts.map((alert) =>
          alert.location ? (
            <Marker
              key={alert.id}
              coordinate={alert.location}
              title={`SOS: ${alert.user.displayName}`}
              pinColor={colors.danger}
            />
          ) : null,
        )}
      </MapView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { borderRadius: 12, overflow: 'hidden' },
  map: { width: '100%', height: 320 },
});
