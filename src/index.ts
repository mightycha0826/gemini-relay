/**
 * gemini-relay — Cloudflare Worker (Durable Object 기반 메시지 라우터)
 *
 * AI 추론(Gemini 답변 분석 + 질문/감정 생성)은 별도 Python 프로세스
 * (interview_question_generator.py)가 전담한다. relay는 Unity ↔ Python
 * 사이의 메시지를 중계하고, 최종 질문 텍스트에 Supertone TTS 오디오를
 * 붙여 Unity로 돌려주는 역할만 담당한다.
 *
 * 연결 역할 판별:
 *   - AI worker : session 쿼리파라미터가 AI_WORKER_SESSION_ID 인 연결.
 *                 Python은 반드시 `--session-id ai-worker` 로 접속해야
 *                 relay가 재연결 시에도 즉시 worker로 인식한다.
 *   - Unity 클라이언트 : 그 외 모든 연결.
 *
 * 메시지 흐름:
 *   Unity  → relay  : { type: "client_msg", department, last_question, text, client_session_id? }
 *   relay  → Python : 위 메시지에 client_session_id 를 보정해 그대로 전달
 *   Python → relay  : { type: "server_content", client_session_id, content: { text, emotion }, ... }
 *   relay  → Unity  : 위 메시지의 content 에 audio(base64 WAV, Supertone TTS) 를 첨부해 전달
 *
 * 서로 다른 WebSocket 연결(Unity, Python) 간 상태 공유가 필요하므로
 * 모든 연결은 단일 Durable Object 인스턴스(RelayHub)로 라우팅된다.
 */

// ─── Env ──────────────────────────────────────────────────────────────────────

interface Env {
  RELAY_HUB:          DurableObjectNamespace;
  SUPERTONE_API_KEY:  string; // wrangler secret put SUPERTONE_API_KEY
  SUPERTONE_VOICE_ID: string; // wrangler.toml [vars]
  SUPERTONE_MODEL:    string; // wrangler.toml [vars]
  SUPERTONE_STYLE:    string; // wrangler.toml [vars] — voice가 지원 안 하면 빈 문자열로 비워 생략
}

// Python AI worker는 이 session id로 접속해야 relay가 연결 즉시 worker로 인식한다.
const AI_WORKER_SESSION_ID = 'ai-worker';

// ─── 엔트리포인트 ─────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.headers.get('Upgrade') === 'websocket') {
      const id   = env.RELAY_HUB.idFromName('global');
      const stub = env.RELAY_HUB.get(id);
      return stub.fetch(request);
    }

    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return json({ status: 'ok', ts: new Date().toISOString() });
    }

    if (request.method === 'GET' && url.pathname === '/') {
      return json({ service: 'gemini-relay', version: '2.0.0' });
    }

    return new Response('WebSocket endpoint — wss:// 로 연결하세요.', { status: 426 });
  },
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ─── RelayHub — 모든 WebSocket 연결이 모이는 Durable Object ───────────────────

type Role = 'unclassified' | 'unity' | 'worker';

interface ConnMeta {
  id:   string;
  role: Role;
}

export class RelayHub implements DurableObject {
  private clients:  Map<string, WebSocket> = new Map(); // Unity 클라이언트 (client_session_id 기준)
  private connMeta: Map<WebSocket, ConnMeta> = new Map();
  private aiWorker: WebSocket | null = null;

  constructor(_state: DurableObjectState, private env: Env) {}

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    const url    = new URL(request.url);
    const connId = url.searchParams.get('session') || crypto.randomUUID();

    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();

    const isWorker = connId === AI_WORKER_SESSION_ID;
    this.connMeta.set(server, { id: connId, role: isWorker ? 'worker' : 'unclassified' });
    if (isWorker) this.aiWorker = server;

    // 101 응답이 클라이언트로 반환된 뒤에 ready를 보내기 위해 한 틱 지연
    setTimeout(() => this.trySend(server, { type: 'ready' }), 0);

    server.addEventListener('message', (event) => this.handleMessage(server, event as MessageEvent));
    server.addEventListener('close',   () => this.handleClose(server));
    server.addEventListener('error',   () => this.handleClose(server));

    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleMessage(ws: WebSocket, event: MessageEvent): Promise<void> {
    let msg: Record<string, any>;
    try {
      msg = JSON.parse(event.data as string);
    } catch {
      this.trySend(ws, { type: 'error', message: 'Invalid message format' });
      return;
    }

    const meta = this.connMeta.get(ws);
    if (!meta) return;

    switch (msg.type) {
      case 'client_msg':
        await this.routeClientMsg(ws, meta, msg);
        break;

      case 'server_content':
        await this.routeServerContent(ws, meta, msg);
        break;

      default:
        console.log('[relay] 알 수 없는 메시지 type:', msg.type);
    }
  }

  // Unity → Python
  private async routeClientMsg(ws: WebSocket, meta: ConnMeta, msg: Record<string, any>): Promise<void> {
    if (meta.role === 'unclassified') {
      meta.role = 'unity';
      this.clients.set(meta.id, ws);
    }

    if (!msg.text?.trim()) {
      this.trySend(ws, { type: 'error', message: 'Empty text' });
      return;
    }
    if (!this.aiWorker) {
      this.trySend(ws, { type: 'error', message: 'AI worker not connected' });
      return;
    }

    const clientSessionId = msg.client_session_id || meta.id;
    this.trySend(ws, { type: 'processing' });

    const ok = this.trySend(this.aiWorker, { ...msg, client_session_id: clientSessionId });
    if (!ok) {
      this.aiWorker = null;
      this.trySend(ws, { type: 'error', message: 'AI worker not connected' });
    }
  }

  // Python → Unity (Supertone TTS 첨부 후 전달)
  private async routeServerContent(ws: WebSocket, meta: ConnMeta, msg: Record<string, any>): Promise<void> {
    if (meta.role === 'unclassified') {
      meta.role = 'worker';
      this.aiWorker = ws;
    }

    const enriched = await this.attachAudio(msg);
    const targetId  = msg.client_session_id;

    // client_session_id 없음 = 특정 답변에 대한 응답이 아닌 초기 질문(PDF 분석 결과 등).
    // 대상을 특정할 수 없으므로 현재 연결된 모든 Unity 클라이언트에 브로드캐스트한다.
    if (!targetId) {
      if (this.clients.size === 0) {
        console.error('[relay] server_content 브로드캐스트 실패 — 연결된 Unity 클라이언트 없음');
        return;
      }
      for (const client of this.clients.values()) this.trySend(client, enriched);
      return;
    }

    const target = this.clients.get(targetId);
    if (!target) {
      console.error('[relay] server_content 라우팅 실패 — 대상 client_session_id 연결 안됨:', targetId);
      return;
    }

    this.trySend(target, enriched);
  }

  private async attachAudio(msg: Record<string, any>): Promise<Record<string, any>> {
    const text = msg?.content?.text;
    if (!text) return msg;

    const audio = await supertoneSpeak(
      text,
      this.env.SUPERTONE_API_KEY,
      this.env.SUPERTONE_VOICE_ID,
      this.env.SUPERTONE_MODEL,
      this.env.SUPERTONE_STYLE,
    );
    if (!audio) return msg;

    return { ...msg, content: { ...msg.content, audio } };
  }

  private handleClose(ws: WebSocket): void {
    const meta = this.connMeta.get(ws);
    if (meta) {
      if (meta.role === 'unity') this.clients.delete(meta.id);
      if (meta.role === 'worker' && this.aiWorker === ws) this.aiWorker = null;
    }
    this.connMeta.delete(ws);
  }

  private trySend(ws: WebSocket, data: unknown): boolean {
    try {
      ws.send(JSON.stringify(data));
      return true;
    } catch (e) {
      console.error('[relay] send 실패:', e);
      return false;
    }
  }
}

// ─── Supertone — TTS ──────────────────────────────────────────────────────────

async function supertoneSpeak(
  text:    string,
  apiKey:  string,
  voiceId: string,
  model:   string,
  style:   string,
): Promise<string | null> {
  if (!apiKey || !voiceId) return null;

  try {
    const body: Record<string, string> = { text, language: 'ko', model };
    if (style) body.style = style; // voice가 지원하지 않는 style이면 400 — 빈 값이면 생략해 API 기본값 사용

    const res = await fetch(
      `https://supertoneapi.com/v1/text-to-speech/${voiceId}/stream`,
      {
        method:  'POST',
        headers: {
          'x-sup-api-key': apiKey,
          'Content-Type':  'application/json',
          'Accept':        'audio/wav',
        },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) throw new Error(`Supertone ${res.status}: ${await res.text()}`);

    const bytes = new Uint8Array(await res.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    return btoa(binary);
  } catch (e) {
    console.error('[relay] Supertone TTS 실패:', e);
    return null;
  }
}
