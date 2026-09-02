# `.github` 운영 철학과 무결성 보증 규칙

이 폴더는 회의 HTML 화면을 직접 실행하는 코드가 아니라, `wyggkr04` 저장소의 자동 동기화·검증·변경 통제를 담당하는 CI 경계이다. 화면과 데이터가 우연히 서로 다른 상태로 배포되지 않도록 “검증이 통과한 경우에만 쓰기와 커밋을 허용한다”는 원칙을 적용한다.

## 1. 구성과 목적

- `workflows/reconcile-meeting-status.yml`: 매시간 17분, 관련 경로 push, 수동 실행에서 회의 상태를 대조한다.
- `scripts/validate-meeting-integrity.mjs`: XLSB 구조·필수 시트·데이터 행·이력·부모 커밋 대비 급격한 축소·생성 부트스트랩의 SHA-256을 검사한다.
- `RawData/월간 및 주간/tools/reconcile_meeting_files.mjs`: `JongGunelee/wyggkr`(월간)와 `JongGunelee/wyggkr03`(주간)의 회의록 존재 여부를 상태 XLSB에 반영한다.
- `RawData/월간 및 주간/tools/generate_meeting_bootstrap.mjs`: 상태·메모 XLSB를 직접 파일 실행용 읽기 전용 부트스트랩으로 생성한다.

## 2. HTML과의 의존 관계

`RawData/00 HTML 백업/042 월간 회의_(공란 양식).html`과 `043 주간 회의_(공란 양식).html`은 독립형 공란 템플릿이다. 두 파일은 이 폴더, `wyggkr04` XLSB, `MeetingDataStore`, `MeetingGithubCredential`을 참조하지 않는다.

통합 화면 `월간 및 주간 회의.html`은 `wyggkr04`의 다음 산출물을 사용한다.

- `RawData/월간 및 주간/회의_안건_현황.xlsb`
- `RawData/월간 및 주간/회의_요약_메모.xlsb`
- `RawData/월간 및 주간/runtime/meeting-data-bootstrap.js`

따라서 `.github`를 삭제해도 정적 HTML이 즉시 사라지지는 않지만, 위 데이터의 자동 대조·부트스트랩 갱신·무결성 차단이 중단된다.

## 3. 무결성 규칙

### 사전 검사

워크플로는 어떤 파일도 쓰기 전에 다음을 확인한다.

1. 두 XLSB가 존재하고 파싱 가능하다.
2. 필수 시트와 필수 열이 존재한다.
3. 상태 XLSB의 `안건현황` 데이터 행이 0이 아니다.
4. 직전 커밋 대비 데이터 행 또는 변경이력이 25%보다 많이 감소하지 않는다.
5. 검사 실패 시 reconcile, bootstrap 생성, commit, push를 수행하지 않는다.

### 사후 검사

대조와 부트스트랩 생성 뒤 다음을 다시 확인한다.

- 부트스트랩의 각 파일 SHA-256·바이트 수가 현재 XLSB와 일치한다.
- 부트스트랩의 rows/history 개수가 현재 XLSB와 일치한다.
- 스키마 버전이 지원 범위(현재 1)이다.

검증 실패는 성공으로 간주하지 않는다. GitHub Actions의 녹색 실행보다 검사 JSON과 실제 데이터 행 수를 우선한다.

## 4. 자동 실행과 재귀 방지

관련 경로가 push되면 자동 실행한다.

- `.github/workflows/**`
- `.github/scripts/**`
- `RawData/월간 및 주간/**`
- 통합 회의 HTML 및 041 백업본

워크플로가 생성한 `github-actions[bot]` 커밋은 다시 자기 자신을 호출하지 않는다. 시간 예약과 `workflow_dispatch`는 계속 사용할 수 있다.

## 5. 현재 확인된 사고 상태

2026-09-02 기준 최신 커밋 `ac21ba2`에서 다음 파일이 직전 커밋보다 비정상적으로 축소되었다.

- `회의_안건_현황.xlsb`: 52,231바이트·364행 → 12,361바이트·데이터 행 0
- `회의_요약_메모.xlsb`: 18,091바이트 → 12,001바이트·데이터 행 0
- XLSB 파서에서 `#REF!` 범위 경고 발생
- 읽기 전용 대조 결과: 월간 43개·주간 149개 파일 기준 342개 변경 필요

이 상태는 자동으로 “빈 파일을 정상 데이터로 인정”하지 않도록 차단해야 한다. 직전 정상 커밋 또는 별도 검증된 백업에서 두 XLSB의 데이터와 이력을 복구한 뒤, 새 커밋에서 사전 검사와 사후 검사를 통과시킨다. 자동 대조는 유실된 변경이력을 재구성할 수 없으므로 복구 수단으로 사용하지 않는다.

## 6. 삭제·변경 금지 원칙

다음은 명시적인 검토·대체 계획 없이 삭제하거나 우회하지 않는다.

- `.github/workflows/reconcile-meeting-status.yml`
- `.github/scripts/validate-meeting-integrity.mjs`
- 상태·메모 XLSB와 생성 부트스트랩
- 필수 시트, 이력, SHA-256 검증 단계

삭제가 허용되는 경우는 동일 기능의 대체 워크플로와 검증기를 먼저 추가하고, 수동 실행·실패 시나리오·재귀 실행·복구 절차를 테스트한 뒤 리뷰된 커밋으로 교체할 때뿐이다. 단순히 Actions가 실패한다는 이유로 `.github`를 지우거나 보호 단계를 비활성화하지 않는다.

## 7. 운영 체크리스트

1. 변경 전 현재 커밋과 XLSB 행 수·이력 수를 기록한다.
2. `node .github/scripts/validate-meeting-integrity.mjs`를 실행한다.
3. 자동 대조는 `--write`를 포함한 워크플로에서만 수행한다.
4. 생성 후 `node .github/scripts/validate-meeting-integrity.mjs --post`를 실행한다.
5. 실패하면 커밋·push하지 않고 원인과 SHA를 보존한다.
6. 복구가 필요하면 직전 정상 커밋과 별도 백업을 비교하고, 데이터 소유자의 확인 후 복구 커밋을 만든다.

이 문서는 `.github`가 왜 존재하는지와 어떤 상황에서 작업을 중단해야 하는지를 기록한다. 문서 자체를 삭제하면 운영자가 보호 규칙을 확인할 수 없으므로, 대체 운영 문서가 먼저 준비되지 않는 한 삭제하지 않는다.
