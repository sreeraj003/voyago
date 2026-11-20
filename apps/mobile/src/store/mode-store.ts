import { type TripMode } from '@voyago/shared';
import { create } from 'zustand';

type ModeState = {
  mode: TripMode;
  setMode: (mode: TripMode) => void;
};

/** The Ride / Travel selector shown on Home. Drives which trips and filters the app shows. */
export const useModeStore = create<ModeState>((set) => ({
  mode: 'RIDE',
  setMode: (mode) => set({ mode }),
}));
