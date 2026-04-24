# DrawingEngine: Swift 동등성 리팩토링 계획

## 0. 목적 / Scope

Classic(1번, TypeScript)의 `DrawingEngine`에서 `DrawingMode`(`'basic' | 'smudging' | 'water'`) enum을 제거하고, Swift(2번) 레퍼런스와 동일하게 **`alphaSmudgingMode`와 `useSecondaryMask`를 독립된 두 boolean 속성**으로 분리한다. 두 플래그가 Swift 구현과 **의미적으로 완전히 동일하게** 동작하도록 모든 파생 경로를 재작성한다.

- **하지 않을 것 (Out of scope)**: 렌더 타깃 네이밍을 Swift의 Stable/Dynamic/Preview 구조로 갈아엎지 않는다. 속도가 검증된 classic의 렌더 타깃/프로그램 구조는 유지한다. (CLAUDE_MEMORY: 1번은 성능 기준이므로 아키텍처 보존.)
- **할 것**: 플래그 API, setter 의미, 분기 조건, 상태 초기화 타이밍을 Swift와 일치시킨다.

## 1. Swift 레퍼런스 동작 (정답)

Swift의 `DrawingEngine`에서 두 플래그는 다음 규칙으로 동작한다.

### 1.1 속성
- `alphaSmudgingMode: Bool` — DrawingEngine의 **상태(stored property)**. setter(`didSet`)에서 `updateAlphaSmugingMode()` 호출.
- `useSecondaryMask` — DrawingEngine에 **저장하지 않는다**. 매 호출마다 `brush?.useSecondaryMask ?? false`로 읽어온다. (브러시 교체 즉시 반영)

### 1.2 drawDots 분기 (Swift `_drawDots`)

| preview | alphaSmudgingMode | primary target       | secondary target                                |
|:-------:|:-----------------:|----------------------|-------------------------------------------------|
| true    | true              | `effectPreview`      | `effectPreview`                                 |
| true    | false             | `effectPreview`      | `useSecondaryMask ? maskPreview : effectPreview`|
| false   | true              | `plain`              | `plain`                                         |
| false   | false             | `effect`             | `useSecondaryMask ? mask : effect`              |

**핵심**: `alphaSmudgingMode = true` 이면 `useSecondaryMask`는 **무시**된다. `alphaSmudgingMode = false` 일 때만 `useSecondaryMask`가 secondary(=dual tip, classic의 `isMask`) 도트의 목적지를 가른다.

### 1.3 `updateAlphaSmugingMode` (alphaSmudgingMode setter의 부수 효과)

setter가 바뀔 때마다 실행되며, 핵심 로직:
1. 동적 버퍼 전체 클리어: `maskDynamic`, `effectDynamic`, `plainDynamicAlpha`, `plainDynamic`, `smudgingAlpha0/1Buffer`, `smudgingRGB0/1Buffer`.
2. **alphaSmudgingMode = true 일 때**: `plainStable` 텍스처를 `separateLayersProgram`으로 α/RGB 분리하여 `plainDynamicAlpha`/`plainDynamic`, `smudgingAlpha0/smudgingRGB0`, `smudgingAlpha1/smudgingRGB1` 에 각각 세팅.
3. **alphaSmudgingMode = false 일 때**: `effectStable` → `effectDynamic` 복사, 현재 화면을 `smudgingRGB0`/`smudgingRGB1` 로 print, `maskStable` → `maskDynamic` 복사.

### 1.4 updateSmudging (스머징 전진 이동, alphaSmudgingMode로 분기)

- **alphaSmudgingMode = true**: `alpha1 → alpha0`, `rgb1 → rgb0`, 그리고 `plainDynamicAlpha → alpha1`, `plainDynamic → rgb1` 로 shift.
- **alphaSmudgingMode = false**: `rgb1 → rgb0`, 그리고 최신 합성 결과(`effectDynamic`을 maskAndCut + postProcess한 결과)를 `rgb1`에 갱신.

### 1.5 useSecondaryMask 사용처

Swift에서 `useSecondaryMask`를 읽는 유일한 곳은 `_drawDots` 안의 분기 표(§1.2). 그 외에는 모두 `alphaSmudgingMode`로만 분기한다. 즉 `setup`, `release`, `cancel`, `dry`, `clear`, `updateSmudging`, `updateAlphaSmugingMode`, `printToRenderTarget` 같은 상태 전환 로직은 **전부 `alphaSmudgingMode` 기준**이다.

---

## 2. 현재 Classic 구현의 불일치점

Classic은 두 플래그를 단일 enum `DrawingMode`에 압축해두었다.

```ts
// Canvas.ts (현재)
const mode: DrawingMode = brush?.alphaSmudgingMode ? 'smudging'
    : brush?.useSecondaryMask ? 'water'
    : 'basic';
this.drawingEngine.mode = mode;
```

- `smudging` ≡ `alphaSmudgingMode=true` (useSecondaryMask 무시) → Swift와 의미 일치
- `water` ≡ `alphaSmudgingMode=false && useSecondaryMask=true` → Swift와 의미 일치
- `basic` ≡ 둘 다 false → Swift와 의미 일치

즉 **분기 결과만 보면 이미 Swift와 같다**. 그러나 다음 차이점이 존재한다.

### 2.1 구조적 차이
1. `DrawingMode` enum이 API 표면에 노출되어 있어 외부 호출자가 mode를 직접 생각해야 한다. Swift는 두 boolean만 노출.
2. `useSecondaryMask`가 DrawingEngine에 속성으로 존재하지 않는다. `Canvas.setBrush`에서만 계산되어 mode로 변환된다.
3. `alphaSmudgingMode`가 DrawingEngine에 속성으로 존재하지 않는다. 같은 이유.
4. mode setter(`_ensureSmudgingTargets`/`_ensureWaterTargets`)가 **lazy allocation만** 하고, Swift의 `updateAlphaSmugingMode`가 하는 **버퍼 클리어 + separate 재-셋업**을 하지 않는다. classic은 그 책임을 `setupWithRenderTarget`이 떠맡고 있어 **세팅 타이밍이 다르다**.
5. Swift에선 `useSecondaryMask`를 매번 `brush?.useSecondaryMask`로 읽어 **브러시 변경이 즉시 반영**. classic은 `setBrush` 호출 시에만 mode가 재계산된다. (이 차이는 현재 호출 패턴상 관찰 불가능할 수 있으나 의미는 다르다.)

### 2.2 결과적 차이
위 #4가 가장 실질적. Swift는 `alphaSmudgingMode = true` **전환 즉시** plain 계열 버퍼를 α/RGB로 분리한다. Classic은 이 분리가 **다음 `setupWithRenderTarget` 호출까지 미뤄진다**. 따라서 Swift 브러시를 classic에 이식했을 때 초기 스트로크가 비어있거나 화면 내용과 동기화되지 않는 증상이 생길 수 있다.

---

## 3. 리팩토링 설계

### 3.1 새 API (DrawingEngine 공개 표면)

```ts
// 제거
// export type DrawingMode = 'basic' | 'smudging' | 'water';
// public get mode(): DrawingMode; public set mode(value: DrawingMode);

// 추가
public set alphaSmudgingMode(value: boolean);  // setter에 Swift의 updateAlphaSmugingMode 대응 로직
public get alphaSmudgingMode(): boolean;

public set useSecondaryMask(value: boolean);   // 단순 저장
public get useSecondaryMask(): boolean;
```

내부 필드:
```ts
private _alphaSmudgingMode: boolean = false;
private _useSecondaryMask: boolean = false;
```

### 3.2 내부 분기의 의미적 치환 규칙

| 기존                                  | 신규                                                         |
|---------------------------------------|--------------------------------------------------------------|
| `this._mode === 'smudging'`           | `this._alphaSmudgingMode`                                    |
| `this._mode === 'water'`              | `!this._alphaSmudgingMode && this._useSecondaryMask`         |
| `this._mode === 'basic'` (else 분기)  | `!this._alphaSmudgingMode && !this._useSecondaryMask`        |

**주의 (alphaSmudgingMode 우선순위)**: 반드시 `alphaSmudgingMode`를 **먼저** 체크하고 그 다음 `useSecondaryMask`를 체크한다. Swift §1.2 표와 동일한 순서.

### 3.3 렌더 타깃 할당 정책

Swift는 모든 타깃을 생성자에서 eager 할당한다. classic은 smudging/water 타깃을 lazy. 성능상 lazy를 유지하되 **트리거 포인트를 setter로 이동**한다.

- `alphaSmudgingMode = true` 로 전환 → `_ensureSmudgingTargets()` 호출 후 **Swift의 `updateAlphaSmugingMode` true 경로** 실행 (clear + separate).
- `alphaSmudgingMode = false` 로 전환 → `_ensureSmudgingTargets()`은 불필요하지만, **Swift의 `updateAlphaSmugingMode` false 경로**에 대응되는 clear + 동적 버퍼 재초기화 실행.
- `useSecondaryMask = true` 로 전환 → `_ensureWaterTargets()` 호출. (Swift에선 이 시점에 별도 작업 없음. classic은 lazy라 할당만.)
- `useSecondaryMask = false` 로 전환 → no-op.

### 3.4 setter 동작 의사코드

```ts
public set alphaSmudgingMode(value: boolean) {
    if (this._alphaSmudgingMode === value) return; // idempotent guard
    this._alphaSmudgingMode = value;
    if (value) this._ensureSmudgingTargets();
    this._resyncDynamicBuffersForMode();  // Swift updateAlphaSmugingMode 대응
}

public set useSecondaryMask(value: boolean) {
    if (this._useSecondaryMask === value) return;
    this._useSecondaryMask = value;
    if (value) this._ensureWaterTargets();
    // Swift는 useSecondaryMask 변경 시 별도 부수효과 없음 (매 drawDots에서 읽음)
}
```

`_resyncDynamicBuffersForMode()`의 책임은 **Swift `updateAlphaSmugingMode`가 하는 일과 동일**하되, classic 렌더 타깃 이름으로 매핑 (아래 §3.5 참조).

### 3.5 Swift ↔ Classic 렌더 타깃 매핑 (고정)

| Swift                      | Classic                                   |
|----------------------------|-------------------------------------------|
| `plainStable`              | `liquidRenderTarget`                      |
| `plainDynamic`             | `drawingRenderTarget`                     |
| `plainDynamicAlpha`        | `drawingAlphaRenderTarget`                |
| `effectStable`             | (classic은 동일 기능을 dry/liquid가 담당; 매핑 N/A — §3.8 주의)  |
| `effectDynamic`            | `drawingRenderTarget` (non-smudging 경로) |
| `maskStable`               | `maskLiquidRenderTarget`                  |
| `maskDynamic`              | `maskDrawingRenderTarget`                 |
| `smudgingRGB0Buffer`       | smudging mode: `smudging0CopyColorRenderTarget` / non-smudging: `smudging0CopyRenderTarget` |
| `smudgingRGB1Buffer`       | smudging mode: `smudging1CopyColorRenderTarget` / non-smudging: `smudging1CopyRenderTarget` |
| `smudgingAlpha0Buffer`     | `smudging0CopyAlphaRenderTarget`          |
| `smudgingAlpha1Buffer`     | `smudging1CopyAlphaRenderTarget`          |

이 매핑을 섣불리 바꾸지 말 것. 이미 관련 프로그램(`SeparateLayersProgram`, `MergeLayersProgram`, `MaskAndCutProgram`, `HighLowCutProgram`, `SmudgingDrawDotProgram`, `DrawDotProgram`)이 이 타깃 쌍을 전제로 작성돼 있다.

### 3.6 `_resyncDynamicBuffersForMode` 세부

`alphaSmudgingMode = true` 경로 — 현재 `setupWithRenderTarget`의 smudging 분기와 **본질적으로 동일**. `liquidRenderTarget`의 내용을 원본으로 삼아 separate를 수행. 단, 여기서는 external texture가 아닌 **현재 `liquidRenderTarget` 자신**이 소스다.

```ts
// if value=true
const s = Common.stageRect();
ProgramManager.getInstance().separateLayersProgram.separate(
    this.drawingAlphaRenderTarget!, this.drawingRenderTarget,
    { targetRect: s, source: this.liquidRenderTarget.texture, sourceRect: s, canvasRect: s }
);
ProgramManager.getInstance().separateLayersProgram.separate(
    this.smudging1CopyAlphaRenderTarget!, this.smudging1CopyColorRenderTarget!,
    { targetRect: s, source: this.liquidRenderTarget.texture, sourceRect: s, canvasRect: s }
);
ProgramManager.getInstance().separateLayersProgram.separate(
    this.smudging0CopyAlphaRenderTarget!, this.smudging0CopyColorRenderTarget!,
    { targetRect: s, source: this.liquidRenderTarget.texture, sourceRect: s, canvasRect: s }
);
```

`alphaSmudgingMode = false` 경로 — Swift의 경우 effectDynamic을 effectStable로, smudgingRGB0/1을 "현재 화면" 으로 되돌린다. Classic 등가:

```ts
// if value=false — non-smudging 기대치로 동적 버퍼 복구
this.context.clearRenderTarget(this.drawingRenderTarget, Color.clear());
this._fill(this.smudging0CopyRenderTarget, this.dryRenderTarget.texture);
this._fill(this.smudging1CopyRenderTarget, this.dryRenderTarget.texture);
if (this._useSecondaryMask && this.maskDrawingRenderTarget) {
    this.context.clearRenderTarget(this.maskDrawingRenderTarget, Color.clear());
}
```

> ⚠️ 이 false-경로는 관측된 Swift 동작의 번역이므로, 회귀 테스트(§7)로 반드시 검증할 것. 특히 "alphaSmudging 브러시 → 일반 브러시" 전환 시 첫 스트로크 아티팩트 여부.

### 3.7 `setupWithRenderTarget` 재구성

현재 `setupWithRenderTarget`의 if/else는 mode로 분기한다. 다음으로 치환:

```ts
if (this._alphaSmudgingMode) {
    // 기존 smudging 분기 내용 그대로 (separate 3회)
} else {
    // 기존 else 분기 내용 그대로
    if (this._useSecondaryMask) {
        // 기존 water 추가 clear 2회 그대로
    }
}
```

즉 **세 분기를 두 단계로 중첩**. 의미는 동일.

### 3.8 `dry`, `clear`, `cancelDrawing`, `releaseDrawing`, `fixer`, `fix`, `printToRenderTarget`, `renderMultiDots*`, `executeDotProgram`

모두 §3.2 치환 규칙을 기계적으로 적용. 분기 구조는 다음 형태로 통일:

```ts
if (this._alphaSmudgingMode) {
    // 기존 'smudging' 분기
} else if (this._useSecondaryMask) {
    // 기존 'water' 분기
} else {
    // 기존 'basic' 분기
}
```

**특히 주의할 지점**:
- `renderMultiDots()` 디스패치 라우터: `water` → smudging 순서가 아니라 Swift 표대로 **alphaSmudging 우선** 분기로 고정.
- `executeDotProgram()`의 `smudging0Texture` 선택: `_mode === 'water' ? smudging1Copy : smudging0Copy` → `!alphaSmudgingMode && useSecondaryMask ? smudging1Copy : smudging0Copy`.
- `fixer()`의 withMask 파라미터: `_mode === 'water'` → `!alphaSmudgingMode && useSecondaryMask`.
- `debuggingRenderTarget` getter: `_mode === 'smudging' ? drawingAlphaRenderTarget : undefined` → `alphaSmudgingMode ? drawingAlphaRenderTarget : undefined`.

### 3.9 Canvas.ts 호출 사이트 변경

```ts
// BEFORE
const mode: DrawingMode = brush?.alphaSmudgingMode ? 'smudging'
    : brush?.useSecondaryMask ? 'water'
    : 'basic';
this.drawingEngine.mode = mode;

// AFTER — Swift와 동일하게 두 플래그를 독립 주입
this.drawingEngine.alphaSmudgingMode = brush?.alphaSmudgingMode ?? false;
this.drawingEngine.useSecondaryMask  = brush?.useSecondaryMask  ?? false;
```

**순서 중요**: `alphaSmudgingMode`를 먼저 설정한다. useSecondaryMask가 먼저 true로 설정된 뒤 alphaSmudgingMode=true가 들어오면 `_resyncDynamicBuffersForMode`에서 mask 버퍼 처리가 꼬일 수 있으므로, 항상 **alphaSmudgingMode 먼저 → useSecondaryMask 나중** 순서로 호출한다. (Swift는 순서 무관이지만 classic의 lazy allocation 때문에 이 제약을 둠.)

또한 `import { DrawingEngine, DrawingMode } from "../engine/DrawingEngine";` 에서 **`DrawingMode` import 제거**.

---

## 4. 변경 파일 목록 (Change Set)

### 4.1 `src/UBrushCore/engine/DrawingEngine.ts` (주요)
- [ ] `export type DrawingMode = ...` 삭제
- [ ] `private _mode: DrawingMode = 'basic';` 삭제
- [ ] `public set mode(...)` / `public get mode()` 삭제
- [ ] `private _alphaSmudgingMode: boolean = false;` 추가
- [ ] `private _useSecondaryMask: boolean = false;` 추가
- [ ] `public set alphaSmudgingMode(v)` + `get` 추가 (§3.4)
- [ ] `public set useSecondaryMask(v)` + `get` 추가 (§3.4)
- [ ] `private _resyncDynamicBuffersForMode()` 추가 (§3.6)
- [ ] `_ensureSmudgingTargets`, `_ensureWaterTargets` 유지 (호출 지점만 setter로 이동)
- [ ] `debuggingRenderTarget` getter 조건식 치환 (§3.8)
- [ ] `setupWithRenderTarget` 2단계 중첩으로 재구성 (§3.7)
- [ ] `drawDots` — 변경 없음 (내부 함수만 분기 변경)
- [ ] `printToRenderTarget` — §3.2 치환
- [ ] `releaseDrawing` — §3.2 치환
- [ ] `cancelDrawing` — §3.2 치환
- [ ] `dry` — §3.2 치환
- [ ] `clear` — §3.2 치환
- [ ] `fixer`, `_buildFixer` — §3.2 치환, `withMask` 인자 계산 주의
- [ ] `fix` — §3.2 치환, `this._useSmudging && this._mode !== 'smudging'` → `this._useSmudging && !this._alphaSmudgingMode`
- [ ] `renderMultiDots` 라우터 — §3.8 순서대로
- [ ] `executeDotProgram` — §3.2 치환, `smudging0Texture` 선택 수정

### 4.2 `src/UBrushCore/canvas/Canvas.ts`
- [ ] `DrawingMode` import 제거
- [ ] `setBrush` 내 mode 계산 삭제
- [ ] `alphaSmudgingMode` → `useSecondaryMask` 순서로 두 라인 대입 (§3.9)
- [ ] 그 외 호출 사이트 변경 없음 (다른 drawingEngine.* 호출은 모두 유지)

### 4.3 `src/UBrushCore/common/IBrush.ts`
- [ ] **변경 없음.** `useSmudging`, `alphaSmudgingMode`, `useSecondaryMask` 필드 이미 존재. 브러시 스키마는 그대로.

### 4.4 그 외
- [ ] 다른 파일에서 `DrawingMode` 또는 `drawingEngine.mode` 참조 **없음** (검증 완료: grep 결과 2개 파일만 사용).
- [ ] Dot/브러시 JSON 스키마 변경 **없음**.

---

## 5. 구현 순서 (Sonnet이 따라야 할 Step)

각 단계가 끝날 때마다 `npx tsc --noEmit` 으로 컴파일 확인하고, §7 회귀 테스트 체크리스트를 돌린다. **한 단계씩 PR처럼 나눠서 진행.**

### Step 1. 속성 도입 (비활성)
목적: 타입/시그니처만 추가. 기존 동작 변화 **0**.
- `_alphaSmudgingMode`, `_useSecondaryMask` 필드 및 getter/setter 추가.
- setter 본문은 일단 필드 대입만. `_ensureSmudgingTargets`/`_resyncDynamicBuffersForMode` 호출 금지.
- `DrawingMode` / `_mode` / `mode` setter는 그대로 유지.
- 컴파일만 확인.

### Step 2. setter 책임 이식
목적: Swift의 `updateAlphaSmugingMode` 동작을 setter로 옮긴다.
- `_resyncDynamicBuffersForMode` 구현 (§3.6).
- `alphaSmudgingMode` setter가 `_ensureSmudgingTargets` + `_resyncDynamicBuffersForMode` 를 호출하도록 수정.
- `useSecondaryMask` setter가 `_ensureWaterTargets`를 호출하도록 수정.
- 이 시점에선 setter가 불려도 내부 `_mode`와 충돌하지 않도록 `_mode`를 같이 동기화하는 임시 코드 추가:
  ```ts
  // TEMPORARY BRIDGE — Step 3 이후 제거
  this._mode = this._alphaSmudgingMode ? 'smudging'
      : this._useSecondaryMask ? 'water' : 'basic';
  ```
- **회귀 테스트(§7) 전 항목 통과**.

### Step 3. Canvas.ts 호출부 전환
- `Canvas.setBrush`에서 `mode` 대입 대신 두 플래그 직접 대입(§3.9).
- 이 단계에서도 Step 2의 bridge 때문에 내부 동작은 동일.
- 회귀 테스트 재실행.

### Step 4. 내부 분기 치환 (대량 편집)
목적: 모든 `this._mode === '...'` 를 새 플래그로 교체.
- §3.2 표에 따라 기계적 치환.
- 함수 단위로 한 개씩, 각 함수 수정 후 **즉시 관련 시나리오 수동 테스트**.
  - 순서 권장: `debuggingRenderTarget` → `setupWithRenderTarget` → `printToRenderTarget` → `releaseDrawing` → `cancelDrawing` → `dry` → `clear` → `fixer` → `fix` → `renderMultiDots` 라우터 → `_renderMultiDotsBasic/Smudging/Water` 내부 → `executeDotProgram`.
- 이 단계 끝나면 `_mode`는 이제 아무도 읽지 않지만 bridge 코드로 쓰이고 있을 뿐.

### Step 5. DrawingMode 제거
- `export type DrawingMode` 삭제.
- `private _mode` 필드 삭제.
- `mode` getter/setter 삭제.
- Step 2의 bridge 코드 삭제.
- `Canvas.ts`의 `DrawingMode` import 삭제.
- 전체 grep으로 `DrawingMode` / `drawingEngine.mode` 잔존 참조 0 확인.

### Step 6. 최종 검증
- `npx tsc --noEmit` 클린.
- §7 회귀 테스트 전 항목 통과.
- `git diff` 리뷰.

---

## 6. 엣지 케이스 / 함정

1. **setter 호출 순서 의존성 (§3.9)**: Canvas에서 두 플래그 대입 순서를 반드시 **alphaSmudgingMode 먼저**로 고정. 반대 순서로 하면 useSecondaryMask setter가 먼저 water 타깃을 할당한 뒤 alphaSmudgingMode setter의 `_resyncDynamicBuffersForMode`가 동적 버퍼를 건드리는 상호작용 발생 가능. Swift는 useSecondaryMask가 속성이 아니라 순서 무관.

2. **idempotent guard**: setter에서 동일 값 대입이 반복될 때 재-separate 비용이 크다. `if (this._alphaSmudgingMode === value) return;`로 가드. **단, `setBrush`가 호출될 때 실제로 값이 바뀌지 않아도 Swift는 `didSet` 미발동 + 수동 `updateAlphaSmugingMode()` 비호출이므로 동작 일치.**

3. **생성 시점의 상태**: 생성자에서 두 플래그 모두 `false`. 현재 `_mode = 'basic'`과 등가. 생성 직후에는 smudging/water 타깃 모두 할당되지 않는다. 이 lazy 성질은 유지.

4. **`alphaSmudgingMode = true` 초기 진입 시 source**: `_resyncDynamicBuffersForMode` true-경로는 `liquidRenderTarget`을 source로 separate 한다. 최초 진입일 때 liquidRenderTarget은 `setupWithRenderTarget` 이전이면 빈 상태일 수 있음. Canvas.ts의 현재 호출 순서 (`setBrush` 후 `engineSetupWithRenderTarget`)에서 이 타이밍을 확인: `setBrush` 내부에서 mode 대입 → setupWithRenderTarget 호출. 이 순서는 **유지**되어야 하며, setter 안의 separate는 "빈 소스에 대한 separate"가 되어 부작용 없음. setupWithRenderTarget이 다시 정확한 값으로 덮어쓴다. → **문제 없음. 단 순서가 뒤집히지 않도록 주의.**

5. **`fixer` / `fix`의 withMask**: 현재 `this._mode === 'water'` 에만 의존. smudging 모드에서는 `_buildFixer`가 `withMask=false`로 강제됨. 치환 시 **alphaSmudgingMode 분기가 먼저** 나와야 함(기존 로직의 분기 순서와 동일).

6. **디버깅 타깃**: `debuggingRenderTarget`을 Canvas.ts가 읽어 화면에 뿌리는 디버그 경로가 있다(Canvas.ts:62). getter 치환만 하면 동작 동일.

7. **`useSmudging` 과의 관계**: `useSmudging`은 **alphaSmudgingMode와 독립**한 별개 플래그. 리팩토링 대상 아님. 기존 setter 그대로 유지.

8. **`releaseDrawing`에서 `liquidRenderTarget` 갱신**: non-smudging 경로에서 `_fill(liquidRenderTarget, drawingRenderTarget.texture)`를 수행. 이 라인은 useSecondaryMask 여부와 무관. 치환 후에도 non-smudging else 블록 **맨 앞**에 있어야 함(기존 순서 유지).

9. **타입 import 정리**: `Canvas.ts`의 import 라인에서 `DrawingMode`만 지우고 `DrawingEngine`은 남긴다.

---

## 7. 회귀 테스트 체크리스트 (수동)

각 Step 완료 후, 아래 매트릭스를 **브러시 카테고리별 대표 3종**에 대해 실행:

| 카테고리 | 대표 브러시                         | alphaSmudging | useSecondaryMask |
|---------|-------------------------------------|:-------------:|:----------------:|
| A (basic)   | `연필` 계열 (일반 브러시)              | false         | false            |
| B (water)   | `페인트 믹싱` / secondary mask 브러시 | false         | true             |
| C (smudg.)  | `알파 스머징` 브러시                   | true          | (무시)           |

각 브러시로 다음 8개 동작 체크:
1. 단일 스트로크 그리기 (색 번짐/누락 없음)
2. 긴 스트로크 (smudging 전진, alpha smudging 전진)
3. 스트로크 중단 후 재시작 (`releaseDrawing` → 새 스트로크)
4. `cancelDrawing` (에러/되돌리기)
5. `dry` 실행 후 다음 스트로크 (dry된 내용 유지 확인)
6. `clear` 후 첫 스트로크
7. **브러시 교체**: A→B→C→A 순환 전환 후 각 교체 직후 첫 스트로크 정상
8. `setupWithRenderTarget` 재호출 (레이어 선택 변경 시나리오) 후 첫 스트로크

추가로:
- 스머징(`useSmudging=true`) 브러시에 대해 A/B/C 각각 검증.
- `alphaLock`이 걸린 상태에서도 동일 체크.
- `fix`/`fixer` 경로: Undo→Redo 1회로 패치 경로 스모크.
- FPS: 긴 드래그에서 체감 속도 회귀 없음 확인 (classic의 성능 기준).

회귀가 가장 나기 쉬운 조합:
- **A→C 전환 직후 첫 스트로크** (→ `_resyncDynamicBuffersForMode` true 경로 검증)
- **C→A 전환 직후 첫 스트로크** (→ false 경로 검증)
- **B→C 전환** (water 타깃 이미 할당된 상태에서 smudging 진입)

---

## 8. 완료 정의 (Definition of Done)

- [ ] `grep -r "DrawingMode" src/` 결과 0건
- [ ] `grep -r "drawingEngine.mode" src/` 결과 0건
- [ ] `DrawingEngine`이 `alphaSmudgingMode`, `useSecondaryMask` 두 개의 독립 boolean 속성만 노출
- [ ] `setBrush` 이후 모든 브러시 카테고리(A/B/C)가 현재와 동일한 시각적 결과
- [ ] `alphaSmudgingMode` 전환 시 Swift `updateAlphaSmugingMode`와 의미 일치 (§3.6 구현 확인)
- [ ] `npx tsc --noEmit` 0 에러
- [ ] §7 회귀 테스트 전 항목 통과
- [ ] 성능 회귀 없음 (긴 드래그, 100+ dots/frame 기준)

---

## 9. 참고 파일 절대 경로

- Classic 대상: `/Users/hwanghochul/sourcetree_ind/ubrush-core-classic/src/UBrushCore/engine/DrawingEngine.ts`
- Classic 호출부: `/Users/hwanghochul/sourcetree_ind/ubrush-core-classic/src/UBrushCore/canvas/Canvas.ts`
- Classic 브러시 타입: `/Users/hwanghochul/sourcetree_ind/ubrush-core-classic/src/UBrushCore/common/IBrush.ts` (L177–180)
- Swift 레퍼런스: `/Users/hwanghochul/sourcetree_ind/ubrushcore-for-swift/UBrushCore/engine/DrawingEngine.swift`
  - `alphaSmudgingMode` 속성: L60–64
  - `updateAlphaSmugingMode`: L272–306
  - `_drawDots`: L832–898 (useSecondaryMask 분기 표 L839–866)
  - `updateSmudging`: L933–1004
  - `executeDotProgram`: L1280–1374

---

## 10. TL;DR

- `DrawingMode`는 `alphaSmudgingMode`와 `useSecondaryMask`의 파생이다. 원천 2변수로 되돌린다.
- 의미적 우선순위: **`alphaSmudgingMode` > `useSecondaryMask`**. 이 순서로 분기.
- `alphaSmudgingMode` setter는 Swift의 `updateAlphaSmugingMode`와 동일한 부수효과를 가져야 한다.
- 호출부에서는 두 플래그를 **순서대로**(alphaSmudging → useSecondaryMask) 대입.
- 렌더 타깃/프로그램은 건드리지 않는다 — 조건식만 바꾼다.
- 6 Step으로 점진 마이그레이션, 각 Step 후 §7 회귀 테스트.
