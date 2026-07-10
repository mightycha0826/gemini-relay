/**
 * gemini-relay — Cloudflare Worker
 *
 * Unity WebGL (GeminiClient.cs) ←──wss://──→ 이 Worker
 *
 * STT/TTS는 Unity WebGL에서 Web Speech API로 직접 처리.
 * relay는 텍스트만 받아서 분석 + 다음 질문 결정만 담당.
 *
 * 흐름 (1턴 기준):
 *   1. Unity → session_start (직전 질문)
 *   2. Unity → user_speech  (지원자 답변 텍스트)
 *   3. Worker → Gemini API   : 답변 품질 분석
 *   4. Worker → 자체 추론 서버 (ai/server.py, POST /infer) : 다음 질문 결정
 *   5. Worker → Unity        : server_content 반환
 */

// ─── Env ──────────────────────────────────────────────────────────────────────

interface Env {
  GEMINI_API_KEY:  string; // wrangler secret put GEMINI_API_KEY
  INFER_API_URL:   string; // wrangler.toml [vars] — 우리 Gemma+LoRA 추론 서버 (ai/server.py) 주소
  INFER_API_TOKEN: string; // wrangler secret put INFER_API_TOKEN
}

// ─── 프로토콜 타입 ────────────────────────────────────────────────────────────

/** Unity → Relay */
type ClientMsg =
  | { type: 'session_start'; last_question: string }
  | { type: 'user_speech';   text: string };

/** Relay → Unity */
type ServerMsg =
  | { type: 'ready' }
  | { type: 'processing' }
  | ServerContent
  | { type: 'error'; message: string };

interface ServerContent {
  type:       'server_content';
  message_id: string;
  content: {
    text:         string;
    decision:     'follow_up' | 'next_topic';
    emotionLabel: string;
  };
  stt_result: string;
  usage:      { timestamp: string };
}

interface ModelDecision {
  text:         string;
  decision:     'follow_up' | 'next_topic';
  emotionLabel: string;
}

/** 세션 내부 상태 */
interface SessionState {
  last_question: string;
}

// ─── 상수 ─────────────────────────────────────────────────────────────────────

const DEFAULT_DECISION: ModelDecision = {
  text:         '답변 감사합니다. 다음으로 넘어가겠습니다.',
  decision:     'next_topic',
  emotionLabel: '중립/전환',
};

// Gemini 분석 프롬프트용 템플릿 목록
const ANALYSIS_TEMPLATES = [
  "'{키워드}' 키워드 언급했으나 메커니즘 설명 없음. 꼬리질문으로 검증 필요.",
  '이 항목 평가 충분. 자연스러운 주제 전환을 권장합니다.',
  "'{개념}'에 대한 답변이 추상적입니다. 구체적 근거나 사례 요구 권장.",
  '면접 진행상 다음 파트로 넘어갈 적절한 시점입니다.',
  '지원자 답변이 충분히 구체적입니다. 다음 평가 항목으로 전환을 권장합니다.',
  "답변 완성도 낮음. '{주제}' 부분에서 깊이 있는 후속 질문 권장.",
  '현재 주제 검증 완료. 새로운 섹션 또는 역량 평가 항목으로 이동하십시오.',
].map(t => `- ${t}`).join('\n');

// ─── 엔트리포인트 ─────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // WebSocket 업그레이드는 URL 파싱 전에 먼저 확인
    if (request.headers.get('Upgrade') === 'websocket') {
      const { 0: client, 1: server } = new WebSocketPair();
      server.accept();
      handleSession(server, env);
      return new Response(null, { status: 101, webSocket: client });
    }

    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return json({ status: 'ok', ts: new Date().toISOString() });
    }

    if (request.method === 'GET' && url.pathname === '/') {
      return json({ service: 'gemini-relay', version: '1.3.0' });
    }

    return new Response('WebSocket endpoint — wss:// 로 연결하세요.', { status: 426 });
  },
};

// ─── 세션 핸들러 ──────────────────────────────────────────────────────────────

function handleSession(ws: WebSocket, env: Env): void {
  let session: SessionState | null = null;

  ws.addEventListener('message', async (event: MessageEvent) => {
    try {
      const msg = JSON.parse(event.data as string) as ClientMsg;

      switch (msg.type) {

        // ── 세션 시작 ──────────────────────────────────────────────────────
        case 'session_start':
          session = { last_question: msg.last_question ?? '' };
          send(ws, { type: 'ready' });
          break;

        // ── 지원자 답변 텍스트 수신 → 처리 시작 ───────────────────────────
        case 'user_speech':
          if (!session)          { sendErr(ws, 'Session not started'); return; }
          if (!msg.text?.trim()) { sendErr(ws, 'Empty speech text');   return; }

          send(ws, { type: 'processing' });

          try {
            const result = await processInterview(session, msg.text, env);
            send(ws, result);
            session.last_question = result.content.text;
          } catch (e) {
            sendErr(ws, e instanceof Error ? e.message : 'Unknown error');
          }
          break;
      }
    } catch {
      sendErr(ws, 'Invalid message format');
    }
  });

  ws.addEventListener('close', () => console.log('[relay] 클라이언트 연결 종료'));
  ws.addEventListener('error', (e) => console.error('[relay] WebSocket 오류:', e));
}

// ─── 핵심 처리 ────────────────────────────────────────────────────────────────

async function processInterview(
  session:    SessionState,
  speechText: string,
  env:        Env,
): Promise<ServerContent> {
  const analysisText = await geminiAnalyze(speechText, session.last_question, env.GEMINI_API_KEY);
  const decision     = await inferDecision(session.last_question, analysisText, env.INFER_API_URL, env.INFER_API_TOKEN);

  return {
    type:       'server_content',
    message_id: crypto.randomUUID(),
    content:    { ...decision },
    stt_result: speechText,
    usage:      { timestamp: new Date().toISOString() },
  };
}

// ─── Gemini API — 텍스트 분석 ─────────────────────────────────────────────────

async function geminiAnalyze(
  speechText:   string,
  lastQuestion: string,
  apiKey:       string,
): Promise<string> {
  const prompt = `당신은 대학 입시 면접 분석 전문가입니다.
직전 면접관 질문: ${lastQuestion || '(면접 시작)'}
지원자 답변: ${speechText}

위 답변을 분석하여 아래 형식 중 하나로 한 문장만 출력하세요.
${ANALYSIS_TEMPLATES}

한 문장만 출력. 다른 설명 금지.`;

  const data = await fetchApi<{
    candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
  }>(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2 } }),
    },
    'Gemini',
  );

  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '답변 분석 결과 없음.';
}

// ─── 자체 추론 서버 — Gemma-2b-it + LoRA (ai/server.py) ───────────────────────
//
// 예전에는 HuggingFace 레거시 Serverless Inference API
// (`https://api-inference.huggingface.co/models/...`)를 호출했으나 해당
// 엔드포인트가 폐기되어 DNS조차 해석되지 않는다. 대신 직접 배포한
// FastAPI 서버(ai/server.py, POST /infer)를 호출한다. 프롬프트 구성과
// JSON 파싱/폴백은 그 서버 쪽 책임이며, 여기서는 순수 HTTP 호출만 담당한다.

async function inferDecision(
  lastQuestion: string,
  analysisText: string,
  apiUrl:       string,
  apiToken:     string,
): Promise<ModelDecision> {
  try {
    const data = await fetchApi<Partial<ModelDecision>>(
      `${apiUrl.replace(/\/$/, '')}/infer`,
      {
        method:  'POST',
        headers: { 'Authorization': `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ last_question: lastQuestion, analysis_text: analysisText }),
      },
      'InferAPI',
    );
    return { ...DEFAULT_DECISION, ...data };
  } catch {
    return { ...DEFAULT_DECISION };
  }
}

// ─── 유틸리티 ─────────────────────────────────────────────────────────────────

/** fetch + 상태 코드 검증을 공통화한 헬퍼 */
async function fetchApi<T>(url: string, init: RequestInit, label: string): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${label} ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

function send(ws: WebSocket, data: ServerMsg): void {
  ws.send(JSON.stringify(data));
}

function sendErr(ws: WebSocket, message: string): void {
  send(ws, { type: 'error', message });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
