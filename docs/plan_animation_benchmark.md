# Animation Benchmark 추가 계획

기존 throughput / frame 두 모드에 더해, 동일 커브(예: spiral)를 **매 프레임마다 transform을 바꿔 다시 처음부터 끝까지 그리는** animation 모드를 추가한다. 일정 시간 동안 반복하여 평균 FPS를 측정한다.

## 배경 / 목적

- 현재 `runner.ts`의 두 모드는 **한 번의 스트로크**만 측정한다.
  - `runThroughput`: 모든 점을 한 호출 안에 그리고 `gl.finish()`까지 한 번 (peak GPU+CPU)
  - `runFrame`: 4 points/frame으로 잘라서 rAF에 분산 (실사용 페이싱 시뮬레이션)
- 실제 사용 패턴 중 하나인 **"같은 그림이 화면 안에서 계속 변형되며 반복 렌더링"** (예: 애니메이션 시그니처, 모션 프리뷰, 라이브 스탬프)에 대한 비용은 측정하지 못한다.
- 이 모드를 통해 "한 프레임 안에 전체 스트로크 + 합성까지 끝내고, 그 다음 rAF에서 변형해서 다시 그릴 때 몇 FPS가 나오는가"를 본다.

## 사양

### Mode 추가

`Mode = 'throughput' | 'frame' | 'animate'`로 확장.

### 새 옵션

- **Animation Style**: `translate` | `scale` | `rotate`
  - 매 프레임 입력 점들에 적용할 변형
- **Duration**: `1s` | `3s` | `5s`
  - 측정 시간

이 두 옵션은 mode === 'animate'일 때만 활성화. 다른 모드에서는 disable.

### 한 프레임 동작

매 rAF마다:
1. `canvas.clear()`
2. 현재 경과 시간 `elapsed`로부터 phase `t = (elapsed % loopSec) / loopSec` 계산 (loopSec은 style별 고정, 예: 1.0s)
3. style별 transform을 입력 점 배열에 적용 → `transformedPoints`
4. `moveTo(transformedPoints[0]) → lineTo(...) → endLine(last)` 한 프레임 안에 전부 호출
5. `compositeToScreen(canvas, ctx)`
6. 프레임 시간 기록 후 `frames++`

`elapsed >= durationSec`이면 `gl.finish()` 후 종료 → 결과 산출.

### Transform 정의 (캔버스 중심 cx, cy 기준)

```
translate: (x, y) → (x + Ax * sin(2π t), y + Ay * sin(2π t * 0.7))
           Ax = canvasW * 0.10, Ay = canvasH * 0.10  (한 프레임에 여러 픽셀 이동)

scale:     s = 1.0 + 0.5 * sin(2π t)        // [0.5, 1.5]
           (x, y) → (cx + (x - cx) * s, cy + (y - cy) * s)

rotate:    θ = 2π t                          // 한 loop에 1회전
           (x, y) → (cx + dx*cos θ - dy*sin θ, cy + dx*sin θ + dy*cos θ)
                    (dx = x - cx, dy = y - cy)
```

cycle 수, 진폭 등 상수는 코드 상단에 묶어둬서 추후 튜닝 쉽게.

### 출력 결과

`RunResult`에 다음을 추가하거나, animation 전용 필드를 새로 둔다.

| 필드 | 의미 |
|---|---|
| `frames` | 총 그려진 프레임 수 |
| `durationMs` | 실제 측정된 경과 시간 (rAF 정렬 때문에 목표 duration과 약간 다를 수 있음) |
| `avgFps` | `frames / (durationMs / 1000)` |
| `frameMs.{p50,p95,p99,max}` | 프레임당 (CPU+합성) 시간 분포 (기존 frame 모드와 같은 형식 재사용) |
| `n` | 한 프레임당 입력 점 수 (커브와 spacing이 결정) |

UI 표에 새 컬럼 `fps`를 추가 (animate 행에서만 채움).

## 구현 변경 사항

### `src/UBrushCore/benchmark/runner.ts`

- `Mode` 타입 확장: `| 'animate'`
- `RunResult`에 선택적 필드 추가: `frames?`, `durationMs?`, `avgFps?`
- 새 타입: `export type AnimationStyle = 'translate' | 'scale' | 'rotate';`
- 새 함수:
  ```ts
  export function runAnimation(
      canvas: Canvas,
      ctx: UBrushContext,
      gl: WebGL2RenderingContext,
      points: Point[],
      style: AnimationStyle,
      durationSec: number,
  ): Promise<RunResult>
  ```
- 내부 헬퍼 `applyTransform(points: Point[], style: AnimationStyle, t: number, cx: number, cy: number, w: number, h: number, out: Point[]): void`
  - `out` 배열을 재사용해서 GC 압력 최소화 (벤치마크 자체가 GC를 유발하면 측정 의미가 깎임)
- `compositeToScreen`은 그대로 재사용

### `src/UBrushCore/benchmark/main.ts`

- 상수 추가:
  ```ts
  const ANIMATION_STYLES: AnimationStyle[] = ['translate', 'scale', 'rotate'];
  const DURATIONS: { label: string; sec: number }[] = [
      { label: '1s', sec: 1 },
      { label: '3s', sec: 3 },
      { label: '5s', sec: 5 },
  ];
  const MODES: Mode[] = ['throughput', 'frame', 'animate'];
  ```
- `BenchmarkApp`에 `animSel: HTMLSelectElement`, `durSel: HTMLSelectElement` 필드 추가
- `buildSidebar()`에서 두 select 추가하고, `modeSel.change`에서 mode가 'animate'일 때만 enable되게 토글
- `runScenario()` 분기에 animate 모드 추가:
  ```ts
  const result = mode === 'throughput' ? await runThroughput(...)
               : mode === 'frame'      ? await runFrame(...)
                                       : await runAnimation(canvas, ctx, gl, points, style, durSec);
  ```
- 시나리오 라벨에 style/duration 포함: `${curve} / ${spacingPx}px / animate-${style}-${durSec}s`
- `renderScenarioTable()`: `fps` 컬럼 추가 (`r.avgFps`가 있을 때만 값, 아니면 `—`)
- `runOne()`은 현재 select 값을 그대로 사용. `runAll()`은 기존 throughput/frame 행렬에서는 animate를 제외하고, 별도 버튼 또는 mode가 animate일 때 별도의 작은 행렬 (3 styles × 3 durations × 1 curve) 정도만 돈다 — **runAll 폭주 방지**.

### `src/UBrushCore/benchmark/index.html`

테이블 컬럼 변화는 `renderScenarioTable`에서 제어하므로 HTML 변경 불필요.

## 측정 정확도 관련 결정

- **Stylus 상태**: 매 프레임 새 그림이므로 매 프레임 새 `Stylus()`를 만든다. 같은 인스턴스를 재사용하면 점 간 거리/속도 계산에 이전 프레임의 잔상이 섞일 수 있음.
- **clear 비용 포함**: 프레임 시간에는 `clear → 스트로크 → composite`을 모두 포함시킨다 (사용자가 보는 "한 프레임"의 실제 비용).
- **첫 프레임 워밍업**: `runFrame`처럼 측정 시작 전에 `compositeToScreen + gl.finish()` 한 번 돌려 GL 상태 안정화.
- **rAF jitter**: duration은 wall-clock 기준이지 프레임 카운트 기준이 아니므로, 마지막 프레임이 duration을 약간 넘기는 건 자연스럽다. 보고할 때는 실제 `durationMs`로 나눈 FPS를 쓴다 (목표 duration이 아니라).
- **`gl.finish()`의 위치**: 종료 시 한 번만 호출. 매 프레임 호출하면 파이프라인 직렬화로 FPS가 비정상적으로 낮아짐 (실사용과 괴리).

## 작업 단계

1. `runner.ts`에 `AnimationStyle`, `runAnimation`, `RunResult` 확장 — 단독으로 빌드 통과시키기.
2. `main.ts`에 `MODES` 확장과 두 select 추가, mode 변경 시 enable/disable 토글.
3. `runScenario`에 animate 분기, 라벨 포맷, 결과 테이블 `fps` 컬럼 추가.
4. 수동 검증:
   - spiral / 2px / animate-rotate-3s 실행 → 3초 동안 회전하는 spiral이 보이고 FPS 출력
   - 같은 brush를 translate/scale/rotate 각각으로 비교, 시각적으로 의도한 변형이 맞는지 확인
   - 1s / 3s / 5s에서 FPS가 거의 일정한지 확인 (크게 다르면 워밍업 부족 또는 GC 의심)
5. (선택) `Run All`이 animate를 어떻게 처리할지 결정 — 기본은 제외, 별도 `Run Animations` 버튼을 둘지 결정.

## Favorites 평균 FPS 스코어링

기존 `Score Favorites` 버튼(throughput 합산)과 **별개로**, 즐겨찾기 brush들의 animation 평균 FPS를 한 번에 측정하는 기능을 추가한다.

### 사양

- 새 버튼: `Score Favorites (Animation, 3s)` — duration 3초 고정 (사용자 요청).
- 각 favorite brush마다 고정 행렬을 돈다:
  - **Curve**: `spiral` 1종 (가장 dense하고 변별력 좋음)
  - **Spacing**: `2px` 1종 (dense — peak 부하)
  - **Animation style**: `translate`, `scale`, `rotate` 3종
  - 즉 brush 1개당 3시나리오 × 3초 = **9초/brush**
- brush별 출력:
  - 각 style의 `fps`
  - `avgFps` = 3 style의 산술 평균
- 전체 출력 (favorites 합계 행):
  - `overallAvgFps` = 모든 brush의 `avgFps` 평균
  - 별도로 `worstFps` (가장 느린 brush + 그 style)도 같이 보여주면 회귀 잡기 좋음

### 새 타입 / 함수

`runner.ts`에는 추가 타입 불필요 (`runAnimation` 그대로 재사용).

`main.ts`에 추가:

```ts
interface FavoriteAnimScore {
    name: string;
    file: string;
    perStyleFps: { [k in AnimationStyle]?: number };
    avgFps: number;
    error?: string;
}
```

- 필드: `private favoriteAnimScores: FavoriteAnimScore[] = [];`
- 메서드: `private async runFavoritesAnimation(): Promise<void>`
  - 기존 `runFavorites()` 골격을 따라가되, 내부 행렬을 위 사양으로 교체
  - 각 brush 끝나면 `renderResultsTable()` 호출해서 진행 상황을 점진적으로 갱신 (기존과 동일 패턴)
- 메서드: `private async scoreFavoriteAnimation(fav, idx, total): Promise<FavoriteAnimScore>`
  - `loadBrushesForCategory` → brush 찾기 → `canvas.setBrush`
  - 3 styles 루프, 각각 `runAnimation(canvas, ctx, gl, points, style, 3)` 실행
  - 매 시나리오 사이 `canvas.clear() + gl.finish() + 한 번 rAF yield` (기존 `scoreFavorite` 패턴 동일)

### UI / 표시

- 사이드바에 새 버튼 `Score Favorites (Animation, 3s)` (secondary 스타일 아님 — primary)
- `renderResultsTable()`은 두 favorites 테이블(throughput / animation)을 모두 보여주도록 확장:
  - `renderFavoritesSummary()`는 throughput 전용으로 두고
  - `renderFavoritesAnimSummary()` 신설:
    - 헤더: `Favorites animation FPS — overall avg X.X (worst Y.Y on <brush>/<style>)`
    - 컬럼: `brush | file | translate fps | scale fps | rotate fps | avg fps`
    - 정렬: `avgFps` 오름차순 (느린 게 위로 — 회귀 가시성)
- `setBusy()`에 새 버튼도 포함, `copyResults()` payload에 `favoriteAnimScores`와 `favoritesAnimOverallFps` 추가

### 측정 정확도

- 각 brush의 첫 시나리오 첫 프레임은 워밍업 효과가 있어 평균을 끌어내릴 수 있음 → `runAnimation` 내부에서 첫 프레임은 `frameDurations`에는 기록하되 `frames` 카운트에는 포함시킨다 (단순화). 별도 워밍업 프레임을 두지는 않는다 — 1초 미만이면 영향이 크지만 3초면 1프레임 비중이 작다.
- brush 전환 직후 첫 시나리오에 셰이더 컴파일/JIT 비용이 섞일 수 있음 → 각 brush의 첫 style 실행 전에 `await new Promise(r => requestAnimationFrame(() => r()))` 한 번 더 yield (기존 `scoreFavorite`도 동일 패턴).

### 작업 단계 (기존 5단계 뒤에 추가)

6. `FavoriteAnimScore` 타입과 `favoriteAnimScores` 필드 추가, `runFavoritesAnimation` / `scoreFavoriteAnimation` 구현.
7. 새 버튼 추가, `setBusy`에 포함.
8. `renderFavoritesAnimSummary` 추가 및 `renderResultsTable` 통합.
9. `copyResults`에 새 필드 포함.
10. 수동 검증: 즐겨찾기 3~5개로 실행 → brush별 / 전체 평균 FPS가 합리적 범위, 무거운 brush가 표 상단에 노출되는지 확인.

## 비목표 (이번 변경에서 안 함)

- transform을 GPU composite 단계에서만 적용해서 "본래 그림은 한 번만 그리고 transform된 결과만 보여주기" — 이건 다른 측정이 됨. 사용자 요청은 "매 프레임마다 다시 그린다"이므로 여기서는 안 함.
- transform 자체의 시간 분해 측정 (transform CPU vs 스트로크 CPU vs composite). 필요하면 후속.
- duration / curve / spacing을 favorites animation에서 사용자 선택 가능하게 — 일단 고정 (회귀 비교 편의 우선). 필요해지면 옵션화.
