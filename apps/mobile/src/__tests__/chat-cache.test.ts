import { type ChatMessage } from '@voyago/shared';
import { type MessagePages, withMessage, withoutMessage } from '../chat/messages-cache';
import { routeFor } from '../notifications/route';

const message = (id: string, body: string): ChatMessage => ({
  id,
  conversationId: 'c1',
  type: 'TEXT',
  body,
  imageUrl: null,
  sender: null,
  clientId: null,
  deleted: false,
  createdAt: '2026-11-20T10:00:00.000Z',
});
const pages = (...bodies: string[][]): MessagePages => ({
  pageParams: bodies.map(() => undefined),
  pages: bodies.map((page, i) => ({
    data: page.map((body) => message(`${i}-${body}`, body)),
    page: { hasMore: false, nextCursor: null },
  })),
});

describe('chat history cache', () => {
  it('puts a new message first, once', () => {
    const start = pages(['b', 'a']);
    const next = withMessage(start, message('new', 'c'));
    expect(next?.pages[0]?.data.map((m) => m.body)).toEqual(['c', 'b', 'a']);
    // The same message arriving again (another device, a retry) replaces rather than duplicates.
    const again = withMessage(next, { ...message('new', 'c'), body: 'c edited' });
    expect(again?.pages[0]?.data.map((m) => m.body)).toEqual(['c edited', 'b', 'a']);
    expect(withMessage(undefined, message('x', 'x'))).toBeUndefined();
  });

  it('blanks deleted messages', () => {
    const next = withoutMessage(pages(['b'], ['a']), '1-a');
    expect(next?.pages[1]?.data[0]).toMatchObject({ deleted: true, body: null });
  });
});

describe('notification taps', () => {
  it('open the chat, trip, community or profile they are about', () => {
    expect(routeFor({ conversationId: 'c1', tripId: 't1' })).toBe('/chats/c1');
    expect(routeFor({ tripId: 't1' })).toBe('/trips/t1');
    expect(routeFor({ communitySlug: 'riders' })).toBe('/communities/riders');
    expect(routeFor({ username: 'asha' })).toBe('/users/asha');
    expect(routeFor({ notificationId: 'n1' })).toBeNull();
  });
});
