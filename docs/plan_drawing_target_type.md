# DrawingEngine: DrawingTargetType 도입 계획

## 0. 목적 / Scope

Classic(1번, TypeScript)의 `DrawingEngine`에 Swift(2번)의 **`DrawingTargetType`** 디스패치 패턴을 도입한다. 이전 plan(`plan_drawing_engine_swift_parity.md`)에서 `alphaSmudgingMode`/`useSecondaryMask` 두 boolean 분리는 완료된 상태. 이 plan은 그 후속으로, 분기를 더 단일화해 **type 인자 기반 dispatch**로 통합한다.

- **하지 않을 것 (Out of scope)**:
  - preview 경로 추가 (`effectPreview`, `maskPreview`) — Classic에 아직 해당 기능 없음.
  - `indicator` 경로 (Classic은 별도 시스템).
  - 렌더 타깃 네이밍 / 프로그램 구조 변경.
  - smudging 후행 버퍼 rotation 알고리즘 변경 (모드별 다르고, 그대로 유지).
- **할 것**:
  - `DrawingTargetType` 타입 도입 (Classic은 3-case: `'plain' | 'effect' | 'mask'`).
  - `renderDots`, `executeDotProgram` 시그니처에 type 인자 추가.
  - `currentRenderTarget` / `_currentDotBlend` 인스턴스 필드 제거 (Swift에는 없는 상태).
  - `_renderMultiDotsBasic/Smudging/Water` 세 함수의 공통 골격을 통합. 모드별 차이는 단일 함수 내 분기로 압축.

## 1. Swift 레퍼런스 동작

`DrawingEngine.swift:10` 의 enum:
```swift
enum DrawingTargetType { case plain, effect, effectPreview, mask, maskPreview, indicator }
```

### 1.1 `_drawDots` 의 type 결정 매트릭스 (L832–867)

| preview | alphaSmudg | primary           | secondary                                       |
|:-------:|:----------:|-------------------|-------------------------------------------------|
| true    | true       | `.effectPreview`  | `.effectPreview`                                |
| true    | false      | `.effectPreview`  | `useSecondaryMask ? .maskPreview : .effectPreview` |
| false   | true       | `.plain`          | `.plain`                                        |
| false   | false      | `.effect`         | `useSecondaryMask ? .mask : .effect`            |

### 1.2 `executeDotProgram` 의 type→RT/blendmode 매핑 (L1280–1374)

| type            | renderTarget       | dotBlendmode               | 추가 동작                                   |
|-----------------|--------------------|----------------------------|---------------------------------------------|
| `.plain`        | `plainDynamic`     | `.Normal`                  | `!alphaLockActivated` 면 `plainDynamicAlpha` 추가 draw |
| `.effect`       | `effectDynamic`    | `brush.dotBlendmode`       | -                                           |
| `.effectPreview`| `effectPreview`    | `brush.dotBlendmode`       | -                                           |
| `.mask`         | `maskDynamic`      | `brush.maskDotBlendmode`   | -                                           |
| `.maskPreview`  | `maskPreview`      | `brush.maskDotBlendmode`   | -                                           |
| `.indicator`    | `indicator`        | `.Normal` + indicatorMode  | -                                           |

### 1.3 부가 가드

- `useSmudging && drawingTargetType != .effectPreview` 일 때만 smudging 부트스트랩/갱신 (L909, L925).
- `if drawingTargetType == .plain && primaryDots.count > 0 { hasPlain = true }` 식의 카운터 갱신 (L869–873).

## 2. Classic 현재 구조

### 2.1 dispatch 매개변수
- `currentRenderTarget: RenderTarget` (필드, L60) — water 모드에서 drawing↔maskDrawing 전환 용도.
- `_currentDotBlend: RenderObjectBlend` (필드, L72) — `_dotBlendToRenderObjectBlend(dotBlendmode 또는 maskDotBlendmode)` 결과 저장.
- `useDualTip: boolean` (renderDots 인자) — secondary dot 마커.

### 2.2 모드 분기
- 외층 `renderMultiDots` 라우터 (L660–662):
  ```ts
  if (this._alphaSmudgingMode) return this._renderMultiDotsSmudging(dots);
  if (this._useSecondaryMask) return this._renderMultiDotsWater(dots);
  return this._renderMultiDotsBasic(dots);
  ```
- 내층 `executeDotProgram` (L1015): 다시 `alphaSmudgingMode` / `useSecondaryMask` 분기.

### 2.3 dot 분류
- `dot.isMask` 플래그로 primary(drawing) / secondary(mask) 분리.
  ```ts
  const drawingDots = dots.filter(d => !d.isMask);
  const maskDots = dots.filter(d => d.isMask);
  ```

### 2.4 모드별 후행 처리 (smudging buffer rotation)
세 함수가 각각 다르다:
- **basic** (L695–715): `smudging1Copy ← smudging0Copy` swap, `smudging1Copy ← highLowCut(drawing)` 갱신.
- **smudging (alphaSmudging)** (L753–770): alpha+color 4-target rotation.
- **water (useSecondaryMask)** (L819–835): `smudging1Copy ← maskAndCut(drawing+mask)` 갱신.

### 2.5 preview 부재
- Classic 에는 effectPreview/maskPreview 같은 경로 없음 (grep 결과 0건).

## 3. 리팩토링 설계

### 3.1 새 타입

```ts
export type DrawingTargetType = 'plain' | 'effect' | 'mask';
```

### 3.2 시그니처 변경

```ts
// Before
protected renderDots(dots: Dot[], useDualTip: boolean): Rect | null
protected executeDotProgram(param: {...}): void

// After
protected renderDots(dots: Dot[], type: DrawingTargetType, useDualTip: boolean): Rect | null
protected executeDotProgram(param: {...}, type: DrawingTargetType): void
```

`useDualTip`은 Swift와 마찬가지로 type과 직교한 채 그대로 유지(같은 dot에 dual tip이 같이 적용되는 경우가 있음).

### 3.3 Swift ↔ Classic type 매핑 (Classic 한정)

| Swift type   | Classic 등가 (현재 분기 조건)                                         | 매핑 결과 |
|--------------|-----------------------------------------------------------------------|-----------|
| `.plain`     | `alphaSmudgingMode === true` & primary dots                            | `'plain'` |
| `.effect`    | `alphaSmudgingMode === false` & (primary dots, 또는 useSecondaryMask=false 의 mask dots) | `'effect'` |
| `.mask`      | `alphaSmudgingMode === false && useSecondaryMask === true` & secondary dots (`isMask`) | `'mask'` |

### 3.4 `_drawDotsCore` 로의 통합 (renderMultiDots* 합치기)

세 `_renderMultiDots*` 를 단일 `_drawDotsCore(primaryDots, secondaryDots): Rect | null` 로 합친다.

```ts
private _drawDotsCore(primaryDots: Dot[], secondaryDots: Dot[]): Rect | null {
    // 1. Swift §1.1 표 기반 type 결정 (preview는 항상 false → 하단 두 행만)
    const primaryType: DrawingTargetType = this._alphaSmudgingMode ? 'plain' : 'effect';
    const secondaryType: DrawingTargetType = this._alphaSmudgingMode
        ? 'plain'
        : (this._useSecondaryMask ? 'mask' : 'effect');

    const firstDot = primaryDots[0] ?? secondaryDots[0];
    const lastDot = primaryDots[primaryDots.length - 1] ?? secondaryDots[secondaryDots.length - 1];
    if (firstDot) this.layerOpacity = firstDot.layerOpacity;

    // 2. primary 렌더 (smudging 부트스트랩 포함)
    let rect: Rect | null = null;
    if (this._useSmudging && primaryDots.length > 0) {
        if (this.smudgingDot === undefined) {
            this.smudging0Dot = firstDot;
            this.smudgingDot = firstDot;
            // alphaSmudging/water 는 첫 점 skip (기존 동작 유지)
            const skipFirst = this._alphaSmudgingMode || this._useSecondaryMask;
            const dotsToRender = skipFirst ? primaryDots.slice(1) : primaryDots;
            rect = this.renderDots(dotsToRender, primaryType, false);
        } else {
            rect = this.renderDots(primaryDots, primaryType, false);
        }
        this.smudging0Dot = this.smudgingDot;
        this.smudgingDot = lastDot;
    } else {
        rect = this.renderDots(primaryDots, primaryType, false);
    }

    // 3. secondary 렌더
    const secondaryRect = this.renderDots(secondaryDots, secondaryType, true);
    if (secondaryRect !== null) {
        rect = rect === null ? secondaryRect : Rect.union(rect, secondaryRect);
    }

    if (rect === null) return null;

    // 4. 모드별 smudging buffer rotation (현행 그대로 — 알고리즘이 다름)
    if (this._useSmudging) {
        if (this._alphaSmudgingMode) {
            this._rotateSmudgingBuffersAlphaSmudging(rect);
        } else if (this._useSecondaryMask) {
            this._rotateSmudgingBuffersWater(rect);
        } else {
            this._rotateSmudgingBuffersBasic(rect);
        }
    }

    return rect;
}
```

### 3.5 `executeDotProgram` 의 type switch

```ts
protected executeDotProgram(param: {...}, type: DrawingTargetType): void {
    if (type === 'plain') {
        // alphaSmudgingMode 경로: smudgingDotProgram (alpha + color 두 RT 동시)
        ProgramManager.getInstance().smudgingDotProgram.drawRects(
            this.drawingAlphaRenderTarget!,
            this.drawingRenderTarget,
            { ... }
        );
    } else {
        // effect / mask 공통: drawDotProgram
        const renderTarget = type === 'mask'
            ? this.maskDrawingRenderTarget!
            : this.drawingRenderTarget;
        const blend = this._dotBlendToRenderObjectBlend(
            type === 'mask' ? this.maskDotBlendmode : this.dotBlendmode
        );
        const smudging0Texture = type === 'mask'
            ? this.smudging1CopyRenderTarget.texture  // water mask: 1Copy 재사용
            : this.smudging0CopyRenderTarget.texture;

        ProgramManager.getInstance().drawDotProgram.drawRects(renderTarget, {
            ...
            smudging0Texture,
            smudgingTexture: this.smudging1CopyRenderTarget.texture,
            ...
            blend
        });
    }
}
```

핵심: `currentRenderTarget` / `_currentDotBlend` **인스턴스 필드를 사용하지 않는다**. 모든 정보가 `type` 인자에서 파생된다.

### 3.6 `renderDots` 시그니처 변경의 파급

`renderDots`는 dot 좌표/UV 계산만 담당하고, 실제 RT 선택/blendmode는 `executeDotProgram`에서 type으로 결정. 따라서 `renderDots` 본체는 **type을 그대로 executeDotProgram에 forward만 하면 된다**. 좌표 계산 로직은 변경 없음.

## 4. 변경 파일 목록

### 4.1 `src/UBrushCore/engine/DrawingEngine.ts` (유일 대상)
- [ ] `export type DrawingTargetType = 'plain' | 'effect' | 'mask';` 추가
- [ ] `private currentRenderTarget: RenderTarget;` 필드 삭제 + 생성자 라인 삭제
- [ ] `private _currentDotBlend: RenderObjectBlend = ...;` 필드 삭제
- [ ] `renderDots` 시그니처에 `type` 인자 추가 (본체는 forward만)
- [ ] `executeDotProgram` 시그니처에 `type` 인자 추가, 내부를 type switch로 재구성
- [ ] `_renderMultiDotsBasic/Smudging/Water` → `_drawDotsCore` 한 함수로 통합
- [ ] smudging buffer rotation은 `_rotateSmudgingBuffersBasic/AlphaSmudging/Water` private helper로 분리
- [ ] `renderMultiDots` 라우터를 `_drawDotsCore` 단일 호출로 단순화

### 4.2 다른 파일
- 변경 없음. `renderDots`/`executeDotProgram` 은 protected지만 외부 override 호출은 grep 결과 없음.

## 5. 구현 순서

각 단계 후 `npx tsc --noEmit` 클린(기존 react/JSX 에러 무시) + 시각 회귀 테스트.

### Step 1. 타입 도입 + executeDotProgram type 인자
- `DrawingTargetType` 타입 export 추가.
- `executeDotProgram` 에 `type` 인자 추가 (기본값 추론). 내부는 우선 기존 분기 유지하되 type 값을 호출부에서 정확히 전달.
- 호출부 (`renderDots` 1군데) 수정.
- 컴파일 확인. 동작 무변화.

### Step 2. executeDotProgram 내부를 type switch로
- `currentRenderTarget` / `_currentDotBlend` 의존을 type 인자 기반으로 치환.
- alphaSmudgingMode / useSecondaryMask 분기 → type switch.
- 인스턴스 필드 두 개 아직 삭제하지 않음 (다음 step에서 호출자 정리 후).

### Step 3. renderDots 에 type 인자 추가
- 시그니처 `(dots, useDualTip)` → `(dots, type, useDualTip)`.
- `renderDots` 호출부 (`_renderMultiDotsBasic/Smudging/Water`) 모두 type을 명시 전달.
- 이 시점에서 `_currentDotBlend` 갱신 라인을 제거할 수 있다 (type이 blend 결정).

### Step 4. _renderMultiDots* 통합
- `_drawDotsCore(primaryDots, secondaryDots)` 작성.
- `renderMultiDots` 라우터를 단일 호출로 단순화:
  ```ts
  protected renderMultiDots(dots: Dot[]): Rect | null {
      if (dots.length === 0) return null;
      const drawingDots = dots.filter(d => !d.isMask);
      const maskDots = dots.filter(d => d.isMask);
      return this._drawDotsCore(drawingDots, maskDots);
  }
  ```
- smudging buffer rotation을 `_rotateSmudgingBuffers*` 세 helper로 분리.
- 기존 `_renderMultiDotsBasic/Smudging/Water` 삭제.

### Step 5. 인스턴스 필드 정리
- `currentRenderTarget` 필드 + 생성자 초기화 + 모든 참조 제거.
- `_currentDotBlend` 필드 + `_dotBlendToRenderObjectBlend` 호출 사이트 정리 (executeDotProgram 안에서만 호출되도록).

### Step 6. 검증
- `npx tsc --noEmit` 클린.
- 회귀 테스트 매트릭스 (§7).
- `git diff` 리뷰.

## 6. 엣지 케이스 / 함정

1. **smudging 부트스트랩 차이**: 현행 코드에서 basic 은 첫 점을 그대로 그리고, smudging/water 는 첫 점을 skip 한다. `_drawDotsCore` 통합 시 이 비대칭을 `skipFirst = _alphaSmudgingMode || _useSecondaryMask` 로 표현. **이 비대칭은 의도된 기존 동작이므로 유지**.
2. **water 모드의 mask renderTarget 전환**: 기존 `_renderMultiDotsWater` 는 `currentRenderTarget = drawingRenderTarget` 으로 primary, `currentRenderTarget = maskDrawingRenderTarget` 으로 secondary 를 그렸다. type 기반 디스패치 후에는 type='effect' 면 drawingRenderTarget, type='mask' 면 maskDrawingRenderTarget 으로 자동 분기 → **의미 동일**.
3. **`isMask` dot 가 alphaSmudgingMode 에서 들어오면**: 현행 `_renderMultiDotsSmudging` 은 `maskDots` 를 secondary 로 동일 알고리즘으로 그린다. 통합 후 `secondaryType = 'plain'` 으로 매핑되어 같은 결과 → **의미 동일**.
4. **빈 primary / 빈 secondary**: `renderDots` 가 length=0 일 때 null 반환하므로 안전.
5. **layerOpacity 갱신 시점**: 기존 `_renderMultiDotsBasic` 만 `firstDot.layerOpacity` 를 세팅. `_drawDotsCore` 에서도 첫 dot 으로 동일하게 세팅 → **의미 동일** (다른 두 모드는 이 값을 사용하지 않거나 같은 dot 시퀀스라 차이 없음).
6. **maskAndCut/highLowCut 후행 처리**: smudging buffer rotation 알고리즘은 모드마다 다름. 통합하지 말고 helper 3개로 분리.
7. **executeDotProgram 의 type='plain'**: 항상 alphaSmudgingMode 컨텍스트에서만 호출됨 (type 결정 표가 보장). `drawingAlphaRenderTarget!` non-null assertion 안전.

## 7. 회귀 테스트 체크리스트

이전 plan §7 동일 매트릭스. 브러시 카테고리 A/B/C × 8 동작:

| 카테고리 | 대표 브러시 | alphaSmudg | useSecondaryMask |
|---------|-------------|:----------:|:----------------:|
| A | 연필 (basic) | false | false |
| B | 페인트 믹싱 (water) | false | true |
| C | 알파 스머징 | true | (무시) |

각 8 동작:
1. 단일 스트로크
2. 긴 스트로크 (smudging 전진)
3. 스트로크 중단 후 재시작
4. cancelDrawing
5. dry 후 다음 스트로크
6. clear 후 첫 스트로크
7. 브러시 교체 A→B→C→A 순환
8. setupWithRenderTarget 재호출

추가 회귀가 가장 나기 쉬운 조합:
- **`useSmudging=false` 케이스**: type 매핑 변경의 가장 단순한 사례지만, 스머징 후행 helper를 안 타는 경로 검증.
- **`isMask` dot 가 알파 스머징 모드에서 같이 들어오는 케이스**: 통합 함수의 secondary 분기 검증.

## 8. Definition of Done

- [ ] `DrawingTargetType` 타입 export.
- [ ] `currentRenderTarget` / `_currentDotBlend` 필드 삭제 (`grep` 결과 0).
- [ ] `_renderMultiDotsBasic/Smudging/Water` 함수 삭제 (grep 결과 0).
- [ ] `executeDotProgram` 의 alphaSmudgingMode/useSecondaryMask 분기 → type switch.
- [ ] `npx tsc --noEmit` 0 에러 (DrawingEngine 관련 한정).
- [ ] §7 회귀 테스트 통과.
- [ ] 성능 회귀 없음.

## 9. 참고 파일

- Classic 대상: `/Users/hwanghochul/sourcetree_ind/ubrush-core-classic/src/UBrushCore/engine/DrawingEngine.ts`
- Swift 레퍼런스: `/Users/hwanghochul/sourcetree_ind/ubrushcore-for-swift/UBrushCore/engine/DrawingEngine.swift`
  - `enum DrawingTargetType`: L10–17
  - `_drawDots` type 결정: L832–867
  - `renderPrimaryDots`: L900–931
  - `renderDots`: L1006–1022
  - `executeDotProgram`: L1280–1374
- 선행 plan: `/Users/hwanghochul/sourcetree_ind/ubrush-core-classic/docs/plan_drawing_engine_swift_parity.md`
