/**
 * gemini-relay — Cloudflare Worker
 *
 * Unity WebGL (GeminiClient.cs) ←──wss://──→ 이 Worker
 *
 * STT/TTS는 Unity WebGL에서 Web Speech API로 직접 처리.
 * relay는 텍스트만 받아서 분석 + 다음 질문 결정만 담당.
 *
 * 흐름 (1턴 기준):
 *   1. Unity → session_start (학과, 직전 질문)
 *   2. Unity → user_speech  (지원자 답변 텍스트)
 *   3. Worker → Gemini API  : 답변 품질 분석
 *   4. Worker → HuggingFace : 다음 질문 결정
 *   5. Worker → Unity       : server_content 반환
 */

// ─── Env ──────────────────────────────────────────────────────────────────────

interface Env {
  GEMINI_API_KEY: string; // wrangler secret put GEMINI_API_KEY
  HF_TOKEN:       string; // wrangler secret put HF_TOKEN
  HF_MODEL_ID:    string; // wrangler.toml [vars]
}

// ─── 프로토콜 타입 ────────────────────────────────────────────────────────────

/** Unity → Relay */
type ClientMsg =
  | { type: 'session_start'; department: string; last_question: string }
  | { type: 'user_speech';   text: string };

/** Relay → Unity */
type ServerMsg =
  | { type: 'ready' }
  | { type: 'processing' }
  | ServerContent
  | { type: 'error'; message: string };

interface ServerContent {
  type: 'server_content';
  message_id: string;
  content: {
    text:     string;
    decision: 'follow_up' | 'next_topic';
    emotion:  { label: string; score: number; intensity: 'low' | 'medium' | 'high' };
    is_final: boolean;
  };
  stt_result: string;
  usage: { timestamp: string };
}

/** 세션 내부 상태 */
interface SessionState {
  department:    string;
  last_question: string;
}

// ─── 엔트리포인트 ─────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return json({ status: 'ok', ts: new Date().toISOString() });
    }

    if (request.method === 'GET' && url.pathname === '/') {
      return json({ service: 'gemini-relay', version: '1.1.0' });
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('WebSocket endpoint — wss:// 로 연결하세요.', { status: 426 });
    }

    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    handleSession(server, env);

    return new Response(null, { status: 101, webSocket: client });
  },
};

// ─── 세션 핸들러 ──────────────────────────────────────────────────────────────

function handleSession(ws: WebSocket, env: Env): void {
  let session: SessionState | null = null;

  ws.addEventListener('message', async (event: MessageEvent) => {
    try {
      const raw =
        typeof event.data === 'string'
          ? event.data
          : new TextDecoder().decode(event.data as ArrayBuffer);
      const msg = JSON.parse(raw) as ClientMsg;

      switch (msg.type) {

        // ── 세션 시작 ──────────────────────────────────────────────────────
        case 'session_start':
          session = {
            department:    msg.department,
            last_question: msg.last_question ?? '',
          };
          send(ws, { type: 'ready' });
          break;

        // ── 지원자 답변 텍스트 수신 → 처리 시작 ───────────────────────────
        case 'user_speech':
          if (!session)          { send(ws, err('Session not started')); return; }
          if (!msg.text?.trim()) { send(ws, err('Empty speech text'));   return; }

          send(ws, { type: 'processing' });

          try {
            const result = await processInterview(session, msg.text, env);
            send(ws, result);
          } catch (e) {
            send(ws, err(e instanceof Error ? e.message : 'Unknown error'));
          }
          break;
      }
    } catch {
      send(ws, err('Invalid message format'));
    }
  });

  ws.addEventListener('close', () => console.log('[relay] 클라이언트 연결 종료'));
  ws.addEventListener('error', (e) => console.error('[relay] WebSocket 오류:', e));
}

// ─── 핵심 처리 ────────────────────────────────────────────────────────────────

async function processInterview(
  session:     SessionState,
  speechText:  string,
  env:         Env,
): Promise<ServerContent> {

  // Step 1: Gemini — 답변 텍스트 분석
  const analysisText = await geminiAnalyze(
    speechText,
    session.department,
    session.last_question,
    env.GEMINI_API_KEY,
  );

  // Step 2: HuggingFace — 다음 질문 결정
  const decision = await hfInference(
    session.department,
    session.last_question,
    analysisText,
    env.HF_TOKEN,
    env.HF_MODEL_ID,
  );

  return {
    type:       'server_content',
    message_id: crypto.randomUUID(),
    content: {
      text:     decision.text,
      decision: decision.decision,
      emotion:  decision.emotion,
      is_final: decision.decision === 'next_topic',
    },
    stt_result: speechText,  // Web Speech API가 변환한 텍스트 그대로 반환
    usage: { timestamp: new Date().toISOString() },
  };
}

// ─── Gemini API — 텍스트 분석 ─────────────────────────────────────────────────

async function geminiAnalyze(
  speechText:   string,
  department:   string,
  lastQuestion: string,
  apiKey:       string,
): Promise<string> {

  const prompt = `당신은 대학 입시 면접 분석 전문가입니다.
지원 학과: ${department}
직전 면접관 질문: ${lastQuestion || '(면접 시작)'}
지원자 답변: ${speechText}

위 답변을 분석하여 아래 형식 중 하나로 한 문장만 출력하세요.
- '{키워드}' 키워드 언급했으나 메커니즘 설명 없음. 꼬리질문으로 검증 필요.
- 이 항목 평가 충분. 자연스러운 주제 전환을 권장합니다.
- '{개념}'에 대한 답변이 추상적입니다. 구체적 근거나 사례 요구 권장.
- 면접 진행상 다음 파트로 넘어갈 적절한 시점입니다.
- 지원자 답변이 충분히 구체적입니다. 다음 평가 항목으로 전환을 권장합니다.
- 답변 완성도 낮음. '{주제}' 부분에서 깊이 있는 후속 질문 권장.
- 현재 주제 검증 완료. 새로운 섹션 또는 역량 평가 항목으로 이동하십시오.

한 문장만 출력. 다른 설명 금지.`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2 },
      }),
    },
  );

  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);

  const data = await res.json() as {
    candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
  };

  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim()
    ?? '답변 분석 결과 없음.';
}

// ─── HuggingFace — 파인튜닝 모델 추론 ────────────────────────────────────────

const SYSTEM_PROMPT = `당신은 대학 입시 면접관 AI입니다.
Gemini 음성 분석 결과와 직전 면접 맥락을 입력받아,
다음 행동을 결정하고 JSON 패킷 하나만 출력하십시오.

판단 기준:
  follow_up  : 답변이 모호하거나 핵심 키워드 검증이 필요한 경우 → 날카로운 꼬리질문
  next_topic : 답변이 충분히 구체적이거나 새 섹션으로 이동할 경우 → 자연스러운 전환

출력은 반드시 유효한 JSON 하나만 생성하십시오. 설명/마크다운 절대 금지.`;

interface ModelDecision {
  text:     string;
  decision: 'follow_up' | 'next_topic';
  emotion:  { label: string; score: number; intensity: 'low' | 'medium' | 'high' };
}

async function hfInference(
  department:   string,
  lastQuestion: string,
  analysisText: string,
  hfToken:      string,
  modelId:      string,
): Promise<ModelDecision> {

  const userMsg = `학과: ${department}\n직전 면접관 질문: ${lastQuestion}\nGemini 분석 결과: ${analysisText}`;
  const prompt  = `<bos><start_of_turn>system\n${SYSTEM_PROMPT}<end_of_turn>\n<start_of_turn>user\n${userMsg}<end_of_turn>\n<start_of_turn>model\n`;

  const MODEL_URL = `https://api-inference.huggingface.co/models/${modelId}`;

  const res = await fetch(MODEL_URL, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${hfToken}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      inputs: prompt,
      parameters: {
        max_new_tokens:   300,
        temperature:      0.7,
        return_full_text: false,
        stop_sequences:   ['<end_of_turn>'],
      },
    }),
  });

  if (!res.ok) throw new Error(`HuggingFace ${res.status}: ${await res.text()}`);

  const data      = await res.json() as Array<{ generated_text: string }>;
  const generated = data[0]?.generated_text ?? '';

  try {
    const match = generated.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('JSON not found in model output');

    const parsed = JSON.parse(match[0]) as {
      content?: {
        text?:     string;
        decision?: 'follow_up' | 'next_topic';
        emotion?:  { label: string; score: number; intensity: 'low' | 'medium' | 'high' };
      };
    };

    return {
      text:     parsed.content?.text     ?? '다음 질문을 해주세요.',
      decision: parsed.content?.decision ?? 'follow_up',
      emotion:  parsed.content?.emotion  ?? { label: '중립/전환', score: 0.7, intensity: 'medium' },
    };
  } catch {
    return {
      text:     '답변 감사합니다. 다음으로 넘어가겠습니다.',
      decision: 'next_topic',
      emotion:  { label: '중립/전환', score: 0.7, intensity: 'medium' },
    };
  }
}

// ─── 유틸리티 ─────────────────────────────────────────────────────────────────

function send(ws: WebSocket, data: ServerMsg): void {
  ws.send(JSON.stringify(data));
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function err(message: string): { type: 'error'; message: string } {
  return { type: 'error', message };
}
