import { useQueryClient } from '@tanstack/react-query';
import { type Booking } from '@voyago/shared';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { getBooking } from '../api/bookings';

/** Where the payment page sends the customer back to. The API accepts only the app's addresses. */
export const checkoutReturnUrl = () => Linking.createURL('bookings');

/**
 * Opens the booking's payment page in the system browser and waits for it to come back. The
 * page's verdict is only a hint: the booking is reloaded from the server, which confirms it from
 * the payment provider's own record.
 */
export function useCheckout() {
  const queryClient = useQueryClient();
  const [paying, setPaying] = useState(false);
  const pay = async (booking: Booking): Promise<Booking> => {
    setPaying(true);
    try {
      const returnUrl = checkoutReturnUrl();
      // A fresh link that returns here (links from the list don't carry a return address).
      const fresh = await getBooking(booking.id, returnUrl);
      if (fresh.checkoutUrl) await WebBrowser.openAuthSessionAsync(fresh.checkoutUrl, returnUrl);
      const after = await getBooking(booking.id);
      queryClient.setQueryData(['booking', booking.id], after);
      void queryClient.invalidateQueries({ queryKey: ['my-bookings'] });
      void queryClient.invalidateQueries({ queryKey: ['package'] });
      return after;
    } finally {
      setPaying(false);
    }
  };
  return { pay, paying };
}
