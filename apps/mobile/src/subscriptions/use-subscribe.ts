import { useQueryClient } from '@tanstack/react-query';
import { type MySubscription } from '@voyago/shared';
import * as Crypto from 'expo-crypto';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { getMySubscription, subscribe } from '../api/subscriptions';

/** Where the payment page sends the member back to. The API accepts only the app's addresses. */
export const subscriptionReturnUrl = () => Linking.createURL('plans');

/**
 * Starts (or resumes) a subscription and opens its payment page in the system browser. The page's
 * verdict is only a hint: the plan is reloaded from the server, which switches it on from the
 * payment provider's own records.
 */
export function useSubscribe() {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);

  const finish = async (): Promise<MySubscription> => {
    const after = await getMySubscription();
    queryClient.setQueryData(['my-subscription'], after);
    return after;
  };

  /** The payment page for a subscription already waiting for its first payment. */
  const pay = async (): Promise<MySubscription> => {
    setBusy(true);
    try {
      const returnUrl = subscriptionReturnUrl();
      const fresh = await getMySubscription(returnUrl);
      const url = fresh.subscription?.checkoutUrl;
      if (url) await WebBrowser.openAuthSessionAsync(url, returnUrl);
      return await finish();
    } finally {
      setBusy(false);
    }
  };

  const start = async (planCode: string): Promise<MySubscription> => {
    setBusy(true);
    try {
      const returnUrl = subscriptionReturnUrl();
      const started = await subscribe({
        planCode,
        idempotencyKey: Crypto.randomUUID().replace(/-/g, ''),
        returnUrl,
      });
      const url = started.subscription?.checkoutUrl;
      if (url) await WebBrowser.openAuthSessionAsync(url, returnUrl);
      return await finish();
    } finally {
      setBusy(false);
    }
  };

  return { start, pay, busy };
}
