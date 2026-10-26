# Harness² 실행 호스트와 대화 프로토타입

**원본 Harness²의 Python 코어를 고정 버전으로 직접 실행**한다. 과제별 Propose–Probe–Compose, 최종 결과 선택, Reflection과 domain 경험 저장을 원본 코드에 맡긴다. 별도로 기존 Codex/Claude 대화 TUI 프로토타입도 남아 있다. 두 실행 경로는 설정·세션·harness 형식이 다르다.

## 원본 Harness² 실행

Node.js 24.x와 Python **3.12 또는 3.13**이 필요하다. 모델 없는 데모는 Windows에서도 실행할 수 있다.

```powershell
cd C:\Users\hyunyul\orca\projects\research\terminal-runner
npm ci --ignore-scripts
npm run harness2 -- demo --k 1 --mode both
```

원본 deterministic demo가 두 과제에서 기준 실행 → 후보 제안·실행 → Compose → 최종 실행·선택 → Reflection을 수행한다. 두 번째 과제는 첫 과제의 경험을 참고한다. 편집은 미리 정해진 fixture이며 **LLM 호출이나 실제 프로젝트의 성능 향상 검증은 아니다**. 기본 출력은 `.terminal-runner/harness2/demo-<id>/`다. 상대 `--output` 경로는 `terminal-runner` 패키지 폴더 기준이다.

```powershell
# k=2: parallel / sequential의 원본 예산·경험 전달 확인
npm run harness2 -- demo --k 2 --mode both --output .test-artifacts/harness2-k2
# 같은 출력·같은 설정으로 실행하면 원본의 완료 결과를 재사용
npm run harness2 -- demo --k 2 --mode both --output .test-artifacts/harness2-k2
npm run harness2 -- verify
npm run test:harness2
```

`npm start -- --harness2 demo --k 1`도 같은 원본 호스트를 연다. Python 경로가 다르면 PowerShell에서 `$env:HARNESS2_PYTHON = 'C:\Python313\python.exe'`처럼 지정한다. 기존 chat 전용 설정은 원본 실행에 적용하지 않는다.

실제 모델을 사용하는 JobBench/LAB/WorkBuddy 실행은 **Linux/WSL에서 원본 의존성·모델·인증을 준비**해야 한다. `run`, `judge`, `report`, `setup`, `check`는 원본 CLI에 인자를 그대로 전달한다. 각 명령의 `--help`는 Windows에서도 볼 수 있다. 실행·채점·보고에 같은 benchmark/executor/mode/k/seed를 사용한다. 모델과 데이터 준비는 [원본 setup](vendor/harness2/docs/SETUP.md), [benchmark 설명](vendor/harness2/docs/BENCHMARKS.md)을 따른다. 고정한 원본 커밋에는 README가 언급하는 `.env.example`이 없으므로 문서의 모델 환경변수를 직접 설정한다.

```bash
# Linux/WSL에서 원본 setup과 check를 마친 뒤 실행하는 예
npm run harness2 -- run --bench lab --substrate oc --k 1 --mode parallel --only-domains antitrust-competition --max-tasks 1
npm run harness2 -- judge --bench lab --substrate oc --k 1 --mode parallel
npm run harness2 -- report --bench lab --substrate oc --k 1 --mode parallel
```

원본 커밋은 `1cfe254e8d25b15f37048c3730134686abe60335`다. 출처·파일 hash는 [PROVENANCE.json](vendor/harness2/PROVENANCE.json), 로컬 Windows 잠금/경로 호환 수정은 [재생성 스크립트](scripts/vendor-harness2.py)에 기록한다. core 알고리즘을 수동 A/B·사용자 채택 흐름으로 바꾸지 않는다. [현재 설계](docs/design.md)에 원본과 같은 점·호환 패치·아직 연결하지 않은 부분을 구분했다.

## 실제 프로젝트에서 실행

`project init/run/judge/report`로 Git 소스 스냅샷에 원본 PPC를 적용할 수 있다. 로컬 adapter는 native **Codex CLI 0.164.0**과 기존 로그인을 사용한다. 기본 `k=1`, parallel은 과제당 solver 4회·편집/Reflection 4회의 실제 모델 세션을 사용한다. 결과는 패치와 변경 파일로 보관한다.

[실행 방법과 terminal-runner 승인 대기시간 예제](docs/local-project.md)에 준비·실행·외부 비교 명령을 정리했다. `init`과 `check`는 모델을 호출하지 않는다. 공개 benchmark용 환경·모델 pin과 별도인 로컬 확장이다.

## 기존 대화 TUI 실행 — 원본 PPC가 적용되지 않는 프로토타입

Node.js **24.x**와 사용할 실행기의 로그인이 필요하다. 지원 조합은 **Codex CLI 0.163.0**, 또는 **Claude Code 2.1.309 + Agent SDK 0.3.309**다. SDK는 `npm ci`로 설치한다. 다른 CLI 버전은 연결 전에 거절한다. `codex --version`, `claude --version`으로 확인할 수 있다. 로컬 실행기의 기존 인증을 사용하며 앱 설정에 API key를 복사하지 않는다.

```powershell
cd C:\Users\hyunyul\orca\projects\research\terminal-runner
npm ci --ignore-scripts
npm run build
npm start -- --project "C:\작업\내프로젝트"
# 선택 화면 없이 실행기를 바로 열기
npm start -- --project "C:\작업\내프로젝트" --engine codex
npm start -- --project "C:\작업\내프로젝트" --engine claude
# 기존 줄 입력 화면
npm start -- --project "C:\작업\내프로젝트" --engine codex --plain
```

`--project`를 생략하면 현재 디렉터리에서 작업한다. 실행기가 PATH에 없다면 `--codex-path "C:\...\codex.exe"` 또는 `--claude-path "C:\...\claude.exe"`를 지정한다. 처음 실행하면 공통 지침 `~/.terminal-runner/harnesses/coding-v1/`과 프로젝트의 `.terminal-runner/`를 만든다.

터미널에서는 전체 화면 TUI를 자동으로 연다. 실행기·모델·재개 ID를 생략하면 새 Codex/Claude 대화와 저장된 대화를 고르는 화면이 나온다. 공통/프로젝트 설정의 기본 실행기가 처음 선택된다. ↑/↓로 고르고 Enter로 연다. `--select`로 선택 화면을 명시할 수도 있다. `--plain`은 기존 줄 입력 화면이며 pipe 입력은 자동으로 이 방식을 쓴다. `--tui`와 `--select`는 대화형 터미널이 필요하다.

대화 화면 위에는 실행기·모델·상태·세션 ID·harness 버전을 표시한다. PgUp/PgDn으로 대화를 스크롤하고 Esc로 최신 위치로 돌아온다. ↑/↓는 입력 기록, ←/→·Home/End·Backspace/Delete는 입력 편집이다. 한글·이모지는 글자 단위로 이동한다. 터미널이 bracketed paste를 지원하면 여러 줄 붙여넣기는 입력창에 모으며 Enter를 누를 때 보낸다. 화면은 최소 46열 × 12행이 필요하며, 더 작아지면 일반 입력과 승인 키를 멈춘다. Ctrl+C/Ctrl+D 종료·중단은 계속 쓸 수 있다.

승인이나 질문이 오면 **F2**로 검토 화면을 연다. 승인은 기본이 거절이며 방향키로 `Allow once`를 선택한 뒤 Enter를 눌러야 허용한다. PgUp/PgDn으로 제안한 입력과 diff를 읽을 수 있다. 질문은 ↑/↓와 Enter로 고르며, 자유 답변을 지원하면 `Type an answer…`를 골라 입력한다. Esc/F2로 검토를 닫아도 원래 입력하던 초안은 남는다. 만료됐거나 이전 연결의 요청은 답하지 않는다. 아래의 `::` 실행기 명령도 두 화면에서 같은 방식으로 동작한다.

일반 문장을 입력하면 새 turn이 시작된다. 응답이 끝나도 실행기 프로세스와 native 대화는 유지된다. Claude는 열린 async 입력 스트림을 사용하는 하나의 `query()`를 유지한다. 실행 중 입력은 하나까지 대기하며, 현재 turn이 끝나면 보낸다.

| 명령 | 동작 |
|---|---|
| `::interrupt` 또는 Ctrl+C | 현재 turn 중단. 대기 중인 메시지는 다음 turn으로 실행 |
| `::steer 추가 지시` | Codex의 현재 turn에 지시 추가. Claude는 일반 입력으로 다음 turn에 대기 |
| `::allow 요청ID`, `::deny 요청ID` | 화면에 표시된 작업을 한 번 허용하거나 거절 |
| `::answer 요청ID {"질문ID":"답변"}` | 질문에 답변. 선택지가 있으면 표시된 값을 사용 |
| `::history` | 입력별 queued/sent/accepted/completed/unknown/rejected 상태 |
| `::sessions` | 현재 연결을 닫고 대화 선택 화면으로 이동. 줄 입력 화면에서는 목록과 재개 방법 표시 |
| `::ack-unknown` | 불확실한 이전 전달을 확인했음을 표시. 입력을 재전송하지 않음 |
| `::quit` | 앱 프로세스 종료, 대화 이력 보존 |

버전 0.5부터 실행기 명령은 `::`를 사용한다. `/model`, `/permissions`, `/status`는 native CLI용으로 구분한다. 현재 SDK/App Server 대화 화면은 native slash 명령을 실행하지 못하므로 설명을 표시하고, 모델에게 일반 문장으로 보내지 않는다. 원래 CLI 화면을 내장하는 작업은 별도다.

승인·질문은 기본 3분 뒤 만료한다. 승인은 응답이 없으면 거절한다. 승인에는 도구 이름과 제안한 입력을 표시하며, 허용은 한 번만 적용한다. 이미 실행기 설정에서 허용한 도구는 추가 승인 없이 실행될 수 있다.

- Codex: commandExecution/fileChange 승인을 지원하고 전달받은 파일 목록·diff를 표시한다. 별도의 `item/permissions/requestApproval`, MCP elicitation, dynamic tool call 등은 거절한다.
- Claude: `canUseTool`로 들어오는 도구 승인과 `AskUserQuestion`을 처리한다. 질문 화면의 `q1`, `q2`를 `::answer` JSON 키로 사용한다. 비밀값·복수 선택 질문은 해당 요청만 거절한다. `permissionMode: default`를 사용하고 영구 허용 규칙을 추가하지 않는다.

```powershell
npm start -- --project "C:\작업\내프로젝트" --sessions
npm start -- --project "C:\작업\내프로젝트" --resume "화면에 표시된-session-id"
```

재개는 저장된 실행기·모델·지침 스냅샷을 사용한다. `--engine` 없이도 저장된 실행기를 고르며, `--resume`과 다른 실행기/모델을 함께 지정하면 거절한다. 새 설정은 새 세션에 적용된다. 연결이 끊기면 자동으로 다시 보내지 않는다. Codex는 native turn ID로 완료를 확인한다. Claude는 native user UUID로 입력 기록을 확인하지만, SDK 기록 조회가 바깥 turn의 result를 제공하지 않으므로 로컬 완료 증거를 잃은 입력은 `unknown`을 유지한다. 모델의 `end_turn` 뒤에도 [Stop hook이 작업을 이어갈 수 있다](https://code.claude.com/docs/en/hooks#stop). Codex의 원래 turn이 실행 중이면 재접속을 거절한다. 재개할 때 전송 전 대기 입력은 취소하며 `::history`로 확인할 수 있다.

완료를 확인할 수 없는 입력의 `::ack-unknown` 확인은 재접속할 때마다 다시 요구한다. Ctrl+C는 연결 실패 상태에서는 앱을 종료한다. 강제 종료·전원 중단 때 자식 프로세스 종료는 보장하지 않으며, `::quit`으로 닫을 때는 소유한 프로세스의 종료를 확인한다.

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

`model: null`은 선택한 실행기의 기본 모델을 뜻한다. 실행기가 보고한 모델은 체크포인트에 저장한다. Claude는 첫 turn의 init 메시지에서 모델을 확인하므로 첫 실행 화면에는 기본 모델로 표시될 수 있다. 프로젝트에는 바꿀 값만 적으면 된다. 예를 들어 `.terminal-runner/runner.config.json`에 `{"runtime":{"harness":"project:cpp-v1"}}`을 저장하면 공통 설정을 상속하면서 그 프로젝트의 지침을 사용한다.

Claude를 기본으로 쓰려면 공통 또는 프로젝트 설정에 `{"runtime":{"engine":"claude"}}`를 저장한다. `runtime.claude.settingsSources`를 생략하면 `["user","project","local"]`을 사용한다. `[]`로 지정하면 파일 설정을 제외하며, CLAUDE.md 로딩에는 `project`가 필요하다. 이 값은 SDK의 `settingSources`로 전달한다. 실행기를 바꾸면 이전 실행기의 모델·전용 옵션을 상속하지 않는다. [Claude 전체 설정 예제](examples/runner.claude.config.json)도 참고할 수 있다.

- 공통 지침: `~/.terminal-runner/harnesses/<id>/manifest.json` 및 지침 파일
- 프로젝트 지침: `<프로젝트>/.terminal-runner/harnesses/<id>/...`
- 지침 예제: [manifest.json](examples/harnesses/coding-v1/manifest.json), [instructions.md](examples/harnesses/coding-v1/instructions.md)
- 선택 범위: `global:<id>` 또는 `project:<id>`. 이름이 같아도 범위를 명시한다.
- `--home <디렉터리>`로 공통 설정·지침 경로를 바꿀 수 있다.

지침은 Codex의 developer instructions 또는 Claude 기본 system prompt의 append에 추가한다. 기존 AGENTS.md/CLAUDE.md를 수정하지 않는다. 현재 compiler는 `instructions`만 활성화한다. `skills`/`scripts` 및 `improvement.enabled=true`는 아직 거절한다. 실행기 자체가 기존 설정에서 로딩하는 스킬·도구와는 별개다.

프로젝트 `.terminal-runner/`에는 `sessions/<id>/events.jsonl`, `state.sqlite`, `lease.sqlite`, `materialized/<digest>/bundle.json`이 생긴다. JSONL을 먼저 fsync하고 SQLite 검색 인덱스를 갱신한다. 중간에 끊긴 마지막 JSONL 줄은 별도 `.partial-*`로 보존하고 복구한다. SQLite OS lock으로 프로젝트당 실행기 하나만 허용한다. 프로젝트의 `.gitignore`에 `.terminal-runner/`를 추가하는 것을 권장한다.

완전한 JSONL 줄이 손상됐으면 파일·줄 번호를 알리고 프로젝트의 실행을 중단한다. 원본 상태 디렉터리를 보존하고 백업으로 복구해야 한다. TUI는 앱의 JSONL에서 최근 대화를 복원하고, 옛 승인 요청은 복원하지 않는다. 실행기 원래 UI에서 따로 주고받은 대화는 가져오지 않는다. 화면 갱신은 최대 약 30회/초로 묶지만 JSONL은 출력 조각마다 동기 저장하므로 매우 긴 응답에서 표시가 늦어질 수 있다. 저장 묶음 처리는 이후에 다룬다.

입력과 답변은 로컬 기록에 남는다. 알려진 환경변수 비밀값과 일부 credential 필드는 가리지만, 모든 비밀을 탐지하는 기능은 아니다. 각 실행기의 native 기록은 해당 실행기가 관리한다. 지침 digest는 추가 지침과 프로젝트 루트의 대표 지침 파일을 추적하며, 사용자/상위 디렉터리/managed 설정 전체를 고정하지 않는다.

## 검증

```powershell
npm test
npm run check:design
npm run preview:tui
npm run smoke:codex
npm run smoke:claude
npm run smoke:claude-input
```

`preview:tui`는 별도 임시 프로젝트와 두 실행기의 fixture를 사용해 **모델 호출 없이** 화면을 연다. `remember token`, `recall`, `long`, `approval`, `question`으로 대화·중단·승인·질문을 시험할 수 있다. 종료하면 `.test-artifacts/tui-preview-*/result.json`에 상태를 남긴다. 실제 작업에는 `npm start`를 사용한다.

`npm test`는 모델 호출 없이 Codex protocol fixture와 Claude SDK fixture로 검사한다. `smoke:codex`와 `smoke:claude`는 각각 실제 turn 4개로 문맥 유지·재접속·중단을 검사한다. Codex는 읽기 전용 sandbox, Claude는 도구 없는 설정을 사용한다. `smoke:claude-input`은 별도 프로젝트에서 실제 질문 응답과 파일 한 개 쓰기의 1회 승인을 검사한다. 이 검사만 파일 설정을 제외하고 SDK ask 규칙을 명시한다. 결과는 `.test-artifacts/` 아래에 남긴다. Node 24의 SQLite 실험 기능 경고가 표시될 수 있다.

현재 Windows/Node 24.3.0에서 검증했다. Linux 프로세스 종료 분기는 아직 실제 검증하지 않았다. 자동 실험의 container 격리와 강제 비용 제한은 제공하지 않는다. interactive 작업 권한은 Codex의 `on-request`/`workspace-write`, Claude의 `default` 및 로딩한 설정을 따른다.

## 설계

- [설계와 다음 구현 단계](docs/design.md)
- [공통 adapter 계약](contracts/agent.ts), [설정 스키마](contracts/runner-config.schema.json)
- [Harness² 구조](../.archify/architecture-harness2-terminal-20261023-151658/harness2/harness2.html)
- [지속 세션 구조](../.archify/architecture-harness2-terminal-20261023-151658/terminal-runtime/terminal-runtime.html)
- [방향 전환 전의 수동 개선 실험 구상 — 현재 원본 알고리즘과 다름](../.archify/architecture-harness2-terminal-20261023-151658/improvement-loop/improvement-loop.html)
