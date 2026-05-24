# gemini-relay

MMS_ 미소년 면접 시뮬레이터의 중계 서버입니다. Unity WebGL과 AI API 사이에서 WebSocket으로 통신을 중계하고, 지원자 답변을 분석하여 다음 면접 질문을 결정합니다.

→ 클라이언트 레포 : [MMS_](https://github.com/mightycha0826/MMS_)

---

## 역할

```
Unity WebGL  ──wss://──▶  gemini-relay  ──▶  Gemini API   (답변 분석)
                                         ──▶  HuggingFace  (다음 질문 결정)
```

1. Unity에서 지원자 답변 텍스트 수신 (Web Speech API로 변환된 결과)
2. Gemini API로 답변 품질 분석
3. 파인튜닝된 LoRA 모델로 다음 질문 및 면접관 감정 결정
4. 결과 JSON을 Unity로 반환

---

## 기술 스택

| 항목 | 내용 |
|------|------|
| 런타임 | Cloudflare Workers |
| 언어 | TypeScript |
| 텍스트 분석 | Google Gemini 2.0 Flash |
| AI 추론 | HuggingFace Inference API (`ai-mms/ai-gemma-lora-model`) |
| 배포 주소 | `wss://gemini-relay.mightycha0826.workers.dev` |

---

## 프로젝트 구조

```
gemini-relay/
├── src/
│   └── index.ts       # Worker 핵심 코드
├── wrangler.toml      # Cloudflare 배포 설정
├── tsconfig.json
└── package.json
```

---

## WebSocket 프로토콜

### Unity → relay

```json
// 1. 면접 턴 시작
{
  "type": "session_start",
  "department": "컴퓨터공학부",
  "last_question": "자기소개 해주세요"
}

// 2. 지원자 답변 텍스트 전송
{
  "type": "user_speech",
  "text": "안녕하세요, 저는..."
}
```

### relay → Unity

```json
// 처리 중 알림
{ "type": "processing" }

// 최종 결과
{
  "type": "server_content",
  "message_id": "uuid",
  "content": {
    "text": "딥러닝에서 역전파 알고리즘을 설명해주세요",
    "decision": "follow_up",
    "emotion": {
      "label": "날카로움/압박",
      "score": 0.83,
      "intensity": "medium"
    },
    "is_final": false
  },
  "stt_result": "안녕하세요, 저는...",
  "usage": { "timestamp": "2026-..." }
}

// 에러
{ "type": "error", "message": "에러 내용" }
```

| `decision` | 의미 |
|-----------|------|
| `follow_up` | 꼬리질문 — 같은 주제 심화 (`is_final: false`) |
| `next_topic` | 주제 전환 — 다음 평가 항목 (`is_final: true`) |

---

## 처리 흐름

```
① session_start 수신
   → 학과명, 직전 질문 세션에 저장
   → { type: "ready" } 반환

② user_speech 수신
   → { type: "processing" } 반환

③ Gemini API 호출 (텍스트 분석)
   입력: 지원자 답변 + 학과 + 직전 질문
   출력: "'키워드' 언급했으나 메커니즘 설명 없음. 꼬리질문으로 검증 필요."

④ HuggingFace LoRA 모델 호출
   입력: Gemini 분석 결과 (Gemma chat template 형식)
   출력: { text, decision, emotion }

⑤ server_content 반환
```

---

## 환경변수

| 변수 | 설명 | 설정 방법 |
|------|------|----------|
| `GEMINI_API_KEY` | Google AI Studio API 키 | `wrangler secret put GEMINI_API_KEY` |
| `HF_TOKEN` | HuggingFace Access Token | `wrangler secret put HF_TOKEN` |
| `HF_MODEL_ID` | `ai-mms/ai-gemma-lora-model` | `wrangler.toml [vars]` |

---

## 로컬 개발 및 배포

```bash
# 의존성 설치
npm install

# 로컬 개발 서버
npx wrangler dev

# 시크릿 등록
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put HF_TOKEN

# 배포
npx wrangler deploy
```

---

## 엔드포인트

| 경로 | 용도 |
|------|------|
| `wss://` | Unity WebSocket 연결 |
| `GET /health` | 서버 상태 확인 |
| `GET /` | 서비스 정보 |

---

## 관련 레포

- **MMS_** (Unity 클라이언트) : https://github.com/mightycha0826/MMS_
