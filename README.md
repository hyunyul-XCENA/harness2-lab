# 터미널 에이전트 실행기

Codex App Server에 연결해 **한 대화를 계속 이어가는 로컬 터미널 앱**이다. 현재 A0/A1 실행 버전은 Codex 대화·재개·중단·추가 지시·승인·질문 응답과 설정/기록 저장을 지원한다. Claude adapter, 전체 화면 TUI, 개선 실험은 다음 단계다.

## 실행

Node.js **24.x**와 로그인된 **Codex CLI 0.163.0**이 필요하다. 프로토콜이 바뀐 버전은 연결 전에 거절한다. `codex --version`으로 확인할 수 있다. Codex의 기존 인증을 사용하며 앱 설정에 API key를 복사하지 않는다.

```powershell
cd C:\Users\hyunyul\orca\projects\research\terminal-runner
npm ci --ignore-scripts
npm run build
npm start -- --project "C:\작업\내프로젝트"
```

`--project`를 생략하면 현재 디렉터리에서 작업한다. Codex가 PATH에 없다면 `--codex-path "C:\...\codex.exe"`를 지정한다. 처음 실행하면 공통 지침 `~/.terminal-runner/harnesses/coding-v1/`과 프로젝트의 `.terminal-runner/`를 만든다.

일반 문장을 입력하면 새 turn이 시작된다. 응답이 끝나도 Codex 프로세스와 thread는 유지된다. 실행 중 입력은 하나까지 대기하며, 현재 turn이 끝나면 보낸다.

| 명령 | 동작 |
|---|---|
| `/interrupt` 또는 Ctrl+C | 현재 turn 중단. 대기 중인 메시지는 다음 turn으로 실행 |
| `/steer 추가 지시` | 현재 turn에 지시 추가 |
| `/allow 요청ID`, `/deny 요청ID` | 화면에 표시된 작업을 한 번 허용하거나 거절 |
| `/answer 요청ID {"질문ID":"답변"}` | 질문에 답변. 선택지가 있으면 표시된 값을 사용 |
| `/history` | 입력별 queued/sent/accepted/completed/unknown/rejected 상태 |
| `/ack-unknown` | 불확실한 이전 전달을 확인했음을 표시. 입력을 재전송하지 않음 |
| `/quit` | 앱 프로세스 종료, 대화 이력 보존 |

승인·질문은 기본 3분 뒤 만료한다. 승인은 응답이 없으면 거절한다. 비밀값 질문은 해당 요청만 거절하고 연결을 유지한다. 파일 수정 승인에는 전달받은 파일 목록과 diff를 표시한다. 현재 commandExecution/fileChange 승인만 지원하며, 별도의 `item/permissions/requestApproval`(추가 네트워크·경로 권한), MCP elicitation, dynamic tool call 등은 거절한다.

```powershell
npm start -- --project "C:\작업\내프로젝트" --sessions
npm start -- --project "C:\작업\내프로젝트" --resume "화면에 표시된-session-id"
```

재개는 저장된 모델과 지침 스냅샷을 사용한다. 새 설정은 새 세션에 적용된다. 연결이 끊기면 자동으로 다시 보내지 않는다. `unknown` 입력은 native turn ID로 완료를 확인할 수 있을 때만 복구한다. 원래 turn이 여전히 실행 중이면 재접속을 거절하므로 종료 후 다시 시도한다. 재개할 때 전송 전 대기 입력은 취소하며 `/history`로 확인할 수 있다.

완료를 확인할 수 없는 입력의 `/ack-unknown` 확인은 재접속할 때마다 다시 요구한다. Ctrl+C는 연결 실패 상태에서는 앱을 종료한다. 강제 종료·전원 중단 때 자식 프로세스 종료는 보장하지 않으며, `/quit`으로 닫을 때는 소유한 프로세스의 종료를 확인한다.

## 설정과 저장

기본값 → 사용자 공통 `~/.terminal-runner/defaults.json` → 프로젝트 `.terminal-runner/runner.config.json` → 실행 옵션 순서로 합친다. 객체는 합치고 배열은 교체한다. 공통 설정에서 프로젝트 경로를 지정할 수 없다.

공통 기본값 예:

```json
{
  "runtime": {
    "engine": "codex",
    "model": null,
    "harness": "global:coding-v1"
  }
}
```

`model: null`은 설치된 Codex의 기본 모델을 뜻한다. 실제 선택된 모델은 체크포인트에 저장한다. 프로젝트에는 바꿀 값만 적으면 된다. 예를 들어 `.terminal-runner/runner.config.json`에 `{"runtime":{"harness":"project:cpp-v1"}}`을 저장하면 공통 설정을 상속하면서 그 프로젝트의 지침을 사용한다.

- 공통 지침: `~/.terminal-runner/harnesses/<id>/manifest.json` 및 지침 파일
- 프로젝트 지침: `<프로젝트>/.terminal-runner/harnesses/<id>/...`
- 지침 예제: [manifest.json](examples/harnesses/coding-v1/manifest.json), [instructions.md](examples/harnesses/coding-v1/instructions.md)
- 선택 범위: `global:<id>` 또는 `project:<id>`. 이름이 같아도 범위를 명시한다.
- `--home <디렉터리>`로 공통 설정·지침 경로를 바꿀 수 있다.

지침은 세션 시작 시 developer instructions에 추가한다. 기존 AGENTS.md/CLAUDE.md를 수정하지 않는다. 현재 compiler는 `instructions`만 활성화한다. `skills`/`scripts` 및 `improvement.enabled=true`는 아직 거절한다.

프로젝트 `.terminal-runner/`에는 `sessions/<id>/events.jsonl`, `state.sqlite`, `lease.sqlite`, `materialized/<digest>/bundle.json`이 생긴다. JSONL을 먼저 fsync하고 SQLite 검색 인덱스를 갱신한다. 중간에 끊긴 마지막 JSONL 줄은 별도 `.partial-*`로 보존하고 복구한다. SQLite OS lock으로 프로젝트당 실행기 하나만 허용한다. 프로젝트의 `.gitignore`에 `.terminal-runner/`를 추가하는 것을 권장한다.

완전한 JSONL 줄이 손상됐으면 파일·줄 번호를 알리고 프로젝트의 실행을 중단한다. 원본 상태 디렉터리를 보존하고 백업으로 복구해야 한다. 현재는 출력 조각마다 동기 저장하므로 매우 긴 응답에서 표시가 늦어질 수 있다. 출력 묶음 저장과 전체 화면 UI는 A3에서 다룬다.

입력과 답변은 로컬 기록에 남는다. 알려진 환경변수 비밀값과 일부 credential 필드는 가리지만, 모든 비밀을 탐지하는 기능은 아니다. Codex 자체의 native 기록은 Codex가 관리한다. 지침 digest는 추가 지침과 프로젝트 루트의 대표 지침 파일을 추적하며, 사용자/상위 디렉터리/managed 설정 전체를 고정하지 않는다.

## 검증

```powershell
npm test
npm run check:design
npm run smoke:codex
```

`npm test`는 모델 호출 없이 프로토콜 fixture로 검사한다. 마지막 명령은 설치된 Codex 인증으로 실제 turn 4개를 시작한다. 앞의 세 turn으로 문맥 유지·재접속을 검사하고 마지막 turn은 바로 중단한다. 읽기 전용 sandbox와 별도 `.test-artifacts/` 프로젝트를 사용하며 결과를 그 아래에 남긴다. Node 24의 SQLite 실험 기능 경고가 표시될 수 있다.

현재 Windows/Node 24.3.0에서 검증했다. Linux 프로세스 종료 분기는 아직 실제 검증하지 않았다. 자동 실험의 container 격리와 강제 비용 제한은 제공하지 않는다. interactive 작업 권한은 Codex의 `on-request`/`workspace-write` 정책을 따른다.

## 설계

- [설계와 다음 구현 단계](docs/design.md)
- [공통 adapter 계약](contracts/agent.ts), [설정 스키마](contracts/runner-config.schema.json)
- [Harness² 구조](../.archify/architecture-harness2-terminal-20261023-151658/harness2/harness2.html)
- [지속 세션 구조](../.archify/architecture-harness2-terminal-20261023-151658/terminal-runtime/terminal-runtime.html)
- [개선 실험 구조](../.archify/architecture-harness2-terminal-20261023-151658/improvement-loop/improvement-loop.html)
