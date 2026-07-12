# gemini-relay

MMS_ 미소년 면접 시뮬레이터의 중계 서버입니다. Unity WebGL과 AI 추론을 담당하는 Python 프로세스 사이에서 WebSocket 메시지를 그대로 중계합니다.

→ 클라이언트 레포 : [MMS_](https://github.com/mightycha0826/MMS_)

---

## 역할

```
Unity WebGL ──wss──┐                    ┌── Gemini 2.5 Flash (답변 분석)
                    ├─▶ gemini-relay ◀──┤
Python AI worker ───┘  (Durable Object)  └── Gemma LoRA / Gemini (질문·감정 생성)
(interview_question_generator.py)
```

AI 추론(Gemini 답변 분석, 다음 질문/감정 생성)은 **relay가 아니라 별도 Python 프로세스**가 전담합니다. TTS(Supertone)는 **Unity가 직접 호출**합니다 (API 키를 서버에 숨기기 위해 relay를 거치지 않고, Unity가 받은 `content.text`로 직접 Supertone을 호출). relay는 Cloudflare Workers Durable Object 위에서 동작하는 **순수 메시지 라우터**로, 다음만 담당합니다.

1. Unity와 Python 두 WebSocket 연결을 하나의 Durable Object로 모아 상태를 공유
2. Unity가 보낸 `client_msg`를 Python worker로 전달
3. Python이 만든 `server_content`를 올바른 Unity 클라이언트로 라우팅 (`client_session_id` 기준)

---

## 기술 스택

| 항목 | 내용 |
|------|------|
| 런타임 | Cloudflare Workers + Durable Objects |
| 언어 | TypeScript |
| AI 추론 (별도 프로세스) | `interview_question_generator.py` — Gemini 2.5 Flash / Gemma LoRA |
| TTS | Supertone Play API (Unity가 직접 호출, relay는 관여 안 함) |
| 배포 주소 | `wss://gemini-relay.mightycha0826.workers.dev` |

---

## 프로젝트 구조

```
gemini-relay/
├── src/
│   └── index.ts       # Worker + RelayHub(Durable Object) 핵심 코드
├── wrangler.toml      # Cloudflare 배포 설정 (Durable Object 바인딩 포함)
├── tsconfig.json
└── package.json
```

---

## 연결 역할

같은 `/ws` 엔드포인트에 두 종류의 연결이 붙습니다. relay는 연결 시점의 `session` 쿼리파라미터로 역할을 구분합니다.

| 역할 | 접속 방법 | 설명 |
|------|----------|------|
| **AI worker** | `wss://.../ws?session=ai-worker` | Python 프로세스는 반드시 `--session-id ai-worker`로 접속해야 함. 재연결 시에도 즉시 worker로 인식되기 위한 고정 규칙. |
| **Unity 클라이언트** | `wss://.../ws?session=<임의 ID>` | `session` 값은 해당 클라이언트의 기본 식별자로 쓰이며, `client_msg`에 `client_session_id`가 없으면 이 값이 대신 채워짐. |

> Python 실행 예시: `python interview_question_generator.py --session-id ai-worker --gemini-key "..."`

---

## WebSocket 프로토콜

### Unity → relay → Python

```json
{
  "type": "client_msg",
  "department": "컴퓨터공학과",
  "last_question": "자기소개 해주세요",
  "text": "안녕하세요, 저는...",
  "client_session_id": "선택, 없으면 relay가 session 쿼리파라미터로 채움"
}
```

### relay → Unity

```json
// 연결 준비 완료
{ "type": "ready" }

// Python으로 전달 후 처리 중 알림
{ "type": "processing" }

// Python이 만든 결과 (relay는 그대로 전달, 가공 없음)
{
  "type": "server_content",
  "message_id": "uuid",
  "client_session_id": "unity-session-id",
  "content": {
    "text": "LSTM에서 forget gate가 gradient를 어떻게 유지시키는지 설명해보세요.",
    "emotion": { "label": "pressuring", "score": 0.8, "intensity": "high", "action": "avatar_stern" }
  },
  "gemini_analysis": { "dept": "...", "dept_reasoning": "...", "keywords": [...], "summary": "..." },
  "usage": { "timestamp": "2026-..." }
}

// 에러 (AI worker 미연결, 빈 텍스트, JSON 파싱 실패 등)
{ "type": "error", "message": "에러 내용" }
```

`emotion.label`은 Python 쪽에서 `neutral / smile / shy / serious / confused / pressuring / satisfied` 중 하나로 정규화되고, `action`은 그에 대응하는 아바타 모션 키(`avatar_neutral` 등)입니다.

Unity는 `content.text`를 받은 뒤 **자체적으로 Supertone API를 호출**해 오디오를 재생합니다 (relay는 이 과정에 관여하지 않음).

---

## 처리 흐름

```
① Unity, Python 각각 /ws 로 접속
   → 접속 즉시 { type: "ready" } 반환
   → Python은 session=ai-worker 로 접속해 즉시 worker로 등록

② Unity → { type: "client_msg", ... } 수신
   → { type: "processing" } 반환
   → client_session_id 보정 후 Python worker로 전달

③ Python이 Gemini 분석 + 질문/감정 생성 후
   { type: "server_content", client_session_id, content: {...} } 전송

④ client_session_id 로 원래 Unity 연결을 찾아 그대로 전달
   (client_session_id 없으면 = 초기 질문 등 특정 대상 없음 → 연결된 모든
   Unity 클라이언트에 브로드캐스트)

⑤ Unity가 content.text 로 Supertone TTS를 직접 호출해 오디오 재생
```

---

## 로컬 개발 및 배포

```bash
# 의존성 설치
npm install

# 로컬 개발 서버 (Durable Object는 Miniflare가 로컬 에뮬레이션)
npx wrangler dev

# 배포
npx wrangler deploy
```

---

## 엔드포인트

| 경로 | 용도 |
|------|------|
| `wss:///ws?session=...` | Unity / Python worker WebSocket 연결 |
| `GET /health` | 서버 상태 확인 |
| `GET /` | 서비스 정보 |

---

## 관련 레포

- **MMS_** (Unity 클라이언트) : https://github.com/mightycha0826/MMS_
