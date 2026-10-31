# 선택 미디어 기능 설정

기본 채팅은 README의 DeepSeek 설정만으로 사용할 수 있습니다. 아래 기능은 사용할 PC에서 따로 연결합니다. 배포판에는 로그인 세션, API 키, 모델 가중치, 개인 LoRA, 사용자 데이터가 없습니다.

## 기존 설치 업데이트

앱과 해당 앱 서버를 종료한 뒤 새 ZIP을 별도 폴더에 풉니다. 기존 `data`를 유지한 상태로 프로그램 파일만 교체하거나, 기존 `data`를 새 폴더로 복사해 실행하세요. 다른 PC의 `data`를 공유하지 마세요. 원래 설정·대화·업로드는 초기화하지 않습니다.

## Grok 구독

Grok CLI를 별도 설치하고 본인의 구독 계정으로 로그인합니다. 기본 검색 위치는 `%USERPROFILE%\.grok\bin\grok.exe`이며 `GROK_CLI_PATH` 또는 설정의 `grok.cliPath`로 바꿀 수 있습니다. 개발 시 확인한 CLI는 1.0.70입니다. CLI 업데이트에 따라 제공 도구가 달라질 수 있습니다.

앱을 종료한 상태에서 `data/settings.json`의 기존 나머지 항목을 유지하고 `grok` 부분을 설정합니다.

```json
"grok": {
  "enabled": true,
  "mode": "subscription",
  "cliPath": "",
  "timeoutSeconds": 900
}
```

미디어 화면에서 Grok 연결을 확인하고 이미지 또는 영상을 선택합니다. 영상 옵션은 6초·10초, 480p·720p입니다. 실제 사용 가능 여부와 한도는 로그인한 구독과 CLI가 결정합니다. API 키로 자동 우회하지 않습니다. CLI 설정에 API 키가 있으면 구독 전용 연결을 차단합니다.

영상이 ZDR 설정으로 차단되면 본인이 Grok CLI의 `/privacy`에서 보관 정책을 확인하고 선택해야 합니다. 앱은 개인정보 설정을 자동 변경하지 않습니다. 구독 로그인·동의 정보는 각 PC에만 보관합니다.

## ANIMA 로컬

기존 ANIMA Studio 설치와 모델이 필요합니다. 이 배포판이 ANIMA나 ComfyUI·학습 모델을 설치하지는 않습니다. 설정의 `anima` 항목을 다음과 같이 연결하고 실제 설치 경로에 맞게 바꿉니다.

```json
"anima": {
  "enabled": true,
  "root": "D:/AnimaStudio",
  "apiUrl": "http://127.0.0.1:17861",
  "preset": "turbo",
  "lora": "",
  "loraStrength": 0.8
}
```

로컬 ANIMA 서버의 `.local/token`을 해당 설치에서 읽으며 다른 PC의 토큰은 복사하지 않습니다. 텍스트→이미지와 LoRA를 지원합니다. 이미지→이미지·영상은 지원하지 않습니다. 가로 1280×720, 세로 720×1280, 정사각 1024×1024 옵션이 있습니다.

학습 감시 폴더 기본값은 `D:/lora_train`입니다. 다른 경로라면 실행 전 `FLASH_ANIMA_TRAINING_ROOT` 환경변수로 지정합니다. 호환되는 `background-state.json`·`background-supervisor.json`이 학습 중인 프로세스를 보고하면 새 추론 기동을 보류합니다. 학습 상태가 없으면 학습 여부를 알 수 없으므로 운영자가 GPU 사용 상태를 확인하세요.

## 이미지·영상 검수와 미디어 도구

- 이미지 검수에는 이미지 입력을 지원하는 현재 채팅 모델이 필요합니다. `inspect_image`는 실제 픽셀을 전달하며 원본을 `reference`로 대조할 수 있습니다.
- 영상 검수·미디어 도구는 `ffmpeg`·`ffprobe`를 PATH에 준비합니다. `inspect_video` 기본값은 처음 120초 이내 6장입니다. `timestamps`로 문제 시각을 지정할 수 있습니다. 원본 참조 포함 최대 8장입니다.
- `pixels_ready`는 픽셀 전달 준비 상태입니다. 모델이 실제 이미지를 보고 판단해야 하며 합격 판정 자체를 뜻하지 않습니다. 프레임 사이 움직임·전체 립싱크·음성 내용은 이 표본만으로 확인할 수 없습니다.
- `media_info`, `media_checks`, `media_export`로 정보·검정 화면·정지 후보·음량·구간 추출을 처리합니다. 결과는 새 파일로 쓰며 원본을 보존합니다.
- 파일은 첨부하거나 설정의 허용 폴더에 두세요. 임의의 외부 경로는 읽지 않습니다. 검수는 현재 채팅 공급자에게 픽셀을 보내므로 해당 모델의 입력 사용량이 발생할 수 있습니다.

## 압축 파일

PATH에 Python 3를 준비합니다. `list_archive`로 목록을 읽고 `unzip_file`의 `members`로 필요한 파일만 풀 수 있습니다. ZIP·TAR·TGZ와 Python이 지원하는 TAR 압축 형식을 처리합니다. 암호화 ZIP·RAR·7z는 지원하지 않습니다. 기존의 다른 파일은 덮어쓰지 않으며 동일 ZIP 내용은 재사용합니다. 해제 후 `inspect_image`·`inspect_video`로 실제 파일을 확인합니다.

## 기존 MiniMax H3 서버 연결

이미 `/opt/h3` 런타임·모델·BAO worker가 설치된 단일 A100 80GB GCP VM을 운영하는 관리자를 위한 선택 기능입니다. 새 VM·모델을 자동 설치하는 기능은 아닙니다. 직원에게 이 기능이 필요하지 않으면 설정하지 않아도 다른 기능을 사용할 수 있습니다.

PowerShell 7의 `pwsh.exe`, Google Cloud CLI 및 권한 있는 본인 계정의 CLI 인증을 준비합니다. 앱을 시작하는 환경에서 아래 값을 설정하세요. 예시는 실제 운영 정보로 교체합니다.

```powershell
$env:FLASH_H3_GCP_PROJECT = 'example-project'
$env:FLASH_H3_GCP_ZONE = 'us-central1-a'
$env:FLASH_H3_GCP_VM = 'h3-worker'
$env:FLASH_H3_GCP_ACCOUNT = 'operator@example.com'
$env:FLASH_H3_BAO_ORIGIN = 'https://example.com'
# pwsh.exe가 PATH에 없다면 설치된 실제 절대 경로를 지정합니다.
$env:FLASH_H3_POWERSHELL = 'C:\Program Files\PowerShell\7\pwsh.exe'
node app/server.js
```

영구 설정이 필요하면 Windows 사용자 환경변수에 등록하고 앱을 다시 시작합니다. 실제 값은 Git에 커밋하지 마세요. 기존에 `integrations/minimax-h3/profile.json`을 쓰는 설치는 `{"schemaVersion":1,"powershell":"실제 pwsh.exe 절대 경로"}` 형식도 지원합니다. 이 파일은 배포·Git에서 제외합니다.

MCP 화면에서 본인 권한으로 `bao-production` 연결을 등록합니다. BAO 프로젝트 ID는 GCP 프로젝트 ID와 다르므로 현재 연결에서 조회해 사용합니다. 클라우드 대상은 앱 시작 시 고정되며 모델 인수로 바꿀 수 없습니다. 미설정 상태에서는 `H3_NOT_CONFIGURED`로 종료하고 클라우드 명령을 실행하지 않습니다. 저장 작업 계약 조회는 기존 BAO MCP만으로 가능합니다.

순서: `minimax_h3_status` → `minimax_h3_runtime` → 빈 큐·프로젝트·프로필·모델 파일·미완료 영수증 확인 → 필요한 경우 `minimax_h3_power`의 `plan_start`, `start_prepare`, `bind_project`, `start_services`를 사용합니다. `start_prepare`는 부팅 자동 서비스가 기존 큐를 처리할 수 있다는 명시적 확인이 필요합니다. `bind_project`는 현재 프로젝트 ID를 함께 지정하고 서비스·포트·GPU·DB·영수증 idle 및 두 프로젝트의 빈 큐를 확인합니다. 인증·모델 프로필은 보존합니다.

종료는 `plan_stop`·`stop`으로 기존 idle 검증을 통과한 뒤 TERMINATED를 확인합니다. 응답이 끊기면 자동 재시도하지 않고 상태부터 다시 조회합니다. 관리 도구 자체는 새 렌더를 제출하지 않지만 서비스 기동은 연속 worker가 기존·이후 큐를 처리하게 할 수 있습니다. 모델 파일 확인과 GPU 점검만으로 실제 렌더 성공을 주장하지 않습니다. VM 기동·운영의 클라우드 비용은 별도입니다.

helper는 SHA-256으로 고정합니다. helper 변경 시 코드의 핀도 검토 후 함께 갱신해야 하며 임의 변경은 실행을 차단합니다. 직원용 ZIP에는 운영 계정·서비스 키·worker 인증·작업 영수증·복원 스크립트가 포함되지 않습니다.
