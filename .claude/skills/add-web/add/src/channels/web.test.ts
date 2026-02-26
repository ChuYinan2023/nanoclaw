import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';

// --- Mocks ---

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  WEB_PORT: 0, // random port for tests
  WEB_TOKEN: 'test-token-123',
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../db.js', () => ({
  storeMessageDirect: vi.fn(),
  getMessagesForDisplay: vi.fn(() => []),
  deleteRegisteredGroup: vi.fn(),
  getChatLastMessageTime: vi.fn(() => null),
}));

import { WebChannel, WebChannelOpts } from './web.js';
import { storeMessageDirect, getMessagesForDisplay, deleteRegisteredGroup, getChatLastMessageTime } from '../db.js';
import WebSocket from 'ws';

// --- Test helpers ---

function createTestOpts(overrides?: Partial<WebChannelOpts>): WebChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({})),
    registerGroup: vi.fn(),
    ...overrides,
  };
}

function getAddress(channel: WebChannel): string {
  // Access the internal server to get the bound port
  const server = (channel as any).server as http.Server;
  const addr = server.address();
  if (typeof addr === 'string' || !addr) throw new Error('Server not listening');
  return `http://localhost:${addr.port}`;
}

function getWsUrl(channel: WebChannel, params: Record<string, string> = {}): string {
  const server = (channel as any).server as http.Server;
  const addr = server.address();
  if (typeof addr === 'string' || !addr) throw new Error('Server not listening');
  const qs = new URLSearchParams({ token: 'test-token-123', ...params }).toString();
  return `ws://localhost:${addr.port}/?${qs}`;
}

async function connectWs(
  channel: WebChannel,
  params: Record<string, string> = {},
): Promise<WebSocket> {
  const url = getWsUrl(channel, params);
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  return ws;
}

function waitForMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => {
    ws.once('message', (data) => {
      resolve(JSON.parse(data.toString()));
    });
  });
}

// --- Tests ---

describe('WebChannel', () => {
  let channel: WebChannel;
  let opts: WebChannelOpts;

  beforeEach(() => {
    vi.clearAllMocks();
    opts = createTestOpts();
  });

  afterEach(async () => {
    if (channel) {
      await channel.disconnect();
    }
  });

  // --- Connection lifecycle ---

  describe('connect/disconnect', () => {
    it('starts and stops the HTTP server', async () => {
      channel = new WebChannel(opts);
      expect(channel.isConnected()).toBe(false);

      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });
  });

  // --- HTTP auth ---

  describe('HTTP authentication', () => {
    it('serves HTML page with valid token', async () => {
      channel = new WebChannel(opts);
      await channel.connect();
      const addr = getAddress(channel);

      const res = await fetch(`${addr}/?token=test-token-123`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      const body = await res.text();
      expect(body).toContain('NanoClaw');
    });

    it('returns 401 for invalid token', async () => {
      channel = new WebChannel(opts);
      await channel.connect();
      const addr = getAddress(channel);

      const res = await fetch(`${addr}/?token=wrong-token`);
      expect(res.status).toBe(401);
    });

    it('returns 401 for missing token', async () => {
      channel = new WebChannel(opts);
      await channel.connect();
      const addr = getAddress(channel);

      const res = await fetch(`${addr}/`);
      expect(res.status).toBe(401);
    });

    it('returns 404 for non-root path', async () => {
      channel = new WebChannel(opts);
      await channel.connect();
      const addr = getAddress(channel);

      const res = await fetch(`${addr}/other?token=test-token-123`);
      expect(res.status).toBe(404);
    });
  });

  // --- WebSocket auth ---

  describe('WebSocket authentication', () => {
    it('accepts connection with valid token', async () => {
      channel = new WebChannel(opts);
      await channel.connect();

      const ws = await connectWs(channel);
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    });

    it('rejects connection with invalid token', async () => {
      channel = new WebChannel(opts);
      await channel.connect();

      const url = getWsUrl(channel, { token: 'wrong-token' });
      const ws = new WebSocket(url);

      const closeCode = await new Promise<number>((resolve) => {
        ws.on('close', (code) => resolve(code));
      });
      expect(closeCode).toBe(4001);
    });
  });

  // --- Session management ---

  describe('session management', () => {
    it('assigns a session ID on new connection', async () => {
      channel = new WebChannel(opts);
      await channel.connect();

      const ws = await connectWs(channel);
      const sessionMsg = await waitForMessage(ws);

      expect(sessionMsg.type).toBe('session');
      expect(sessionMsg.sessionId).toBeDefined();
      expect(typeof sessionMsg.sessionId).toBe('string');
      expect(sessionMsg.sessionId.length).toBeGreaterThan(0);

      ws.close();
    });

    it('restores session ID from query param', async () => {
      channel = new WebChannel(opts);
      await channel.connect();

      const ws = await connectWs(channel, { session: 'my-session-123' });
      const sessionMsg = await waitForMessage(ws);

      expect(sessionMsg.type).toBe('session');
      expect(sessionMsg.sessionId).toBe('my-session-123');

      ws.close();
    });

    it('auto-registers new session as a group', async () => {
      channel = new WebChannel(opts);
      await channel.connect();

      const ws = await connectWs(channel);
      await waitForMessage(ws); // session
      await waitForMessage(ws); // history

      expect(opts.registerGroup).toHaveBeenCalledOnce();
      const [jid, group] = (opts.registerGroup as any).mock.calls[0];
      expect(jid).toMatch(/^web:/);
      expect(group.requiresTrigger).toBe(false);
      expect(group.folder).toMatch(/^web-/);

      ws.close();
    });

    it('does not re-register existing session', async () => {
      const existingGroups: Record<string, any> = {};
      opts.registeredGroups = vi.fn(() => existingGroups);

      channel = new WebChannel(opts);
      await channel.connect();

      // First connection — auto-registers
      const ws1 = await connectWs(channel);
      const session1 = await waitForMessage(ws1);
      await waitForMessage(ws1); // history
      expect(opts.registerGroup).toHaveBeenCalledOnce();

      // Add to mock groups
      existingGroups[`web:${session1.sessionId}`] = {
        name: 'Web session',
        folder: `web-${session1.sessionId.slice(0, 12)}`,
        trigger: '@Andy',
        added_at: new Date().toISOString(),
      };

      // Second connection with same session — should not re-register
      const ws2 = await connectWs(channel, { session: session1.sessionId });
      await waitForMessage(ws2); // session
      await waitForMessage(ws2); // history
      expect(opts.registerGroup).toHaveBeenCalledOnce(); // still once

      ws1.close();
      ws2.close();
    });

    it('closes old connection when same session reconnects (takeover)', async () => {
      channel = new WebChannel(opts);
      await channel.connect();

      // First connection
      const ws1 = await connectWs(channel);
      const session1 = await waitForMessage(ws1);
      await waitForMessage(ws1); // history

      const closePromise = new Promise<number>((resolve) => {
        ws1.on('close', (code) => resolve(code));
      });

      // Second connection with same session — should close ws1
      const ws2 = await connectWs(channel, { session: session1.sessionId });
      await waitForMessage(ws2); // session
      await waitForMessage(ws2); // history

      const closeCode = await closePromise;
      expect(closeCode).toBe(4002);

      ws2.close();
    });
  });

  // --- Inbound messages ---

  describe('inbound messages', () => {
    it('delivers valid message to orchestrator', async () => {
      channel = new WebChannel(opts);
      await channel.connect();

      const ws = await connectWs(channel);
      await waitForMessage(ws); // session
      await waitForMessage(ws); // history

      ws.send(JSON.stringify({ text: 'Hello agent' }));

      // Wait for echo
      const echo = await waitForMessage(ws);
      expect(echo.type).toBe('message');
      expect(echo.content).toBe('Hello agent');

      expect(opts.onMessage).toHaveBeenCalledOnce();
      const [jid, msg] = (opts.onMessage as any).mock.calls[0];
      expect(jid).toMatch(/^web:/);
      expect(msg.content).toBe('Hello agent');
      expect(msg.is_bot_message).toBe(false);

      ws.close();
    });

    it('ignores empty text', async () => {
      channel = new WebChannel(opts);
      await channel.connect();

      const ws = await connectWs(channel);
      await waitForMessage(ws); // session
      await waitForMessage(ws); // history

      ws.send(JSON.stringify({ text: '  ' }));

      // Give a moment for processing
      await new Promise((r) => setTimeout(r, 50));
      expect(opts.onMessage).not.toHaveBeenCalled();

      ws.close();
    });

    it('ignores invalid JSON', async () => {
      channel = new WebChannel(opts);
      await channel.connect();

      const ws = await connectWs(channel);
      await waitForMessage(ws); // session
      await waitForMessage(ws); // history

      ws.send('not json');

      await new Promise((r) => setTimeout(r, 50));
      expect(opts.onMessage).not.toHaveBeenCalled();

      ws.close();
    });
  });

  // --- Outbound messages ---

  describe('sendMessage', () => {
    it('sends message to connected client', async () => {
      channel = new WebChannel(opts);
      await channel.connect();

      const ws = await connectWs(channel);
      const sessionMsg = await waitForMessage(ws);
      await waitForMessage(ws); // history

      const jid = `web:${sessionMsg.sessionId}`;
      await channel.sendMessage(jid, 'Hello from bot');

      const msg = await waitForMessage(ws);
      expect(msg.type).toBe('message');
      expect(msg.content).toBe('Hello from bot');
      expect(msg.sender).toBe('assistant');
      expect(msg.is_bot_message).toBe(true);

      // Should persist bot message
      expect(storeMessageDirect).toHaveBeenCalledWith(
        expect.objectContaining({
          chat_jid: jid,
          content: 'Hello from bot',
          is_bot_message: true,
        }),
      );

      ws.close();
    });

    it('stores but does not crash for disconnected client', async () => {
      channel = new WebChannel(opts);
      await channel.connect();

      // No client connected for this JID
      await channel.sendMessage('web:nonexistent', 'Hello');

      // Should still store the message
      expect(storeMessageDirect).toHaveBeenCalledWith(
        expect.objectContaining({
          chat_jid: 'web:nonexistent',
          content: 'Hello',
        }),
      );
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('claims web: prefixed JIDs', () => {
      channel = new WebChannel(opts);
      expect(channel.ownsJid('web:abc123')).toBe(true);
    });

    it('rejects non-web JIDs', () => {
      channel = new WebChannel(opts);
      expect(channel.ownsJid('tg:12345')).toBe(false);
      expect(channel.ownsJid('12345@g.us')).toBe(false);
      expect(channel.ownsJid('slack:C123')).toBe(false);
    });
  });

  // --- Typing indicator ---

  describe('setTyping', () => {
    it('sends typing indicator to connected client', async () => {
      channel = new WebChannel(opts);
      await channel.connect();

      const ws = await connectWs(channel);
      const sessionMsg = await waitForMessage(ws);
      await waitForMessage(ws); // history

      const jid = `web:${sessionMsg.sessionId}`;
      await channel.setTyping(jid, true);

      const msg = await waitForMessage(ws);
      expect(msg.type).toBe('typing');
      expect(msg.isTyping).toBe(true);

      ws.close();
    });
  });

  // --- History ---

  describe('history replay', () => {
    it('sends history on connect', async () => {
      const mockMessages = [
        { id: '1', content: 'Hello', sender_name: 'User', timestamp: new Date().toISOString() },
        { id: '2', content: 'Hi there', sender_name: 'Andy', timestamp: new Date().toISOString(), is_bot_message: true },
      ];
      vi.mocked(getMessagesForDisplay).mockReturnValue(mockMessages as any);

      channel = new WebChannel(opts);
      await channel.connect();

      const ws = await connectWs(channel);
      await waitForMessage(ws); // session

      const historyMsg = await waitForMessage(ws);
      expect(historyMsg.type).toBe('history');
      expect(historyMsg.messages).toHaveLength(2);
      expect(historyMsg.messages[0].content).toBe('Hello');
      expect(historyMsg.messages[1].content).toBe('Hi there');

      ws.close();
    });
  });

  // --- Session TTL cleanup ---

  describe('stale session cleanup', () => {
    it('deletes stale sessions on new connection', async () => {
      const groups: Record<string, any> = {
        'web:stale-session': {
          name: 'Web:stale-se',
          folder: 'web-stale-sessi',
          trigger: '@Andy',
          added_at: new Date().toISOString(),
        },
      };
      opts.registeredGroups = vi.fn(() => groups);

      // Last message was 8 days ago — session is stale
      const staleDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
      vi.mocked(getChatLastMessageTime).mockReturnValue(staleDate);

      channel = new WebChannel(opts);
      await channel.connect();

      const ws = await connectWs(channel);
      await waitForMessage(ws); // session
      await waitForMessage(ws); // history

      expect(getChatLastMessageTime).toHaveBeenCalledWith('web:stale-session');
      expect(deleteRegisteredGroup).toHaveBeenCalledWith('web:stale-session');

      ws.close();
    });

    it('preserves sessions with recent activity', async () => {
      const groups: Record<string, any> = {
        'web:recent-session': {
          name: 'Web:recent-s',
          folder: 'web-recent-sess',
          trigger: '@Andy',
          added_at: new Date().toISOString(),
        },
      };
      opts.registeredGroups = vi.fn(() => groups);

      // Last message was just now — session is active
      vi.mocked(getChatLastMessageTime).mockReturnValue(new Date().toISOString());

      channel = new WebChannel(opts);
      await channel.connect();

      const ws = await connectWs(channel, { session: 'new-connection' });
      await waitForMessage(ws); // session
      await waitForMessage(ws); // history

      expect(deleteRegisteredGroup).not.toHaveBeenCalled();

      ws.close();
    });

    it('deletes sessions with no message history', async () => {
      const groups: Record<string, any> = {
        'web:no-history': {
          name: 'Web:no-histo',
          folder: 'web-no-history',
          trigger: '@Andy',
          added_at: new Date().toISOString(),
        },
      };
      opts.registeredGroups = vi.fn(() => groups);

      // No messages ever — getChatLastMessageTime returns null
      vi.mocked(getChatLastMessageTime).mockReturnValue(null);

      channel = new WebChannel(opts);
      await channel.connect();

      const ws = await connectWs(channel);
      await waitForMessage(ws); // session
      await waitForMessage(ws); // history

      expect(deleteRegisteredGroup).toHaveBeenCalledWith('web:no-history');

      ws.close();
    });
  });
});
