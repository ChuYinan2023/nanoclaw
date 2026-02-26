import http from 'node:http';
import crypto from 'node:crypto';

import { WebSocketServer, WebSocket, RawData } from 'ws';

import { ASSISTANT_NAME, WEB_PORT, WEB_TOKEN } from '../config.js';
import {
  deleteRegisteredGroup,
  getChatLastMessageTime,
  getMessagesForDisplay,
  storeMessageDirect,
} from '../db.js';
import { logger } from '../logger.js';
import {
  Channel,
  NewMessage,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface WebChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
}

interface WebClient {
  ws: WebSocket;
  jid: string;
  sessionId: string;
  userName: string;
}

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function generateSessionId(): string {
  return crypto.randomBytes(8).toString('hex');
}

/** Constant-time token comparison to prevent timing attacks. */
function tokenEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// --- Embedded frontend HTML ---
const FRONTEND_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NanoClaw</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #1a1a2e; color: #eee; height: 100vh; display: flex; flex-direction: column; }
  #header { padding: 12px 16px; background: #16213e; border-bottom: 1px solid #0f3460; display: flex; align-items: center; gap: 10px; }
  #header h1 { font-size: 16px; font-weight: 600; }
  #status { width: 8px; height: 8px; border-radius: 50%; background: #e94560; }
  #status.connected { background: #4ecca3; }
  #messages { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 8px; }
  .msg { max-width: 80%; padding: 10px 14px; border-radius: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; font-size: 14px; }
  .msg.user { align-self: flex-end; background: #0f3460; color: #eee; border-bottom-right-radius: 4px; }
  .msg.bot { align-self: flex-start; background: #222; color: #ddd; border-bottom-left-radius: 4px; }
  .msg .sender { font-size: 11px; color: #888; margin-bottom: 4px; }
  .msg .time { font-size: 10px; color: #666; margin-top: 4px; text-align: right; }
  #typing { padding: 4px 16px; font-size: 13px; color: #888; min-height: 24px; }
  #form { display: flex; padding: 12px; gap: 8px; background: #16213e; border-top: 1px solid #0f3460; }
  #input { flex: 1; padding: 10px 14px; border: 1px solid #0f3460; border-radius: 8px; background: #1a1a2e; color: #eee; font-size: 14px; outline: none; }
  #input:focus { border-color: #4ecca3; }
  #send { padding: 10px 20px; border: none; border-radius: 8px; background: #4ecca3; color: #1a1a2e; font-weight: 600; cursor: pointer; font-size: 14px; }
  #send:hover { background: #3dbb94; }
  #auth { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; gap: 16px; }
  #auth input { padding: 10px 14px; border: 1px solid #0f3460; border-radius: 8px; background: #1a1a2e; color: #eee; font-size: 14px; width: 280px; outline: none; }
  #auth button { padding: 10px 24px; border: none; border-radius: 8px; background: #4ecca3; color: #1a1a2e; font-weight: 600; cursor: pointer; font-size: 14px; }
</style>
</head>
<body>
<div id="auth" style="display:none">
  <h2>NanoClaw</h2>
  <p style="color:#888;font-size:14px">Enter access token</p>
  <input id="tokenInput" type="password" placeholder="Token" autocomplete="off">
  <button onclick="submitToken()">Connect</button>
</div>
<div id="chat" style="display:none">
  <div id="header"><div id="status"></div><h1>NanoClaw</h1></div>
  <div id="messages"></div>
  <div id="typing"></div>
  <form id="form"><input id="input" type="text" autocomplete="off" placeholder="Message..."><button id="send" type="submit">Send</button></form>
</div>
<script>
(function() {
  const params = new URLSearchParams(location.search);
  let token = params.get('token') || '';

  window.submitToken = function() {
    const t = document.getElementById('tokenInput').value.trim();
    if (!t) return;
    const url = new URL(location.href);
    url.searchParams.set('token', t);
    location.href = url.toString();
  };

  if (!token) {
    document.getElementById('auth').style.display = 'flex';
    document.getElementById('tokenInput').addEventListener('keydown', function(e) {
      if (e.key === 'Enter') submitToken();
    });
    return;
  }

  startChat(token);

  function startChat(tok) {
    document.getElementById('chat').style.display = 'flex';
    document.getElementById('chat').style.height = '100vh';
    document.getElementById('chat').style.flexDirection = 'column';

    const messagesDiv = document.getElementById('messages');
    const typingDiv = document.getElementById('typing');
    const statusDiv = document.getElementById('status');
    const form = document.getElementById('form');
    const input = document.getElementById('input');

    let sessionId = localStorage.getItem('nanoclaw_web_session') || '';
    let ws = null;
    let reconnectTimer = null;

    function connect() {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      let url = proto + '//' + location.host + '/?token=' + encodeURIComponent(tok);
      if (sessionId) url += '&session=' + encodeURIComponent(sessionId);

      ws = new WebSocket(url);

      ws.onopen = function() {
        statusDiv.classList.add('connected');
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      };

      ws.onclose = function() {
        statusDiv.classList.remove('connected');
        typingDiv.textContent = '';
        reconnectTimer = setTimeout(connect, 2000);
      };

      ws.onmessage = function(evt) {
        let data;
        try { data = JSON.parse(evt.data); } catch { return; }

        if (data.type === 'session') {
          sessionId = data.sessionId;
          localStorage.setItem('nanoclaw_web_session', sessionId);
          return;
        }

        if (data.type === 'history') {
          messagesDiv.innerHTML = '';
          (data.messages || []).forEach(function(m) { appendMessage(m); });
          scrollToBottom();
          return;
        }

        if (data.type === 'typing') {
          typingDiv.textContent = data.isTyping ? 'Thinking...' : '';
          return;
        }

        if (data.type === 'message') {
          appendMessage(data);
          scrollToBottom();
          return;
        }
      };
    }

    function appendMessage(m) {
      const div = document.createElement('div');
      const isBot = m.is_bot_message || m.sender === 'assistant';
      div.className = 'msg ' + (isBot ? 'bot' : 'user');

      const sender = document.createElement('div');
      sender.className = 'sender';
      sender.textContent = m.sender_name || (isBot ? 'Assistant' : 'You');
      div.appendChild(sender);

      const content = document.createElement('div');
      content.textContent = m.content;
      div.appendChild(content);

      if (m.timestamp) {
        const time = document.createElement('div');
        time.className = 'time';
        time.textContent = new Date(m.timestamp).toLocaleTimeString();
        div.appendChild(time);
      }

      messagesDiv.appendChild(div);
    }

    function scrollToBottom() {
      messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }

    form.addEventListener('submit', function(e) {
      e.preventDefault();
      const text = input.value.trim();
      if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ text: text }));
      input.value = '';
    });

    connect();
  }
})();
</script>
</body>
</html>`;

export class WebChannel implements Channel {
  name = 'web';

  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private clients = new Map<string, WebClient>();
  private opts: WebChannelOpts;
  private connected = false;

  constructor(opts: WebChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.server = http.createServer((req, res) => {
      this.handleHttp(req, res);
    });

    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));

    await new Promise<void>((resolve) => {
      this.server!.listen(WEB_PORT, () => {
        this.connected = true;
        logger.info({ port: WEB_PORT }, 'Web channel listening');
        console.log(`\n  Web chat: http://localhost:${WEB_PORT}/?token=<WEB_TOKEN>\n`);
        resolve();
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const sessionId = jid.replace(/^web:/, '');
    const client = this.clients.get(sessionId);

    const timestamp = new Date().toISOString();
    const msgId = `bot-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    // Persist bot message for history replay
    storeMessageDirect({
      id: msgId,
      chat_jid: jid,
      sender: 'assistant',
      sender_name: ASSISTANT_NAME,
      content: text,
      timestamp,
      is_from_me: true,
      is_bot_message: true,
    });

    if (!client || client.ws.readyState !== WebSocket.OPEN) {
      logger.warn({ jid }, 'Web client not connected, message stored but not delivered');
      return;
    }

    client.ws.send(
      JSON.stringify({
        type: 'message',
        id: msgId,
        chat_jid: jid,
        sender: 'assistant',
        sender_name: ASSISTANT_NAME,
        content: text,
        timestamp,
        is_bot_message: true,
      }),
    );
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('web:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    for (const client of this.clients.values()) {
      client.ws.close(1001, 'Server shutting down');
    }
    this.clients.clear();
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
    logger.info('Web channel stopped');
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    const sessionId = jid.replace(/^web:/, '');
    const client = this.clients.get(sessionId);
    if (!client || client.ws.readyState !== WebSocket.OPEN) return;
    client.ws.send(JSON.stringify({ type: 'typing', isTyping }));
  }

  // --- Private methods ---

  private handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url || '/', `http://localhost:${WEB_PORT}`);

    if (url.pathname !== '/') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }

    const token = url.searchParams.get('token') || '';
    if (!token || !tokenEquals(token, WEB_TOKEN)) {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end('Unauthorized');
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(FRONTEND_HTML);
  }

  private handleConnection(ws: WebSocket, req: http.IncomingMessage): void {
    const url = new URL(req.url || '/', `http://localhost:${WEB_PORT}`);
    const token = url.searchParams.get('token') || '';

    if (!token || !tokenEquals(token, WEB_TOKEN)) {
      ws.close(4001, 'Unauthorized');
      return;
    }

    const sessionId = url.searchParams.get('session') || generateSessionId();
    const jid = `web:${sessionId}`;

    // Close existing connection for the same session (Important #5: multi-tab takeover)
    const existing = this.clients.get(sessionId);
    if (existing && existing.ws.readyState === WebSocket.OPEN) {
      existing.ws.close(4002, 'Session taken over');
    }

    const client: WebClient = {
      ws,
      jid,
      sessionId,
      userName: 'Web User',
    };
    this.clients.set(sessionId, client);

    // Send session ID so browser can persist it
    ws.send(JSON.stringify({ type: 'session', sessionId }));

    // Report metadata for chat discovery
    this.opts.onChatMetadata(jid, new Date().toISOString(), `Web:${sessionId.slice(0, 8)}`, 'web', false);

    // Auto-register if new
    const groups = this.opts.registeredGroups();
    if (!groups[jid]) {
      this.autoRegisterSession(jid, sessionId);
    }

    // Send chat history
    this.sendHistory(client);

    // Cleanup stale sessions
    this.cleanupStaleSessions();

    ws.on('message', (data: RawData) => this.handleInbound(client, data));
    ws.on('close', () => {
      this.clients.delete(sessionId);
    });
  }

  private handleInbound(client: WebClient, raw: RawData): void {
    let payload: { text?: string; userName?: string };
    try {
      payload = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (payload.userName) {
      client.userName = payload.userName;
    }

    if (!payload.text?.trim()) return;

    const timestamp = new Date().toISOString();
    const msgId = `web-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    const msg: NewMessage = {
      id: msgId,
      chat_jid: client.jid,
      sender: client.sessionId,
      sender_name: client.userName,
      content: payload.text.trim(),
      timestamp,
      is_from_me: false,
      is_bot_message: false,
    };

    // Echo back to sender so UI shows the sent message immediately
    client.ws.send(
      JSON.stringify({
        type: 'message',
        ...msg,
      }),
    );

    // Deliver to orchestrator
    this.opts.onMessage(client.jid, msg);
  }

  private autoRegisterSession(jid: string, sessionId: string): void {
    const folder = `web-${sessionId.slice(0, 12)}`;
    this.opts.registerGroup(jid, {
      name: `Web:${sessionId.slice(0, 8)}`,
      folder,
      trigger: `@${ASSISTANT_NAME}`,
      added_at: new Date().toISOString(),
      requiresTrigger: false,
    });
    logger.info({ jid, folder }, 'Auto-registered web session');
  }

  private sendHistory(client: WebClient): void {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const messages = getMessagesForDisplay(client.jid, since, 50);
    client.ws.send(JSON.stringify({ type: 'history', messages }));
  }

  private cleanupStaleSessions(): void {
    const now = Date.now();
    const groups = this.opts.registeredGroups();

    for (const [jid] of Object.entries(groups)) {
      if (!jid.startsWith('web:')) continue;

      const sessionId = jid.replace(/^web:/, '');

      // Skip sessions with active WebSocket connections
      if (this.clients.has(sessionId)) continue;

      // Use last message time (most recent activity) rather than registration time.
      // A session registered 8 days ago but active yesterday should not be purged.
      const lastActivity = getChatLastMessageTime(jid);
      const lastActiveAt = lastActivity ? new Date(lastActivity).getTime() : 0;
      if (now - lastActiveAt < SESSION_TTL_MS) continue;

      // Stale session — remove
      deleteRegisteredGroup(jid);
      logger.info({ jid, age: Math.round((now - lastActiveAt) / 86400000) + 'd' }, 'Cleaned up stale web session');
    }
  }
}
