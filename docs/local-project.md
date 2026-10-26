# 실제 프로젝트에서 원본 PPC 실행

`project` 명령은 고정된 Harness² 코어에 로컬 프로젝트 `BenchmarkAdapter`와 native Codex 전송 경로를 추가한다. 원본 `run_sweep`, recursion, selection, reflection, library 코드는 수정하지 않는다. 기존 공개 benchmark의 실행 환경을 재현하는 명령은 아니다.

## terminal-runner 예제

현재 지원하는 로컬 조합은 Python 3.12/3.13, Node 24, **native Codex CLI 0.164.0**이다. 기존 Codex 로그인을 사용한다. 모델은 계정에서 사용할 수 있는 ID를 직접 지정한다. 공개 benchmark의 Codex pin 0.144.6과 기존 chat adapter의 pin 0.163.0은 별도다.

PowerShell에서 준비한다. 첫 명령은 모델을 호출하지 않는다. `node_modules`와 원본 엔진은 작업 소스와 분리해 의존성 사본으로 보관한다.

```powershell
cd C:\Users\hyunyul\orca\projects\research\terminal-runner
npm ci --ignore-scripts
npm run harness2 -- project init --project . --tasks examples/harness2/terminal-runner.tasks.json --model gpt-6.1-sol --deps node_modules --deps vendor/harness2 --output .terminal-runner/harness2/approval-timeout
npm run harness2 -- project check --output .terminal-runner/harness2/approval-timeout
```

예제는 `runtime.approvalTimeoutMs` 설정을 추가하는 실제 개발 요청이다. 아직 이 기능을 구현한 상태가 아니라, 각 solver가 작업할 요청을 준비한 것이다. `/status` 같은 native CLI 기능은 예제에서 복제하지 않는다.

다음 명령부터 **실제 모델 사용량이 발생**한다. 기본값은 `k=1`, parallel이며 과제 하나당 solver 실행 4회와 편집·Reflection 4회, 총 8개 모델 세션이 필요하다. 실패 재시도는 이보다 늘어날 수 있다. timeout은 각 세션 한도이며 총비용 제한은 아니다. USD 금액을 native CLI가 제공하지 않아 원본 ledger의 0을 무료 실행으로 해석하면 안 된다.

```powershell
npm run harness2 -- project run --output .terminal-runner/harness2/approval-timeout
# 같은 output과 설정을 사용하면 완료된 결과를 재개한다.
npm run harness2 -- project run --output .terminal-runner/harness2/approval-timeout
```

선택된 코드 변경은 화면에 표시된 `changes.patch`, 전체 변경 파일은 해당 실행의 `artifact/files/`, 삭제 목록은 `artifact/changes.json`에 남는다. `source/`는 준비 시점의 스냅샷이다. 실험 실행은 사용자 작업 폴더에 패치를 적용하지 않는다. 텍스트 diff와 바이너리 파일을 함께 보존하지만 패치 자동 적용 명령은 아직 제공하지 않는다.

## 선택 후 외부 검사

`project judge`는 선택과 Reflection이 끝난 뒤, 같은 검사 명령을 reference와 선택된 산출물에 실행한다. 각 산출물은 새 임시 폴더에 복원한다. 명령은 shell 문자열이 아닌 JSON argv로 받는다. PowerShell의 `npm.cmd` 대신 native `node`를 직접 사용한다.

```powershell
npm run harness2 -- project judge --output .terminal-runner/harness2/approval-timeout --command-json '["node","node_modules/typescript/bin/tsc","-p","tsconfig.json"]' --command-json '["node","--test","dist/test/*.test.js"]'
npm run harness2 -- project report --output .terminal-runner/harness2/approval-timeout
```

`project-grades.json`은 reference와 선택된 결과의 명령 통과 수, 종료 코드, 실행 시간과 로그 경로를 보관한다. 검사 실패는 실패로 기록하며, 검사 자체를 실행할 수 없으면 미측정으로 남긴다. 이 파일과 `grades/`는 모델 컨텍스트에 넣지 않는다. 같은 output의 run과 judge는 lock을 공유해 동시에 쓰지 않는다.

이 비교는 지정한 검사를 통과했는지 측정한다. 원래 검사들이 새 기능을 확인하지 않는다면 통과만으로 기능 완성을 증명할 수 없다. 후보가 작성한 테스트와 설정도 산출물에 포함되므로, 신뢰할 수 있는 별도 acceptance 검사는 사용자가 외부 명령으로 제공해야 한다. 외부 검사 결과로 원본의 최종 선택을 바꾸거나 경험 라이브러리를 수정하지 않는다.

## 저장·재개·편집 범위

- `project.json`과 소유권 marker는 과제 순서·domain·모델·effort·timeout·k·mode 및 소스·의존성 hash를 고정한다. 바꾸려면 새 output을 만든다. 같은 이름의 output을 새 프로젝트로 덮어쓰지 않는다.
- Git에 추적된 현재 파일 내용을 복사한다. 추적된 미커밋 변경도 포함하고, untracked 파일은 포함하지 않는다. 새 파일을 시험하려면 먼저 Git index에 추가한다. credential로 보이는 추적 파일은 준비 단계에서 거절한다.
- `.git`, `.codex`, `.claude`, 생성물과 앱 상태는 소스에서 제외한다. `--deps` 디렉터리도 모델에 전달하는 task source와 코드 패치에서 제외한다. 필요할 때 각 solver/검사 폴더에 독립 사본으로 복사하며, solver가 의존성을 수정하면 실패한다. 의존성 복사는 디스크 공간을 사용한다.
- symlink/junction이 있는 소스·의존성·출력은 거절한다. npm이 symlink를 만드는 플랫폼에서는 직접 파일 사본으로 준비해야 한다. `--deps`는 package manager 설치나 컨테이너 격리를 대신하지 않는다.
- 원본 Codex surface의 AGENTS.md, skills, helpers와 검증을 재사용한다. source의 AGENTS.md와 유효한 `.agents/skills/`를 base에 반영한다. helper가 기존 프로젝트 소스를 덮어쓰면 거절한다. 로컬 adapter는 host에서 실행되는 lifecycle hooks와 subagents를 지원하지 않으며 후보에 포함되면 명시적으로 거절한다. 전체 surface 실험에는 원본의 격리된 benchmark launcher를 사용한다.
- native `workspace-write`와 승인 `never`로 자동 세션을 실행한다. sandbox가 거절하면 실패 기록을 남기며 더 넓은 권한으로 재시도하지 않는다. 임시 사본은 컨테이너가 아니고 native sandbox의 읽기·네트워크 경계를 강화하지 않는다.
- Codex의 인증은 기존 환경에서 사용한다. 사용자 config/rules는 실험에 합치지 않는다. 전역 skills나 관리자가 강제한 정책까지 완전히 고정하는 환경은 아니므로 공개 benchmark와 같은 조건의 결과로 취급하지 않는다.
- `k=1`의 최종 선택은 원본처럼 단일 결과 전달이다. `k>=2`에서는 합성된 최종 결과들만 selector에 제공한다. 다음 과제에는 같은 domain의 앞선 과제 경험만 전달한다.
- 완료 marker와 산출물·trajectory hash를 확인한다. 실패/미완료 시도는 남기고 다음 시도는 새 폴더에서 실행한다. 운영체제 사이에 output을 옮기는 resume는 보장하지 않는다.

Codex 자동화 옵션 참고: [공식 non-interactive 안내](https://learn.chatgpt.com/docs/non-interactive-mode), [CLI 명령](https://learn.chatgpt.com/docs/developer-commands?surface=cli). 실제 지원 여부는 고정한 로컬 CLI의 `--help`와 함께 확인한다.
