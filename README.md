# Flash Studio

내 PC에 설치해서 쓰는 LLM 채팅 스튜디오입니다. **공개 배포판의 기본 모델은 DeepSeek 공식 API의 V4.1 Flash (1017)**입니다. BytePlus ModelArk를 포함해 OpenAI 호환 API라면 다른 공급자도 연결할 수 있습니다. 외부 패키지 없이 Node.js 하나로 돌아갑니다.

## 직원용 다운로드 (Windows x64)

1. [최신 배포 파일](https://github.com/jangrno123/flash-studio/releases/latest)에서 **Flash-Studio-DeepSeek-4.1-Windows-x64.zip**을 내려받습니다. 공개 저장소이므로 GitHub 로그인이나 초대가 필요 없습니다.
2. 쓰기 가능한 원하는 폴더에 **압축을 전부 풀고** `Flash Studio.vbs`를 더블클릭합니다. ZIP 안에서 바로 실행하지 마세요.
3. **설정 → 모델 공급자 → DeepSeek 공식**에 자신의 DeepSeek API 키를 입력합니다. 기본으로 선택된 **DeepSeek V4.1 Flash (1017)**를 사용합니다.
4. 바탕화면 바로가기가 필요하면 `install.bat`을 실행합니다. 바로가기는 선택 사항입니다.

배포 ZIP에는 검증된 Node.js 24 LTS 런타임이 포함되어 있어 Node.js를 따로 설치하지 않아도 됩니다. API 키, 대화, 업로드, 작업 파일, 브라우저 로그인 정보는 포함하지 않습니다. 첫 실행에서 해당 PC의 `data` 폴더가 새로 만들어집니다. 모델 가중치를 오프라인으로 설치하는 앱은 아니며 **API 연결과 사용 요금은 별도**입니다.

### 다른 키를 사용하는 경우

- 회사 BytePlus 키를 쓰려면 공급자 `BytePlus ModelArk`를 선택하고 `ARK_API_KEY` 환경변수 또는 앱 설정에 키를 입력합니다. 회사가 별도로 안내한 4.1 엔드포인트 ID를 모델에 등록하고 선택하세요. 회사 엔드포인트 ID와 키는 공개 배포하지 않습니다.
- **DeepSeek 공식 API 키**를 쓰려면 공급자 `DeepSeek 공식`, 모델 `DeepSeek V4.1 Flash (1017)`을 선택하고 `DEEPSEEK_API_KEY`를 등록합니다. 공식 호출 ID는 `deepseek-flash`입니다. [공식 모델 안내](https://api-docs.deepseek.com/en/)
- 이미지 생성(Seedream)은 BytePlus 키가 필요합니다. DeepSeek 공식 키만 등록한 경우 이미지 공급자의 키도 별도로 입력해야 합니다.
- BAO 및 다른 MCP 서비스는 각 직원에게 허용된 주소와 인증 정보를 MCP 화면에서 따로 등록합니다. 기존 사용자의 MCP 인증 파일은 복사하지 않습니다.
- 외부 MCP 도구가 `npx`, `python`, `uvx`를 요구하면 해당 런타임은 별도 설치합니다. 앱 자체와 기본 echo 테스트에는 추가 패키지가 필요 없습니다.

기존 사용자는 `data` 폴더를 덮어쓰거나 지우지 마세요. 이 배포판은 새 PC의 기본 선택만 4.1로 맞추며, 이미 저장된 설정이나 기존 대화를 자동으로 변경하지 않습니다.

## 설치와 실행

1. 소스 코드만 받은 경우 Node.js 18 이상이 있어야 합니다. Node.js 24 LTS를 권장합니다. 배포 ZIP은 런타임이 포함되어 있습니다.
2. `install.bat` 을 더블클릭하면 바탕화면과 시작 메뉴에 **Flash Studio** 바로가기가 생깁니다.
3. 바로가기를 누르면 서버가 백그라운드에서 뜨고 앱 창(Edge 앱 모드)이 열립니다. 창을 닫고 몇 분 지나면 서버도 알아서 꺼집니다.

수동으로 띄우려면 `node app\server.js` 를 실행한 뒤 http://127.0.0.1:17860 에 접속하면 됩니다.

## API 키 등록

키는 두 가지 방법 중 편한 쪽으로 넣으세요. 기본 공급자는 DeepSeek 공식입니다.

- **환경변수 (권장)** — PowerShell에서 한 번만 실행합니다. 앱은 `DEEPSEEK_API_KEY` 를 자동으로 읽어요.
  ```powershell
  setx DEEPSEEK_API_KEY "발급받은_키"
  ```
- **앱 설정** — 설정 → 모델 공급자 → API 키 칸에 붙여넣고 저장합니다. 키는 `data\settings.json` 에 저장됩니다.

### 모델 ID 확인

DeepSeek 공식 V4.1 Flash의 호출 ID는 **deepseek-flash**입니다. ModelArk에서 실제로 호출할 모델 ID(또는 `ep-...` 로 시작하는 엔드포인트 ID)는 계정마다 다를 수 있으니 해당 계정의 4.1 모델 ID를 설정에 등록하세요. **연결 테스트**는 실제 모델 요청을 보내므로 API 사용량이 발생할 수 있습니다. 중국 리전 키라면 `Volcengine Ark (중국)` 공급자를 선택하고 그 계정의 4.1 모델 ID를 입력하세요.

## 개발 및 배포

`npm test` 또는 `node scripts/test.cjs`로 로컬 회귀 검사를 실행합니다. 포터블 ZIP에서는 `runtime\node.exe scripts\test.cjs`를 사용합니다. `npm start`는 소스 실행용입니다. `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-release.ps1`은 공식 Node.js 배포 파일의 SHA-256을 확인하고 개인 데이터가 없는 Windows x64 ZIP을 `dist`에 만듭니다. 런타임의 라이선스는 배포 ZIP의 `runtime/LICENSE`에 있습니다.

## 기능

| 기능 | 설명 |
|---|---|
| 채팅 | 스트리밍 응답, 마크다운·표·코드 블록, 대화 검색·고정·이름 바꾸기·마크다운 내보내기 |
| 확장 사고 | 입력창의 **사고** 버튼. DeepSeek의 추론 과정을 접었다 펼 수 있게 보여 줍니다 |
| 첨부 | 드래그 앤 드롭, 붙여넣기, + 버튼. 텍스트·코드 파일은 내용이 그대로 들어가고, 이미지는 비전 모델에 전달되거나 이미지 생성의 참조로 쓰입니다 |
| 이미지 생성 | Seedream 등 `/images/generations` 호환 모델. 모델이 `generate_image` 도구로 직접 만들거나, **이미지** 모드로 바로 생성합니다. 결과는 `data\images` 에 저장 |
| MCP | stdio(npx·uvx·node·python), Streamable HTTP, SSE 지원. Claude Desktop 설정을 그대로 가져올 수 있어요 |
| 스킬 | `SKILL.md` 형식. 모델이 목록을 보고 필요할 때 `load_skill` 로 불러오고, `/` 로 직접 첨부할 수도 있습니다. Claude 스킬 폴더(`~/.claude/skills`)를 기본으로 함께 읽어요 |
| 프롬프트 | `{{변수}}`, `{{변수:기본값}}` 자리표시자를 쓰는 템플릿 라이브러리. 입력창에서 `/` 로 불러옵니다 |
| 내장 도구 | 이미지 생성, 스킬 로드, 웹 페이지 가져오기, 작업 폴더 파일 읽기·쓰기, PowerShell 실행(기본 꺼짐) |
| 도구 승인 | 쓰기·명령·MCP 도구는 실행 전에 허용 여부를 묻습니다. 설정에서 자동 실행으로 바꿀 수 있어요 |
| HTML 미리보기 | 답변의 `html`·`svg` 코드 블록에서 **미리보기** 를 누르면 오른쪽 패널에 렌더링됩니다 |

### 단축키

`Enter` 보내기 · `Shift+Enter` 줄바꿈 · `/` 프롬프트·스킬 · `Ctrl+Shift+O` 새 채팅 · `Ctrl+B` 사이드바 · `Ctrl+K` 대화 검색 · `Esc` 닫기/중단

## 폴더 구조

```
D:\FlashStudio
├─ Flash Studio.vbs        실행기 (서버 기동 + 앱 창)
├─ install.bat / .ps1      바로가기 생성
├─ uninstall.bat           바로가기 제거 (데이터는 남김)
├─ app.ico
├─ app\
│  ├─ server.js            HTTP 서버와 REST API
│  ├─ lib\
│  │  ├─ schema.js         JSON Schema 검증기 (의존성 없음)
│  │  ├─ store.js          파일 저장소 (모든 읽기·쓰기를 스키마로 검증)
│  │  ├─ llm.js            OpenAI 호환 스트리밍 클라이언트, 이미지 생성
│  │  ├─ chat.js           대화 실행기 (히스토리 → 스트리밍 → 도구 루프 → 저장)
│  │  ├─ tools.js          내장 도구
│  │  ├─ mcp.js            MCP 클라이언트 (stdio / HTTP / SSE)
│  │  ├─ skills.js         SKILL.md 로더
│  │  └─ seed.js           첫 실행 기본 데이터
│  ├─ public\              화면 (index.html, app.js, styles.css, markdown.js)
│  └─ examples\echo-mcp-server.js   MCP 연결 확인용 서버
├─ schemas\                데이터 구조 정의 (JSON Schema 2020-12)
└─ data\                   내 데이터 (설정, 대화, 첨부, 이미지, 스킬, 작업 폴더, 로그)
```

## 스키마

모든 설정과 데이터는 `schemas\` 의 JSON Schema로 검증한 뒤에만 저장됩니다. 파일을 직접 고쳤다가 형식이 틀리면 앱이 어느 항목이 문제인지 알려 줍니다.

| 스키마 | 대상 |
|---|---|
| `settings.schema.json` | `data\settings.json` — 공급자, 생성 옵션, 이미지, 도구, 스킬, 화면, 서버 |
| `provider.schema.json` | 공급자 하나 (Base URL, 키, 모델 목록, 사고 파라미터 방식) |
| `conversation.schema.json` | `data\conversations\*.json` — 메시지와 파트(text · reasoning · tool_call · image) |
| `attachment.schema.json` | 첨부 파일 메타데이터 |
| `prompts.schema.json` | `data\prompts.json` — 프롬프트 라이브러리 |
| `mcp.schema.json` | `data\mcp.json` — Claude Desktop 호환 `mcpServers` |
| `skill.schema.json` | 스킬 메타데이터와 새 스킬 요청 |
| `tool-definition.schema.json` | 모델에 넘기는 함수 도구 정의 |
| `chat-request.schema.json` | `POST /api/chat` 요청 본문 |
| `stream-event.schema.json` | `POST /api/chat` 응답 스트림 이벤트 |

## MCP 서버 추가 예시

MCP 커넥터 화면에서 **서버 추가** 를 누르거나, **JSON 편집** 에 아래처럼 넣으면 됩니다.

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "D:\\FlashStudio\\data\\workspace"]
    },
    "remote-example": {
      "type": "http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ..." }
    }
  }
}
```

`autoApprove: true` 를 넣으면 그 서버의 도구는 묻지 않고 실행하고, `alwaysAllow: ["도구이름"]` 으로 도구별로 허용할 수도 있어요.

## 보안 메모

- 서버는 `127.0.0.1` 에만 열립니다. 다른 사이트가 로컬 API를 호출하지 못하도록 전용 헤더와 Host 검사를 거칩니다.
- 파일 쓰기는 `data\workspace` 안에서만 됩니다. 읽기 허용 폴더는 설정 → 도구·권한에서 추가하세요.
- PowerShell 실행 도구는 기본으로 꺼져 있습니다.
