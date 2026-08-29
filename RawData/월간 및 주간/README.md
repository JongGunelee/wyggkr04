# 월간·주간 회의 데이터

이 폴더는 월간/주간 회의 화면과 통합 현황 화면이 함께 사용하는 GitHub 기반 데이터 계층입니다. 내비게이션의 작성/미작성 상태는 `회의_안건_현황.xlsb`를 단일 기준 데이터로 사용합니다.

## 폴더 구성

- `runtime/`: XLSB 저장소, GitHub 인증, 내비게이션 상태 브리지
- `vendor/`: 브라우저에서 XLSB를 읽고 쓰는 SheetJS 런타임
- `tools/`: 부트스트랩 생성과 무결성 검증 도구
- `docs/`: 데이터 계약과 운영 규칙
- `evidence/`: 화면·동작 검증 증빙

## 화면 동작

1. 월간/주간 HTML은 공개 GitHub XLSB를 자동으로 읽습니다.
2. 작성 상태는 HTML에 중복 저장하지 않고 GitHub XLSB를 단일 기준으로 사용합니다.
3. 사용자가 상태 버튼을 누르면 화면에 즉시 반영하고 IndexedDB 대기열에 먼저 기록합니다.
4. 기존 암호화 PAT 인증이 성공하면 충돌 검사를 거쳐 XLSB를 GitHub에 저장합니다.
5. 네트워크 실패나 인증 취소 시 변경은 브라우저 캐시와 대기열에 남습니다.

기존 HTML 데이터 이관 현황:

- 주간 작성 147건: XLSB 상태와 일치 확인 완료
- 월간 과거 미작성 110건: `LEGACY_NAVIGATOR_ONLY`로 이관 완료
- 과거 월간 110건은 통합 현황 집계를 바꾸지 않도록 `카운터포함=N`, `카드표시=N`으로 보존

## 회의록 파일 자동 대조

- 월간 작성 상태는 `JongGunelee/wyggkr`의 `YYYY/YYYY_MM_회의록.html|pdf` 파일 존재 여부를 기준으로 합니다.
- 주간 작성 상태는 `JongGunelee/wyggkr03`의 `YYYY/YYYY_MM_WW_회의록.html|pdf` 파일 존재 여부를 기준으로 합니다.
- `tools/reconcile_meeting_files.mjs`가 실제 파일과 XLSB를 양방향 대조하여 파일이 있으면 `작성`, 없으면 `미작성`으로 맞춥니다.
- `.github/workflows/reconcile-meeting-status.yml`이 매시간 및 수동 실행 시 XLSB와 직접 파일 실행용 부트스트랩을 자동 갱신합니다.
- 기존 행과 변경이력은 보존하고 실제 상태가 달라진 키만 추가 전용 변경이력으로 기록합니다.

오프라인 동작:

- 마지막 정상 동기화 상태를 월간·주간별 브라우저 캐시에 보존합니다.
- 오프라인을 감지하면 원격 요청을 기다리지 않고 캐시 상태로 즉시 화면을 구성합니다.
- 오프라인 중 상태 변경은 IndexedDB 대기열에 보존하며, 인터넷 복구 시 최신 GitHub 상태를 자동 재조회합니다.
- 최초 실행부터 오프라인이고 캐시가 없는 경우에는 상태를 추정하지 않고 `미지정`으로 표시합니다.

토큰은 HTML, XLSB, 저장소 파일에 기록하지 않습니다. 인증은 `runtime/meeting-github-credential.js`와 기존 암호화 토큰 보관소만 사용합니다.

상세 계약은 [docs/navigator-status-contract.md](docs/navigator-status-contract.md)를 참고하세요.
