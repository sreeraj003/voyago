import { type GeoPoint } from '@voyago/shared';
import * as Location from 'expo-location';
import { useState } from 'react';
import { coarsen } from './filters';

export type LocationState =
  | { status: 'off' }
  | { status: 'asking' }
  | { status: 'on'; point: GeoPoint }
  | { status: 'denied'; canAskAgain: boolean }
  | { status: 'error'; message: string };

/**
 * The member's location for "near me", requested only when they tap it. Kept in memory for this
 * screen, rounded to about 100 m, and never stored or sent anywhere except the search itself.
 */
export function useNearMe() {
  const [state, setState] = useState<LocationState>({ status: 'off' });

  const enable = async () => {
    setState({ status: 'asking' });
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== Location.PermissionStatus.GRANTED) {
        setState({ status: 'denied', canAskAgain: permission.canAskAgain });
        return;
      }
      const position = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      setState({
        status: 'on',
        point: coarsen({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        }),
      });
    } catch {
      setState({ status: 'error', message: 'Could not get your location. Try again.' });
    }
  };

  const disable = () => setState({ status: 'off' });
  return { state, point: state.status === 'on' ? state.point : null, enable, disable };
}
