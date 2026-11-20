import { type Href } from 'expo-router';

/** Where a tapped notification leads. */
export function routeFor(data: Record<string, unknown>): Href | null {
  const text = (key: string) => {
    const value = data[key];
    return typeof value === 'string' ? value : null;
  };
  const conversationId = text('conversationId');
  const tripId = text('tripId');
  const communitySlug = text('communitySlug');
  const username = text('username');
  if (conversationId) return `/chats/${conversationId}`;
  if (tripId && text('screen') === 'safety') return `/trips/${tripId}/safety`;
  if (text('screen') === 'questions') return '/operator/questions';
  const packageId = text('packageId');
  if (packageId) return `/packages/${packageId}`;
  if (tripId) return `/trips/${tripId}`;
  if (communitySlug) return `/communities/${communitySlug}`;
  if (username) return `/users/${username}`;
  return null;
}
