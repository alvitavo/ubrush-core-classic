# Dot 렌더링 Instanced Rendering 전환

WebGL 2.0 전용으로 전환된 후, dot 그리기를 vertex-expanded 방식에서 instanced rendering으로 옮긴 리팩토링 기록.

## 배경

기존 구현(`DrawingEngine.renderDots`)은 dot N개를 그릴 때:

- 4N개 정점에 해당하는 9개의 `number[]` 배열을 매 stamp마다 생성
- per-dot 속성(`colors`, `opacities`, `corrosions`)을 정점마다 4번 복제하여 총 16N 길이 배열로 푸시
- pattern/smudging UV는 회전 사각형의 4 코너를 각각 `pointInTexture(rp_k, ...)`로 변환
- `drawElements(TRIANGLES, 6N, UNSIGNED_SHORT)`로 한 번에 그림

`DrawDotProgram.drawRects` / `SmudgingDrawDotProgram.drawRects` 진입 시 이 9개 배열을 다시 `new Float32Array(...)`로 복사 → GC 압력의 주된 원인.

## 목표

- per-dot 데이터를 1배만 GPU로 전송 (vertex-rate 4× 복제 제거)
- 인덱스 버퍼와 매 stamp `new Float32Array(...)` 복사 제거
- WebGL 2.0 코어 API(`vertexAttribDivisor`, `drawArraysInstanced`)만 사용 — 확장 의존 없음
- 시맨틱 동치 보존 (픽셀 동일성)

## 데이터 모델

### Vertex-rate (4정점, 모든 dot 공통, divisor=0)

| Attribute | size | 값 |
|---|---|---|
| `a_corner` | vec2 | `{(-1,-1), (1,-1), (-1,1), (1,1)}` (TRIANGLE_STRIP 순서: TL, TR, BL, BR) |

### Per-instance (dot 1개당 1엔트리, divisor=1)

| Attribute | size | 의미 |
|---|---|---|
| `a_posCenterAxisU` | vec4 | (clipCenterX, clipCenterY, axisU.x, axisU.y) |
| `a_posAxisV` | vec2 | (axisV.x, axisV.y) |
| `a_tipUV` | vec4 | (textureL, textureT, ΔU, ΔV) |
| `a_patternUVa` | vec4 | (patternUV0.x, patternUV0.y, patternDx.x, patternDx.y) |
| `a_patternUVb` | vec2 | (patternDy.x, patternDy.y) |
| `a_smudging0UVa` | vec4 | (smudging0UV0.xy, smudging0Dx.xy) |
| `a_smudging0UVb` | vec2 | smudging0Dy.xy |
| `a_smudgingUVa` | vec4 | (smudgingUV0.xy, smudgingDx.xy) |
| `a_smudgingUVb` | vec2 | smudgingDy.xy |
| `a_tintColor` | vec4 | (r, g, b, tinting) |
| `a_opacity` | vec4 | (opacity, patternOpacity, mixingOpacity, i/N) |
| `a_corrosion` | vec4 | (tipCorrosion, textureCorrosion, tipCorrosionSize, textureCorrosionSize) |

총 13 attribute slot 사용 (WebGL2 최소치 16 안쪽).

## 수학적 도출

### 클립-space 위치

기존 코드:
```
rp(corner) = (cx, cy)
           + corner.x * (cosθ·dhw, sinθ·dhw)
           + corner.y * (-sinθ·dhh, cosθ·dhh)

clipPos(corner) = pointInStage(rp(corner), size)
                = (rp.x / (W/2) - 1, rp.y / (H/2) - 1)
```

`pointInStage`는 클램핑/접기 없는 순수 affine이므로(검증 완료 — `Common.ts` 29–35) corner에 대해 선형 분리 가능:

```
clipCenter = (cx / (W/2) - 1, cy / (H/2) - 1)
axisU      = (cosθ·dhw / (W/2), sinθ·dhw / (H/2))
axisV      = (-sinθ·dhh / (W/2), cosθ·dhh / (H/2))

clipPos(corner) = clipCenter + corner.x · axisU + corner.y · axisV
```

### Tip UV

corner가 `{(-1,-1), (1,-1), (-1,1), (1,1)}`일 때 tipUV는 `{(L,T), (R,T), (L,B), (R,B)}`. `bary = corner·0.5 + 0.5`로 정규화하면:
```
tipUV(corner) = (L, T) + bary · (ΔU, ΔV)
```

### Pattern UV

기존:
```
patternUV(corner) = pointInTexture(rp, patternSize) · (pox, poy)
                  + tipUV(corner) · (poxc, poyc)
                  + (jx, jy)
```

세 항 모두 corner의 선형 함수이므로 결합:
```
patternUV0 = (cx·pox/pw + L·poxc + 0.5·ΔU·poxc + jx,
              cy·poy/ph + T·poyc + 0.5·ΔV·poyc + jy)

patternDx  = (cosθ·dhw·pox/pw + 0.5·ΔU·poxc, sinθ·dhw·poy/ph)
patternDy  = (-sinθ·dhh·pox/pw,                cosθ·dhh·poy/ph + 0.5·ΔV·poyc)
```

4개 코너 위치 모두에서 기존 식과 일치 검증 완료.

### Smudging / smudging0 UV

`smudgingDot`/`smudging0Dot`의 중심을 사용하지만 **원본 dot의 dhw, dhh**를 사용 (기존 동일):
```
smudgingUV0 = (smudgingDot.cx / W, smudgingDot.cy / H)
smudgingDx  = (cosθ_smudge · dhw / W, sinθ_smudge · dhw / H)
smudgingDy  = (-sinθ_smudge · dhh / W, cosθ_smudge · dhh / H)
```

`_useSmudging`이 false면 UV0/Dx/Dy 모두 0 (`Float32Array` 기본값) — 기존 코드의 "코너별 0 채우기"와 동치.

### Bounding box (해석적)

기존: 4 코너의 클립-space 좌표 min/max  
신규: `|axisU.x| + |axisV.x|` / `|axisU.y| + |axisV.y|` (회전 사각형의 AABB 공식)

## 구현 변경

### 1. `gpu/RenderObject.ts`
- `Attribute.divisor?: number` 추가 (기본 0)
- `RenderObject.instanceCount?: number` 추가
- `clear()`에서 둘 다 리셋

### 2. `gpu/UBrushContext.ts` `render()`
- attribute 바인딩 시 `gl.vertexAttribDivisor(loc, attr.divisor ?? 0)` 호출
- `instanceCount`가 설정되면:
  - indexData 있음 → `gl.drawElementsInstanced(...)`
  - 없음 → `gl.drawArraysInstanced(...)`
- 정리 루프에서 divisor가 0이 아니었던 attribute는 0으로 복원 후 disable (다른 program이 같은 슬롯을 vertex-rate로 쓸 때 누수 방지)

### 3. `program/DrawDotProgram.ts` / `program/SmudgingDrawDotProgram.ts`
- 셰이더 재작성: 위 데이터 모델대로 attribute 선언, vertex shader가 corner의 affine 결합으로 모든 출력 생성
- `drawRects` 시그니처: 9개 `number[]` → 12개 `Float32Array` + `instanceCount`
- 공유 `QUAD_CORNERS` Float32Array 모듈 상수
- `drawMode = TriangleStrip`, `numberOfPoints = 4`, `indexData = undefined`

### 4. `engine/DrawingEngine.ts`
- `renderDots` 루프 본문 재작성:
  - 9개 `number[]` 할당 → 12개 `Float32Array` 직접 생성
  - 4중 복제 루프(`for j=0..4`), 인덱스 생성, 4 코너 변환 모두 제거
  - rotation의 `cos`/`sin`은 dot당 1회 (smudging이 켜졌을 때만 추가 1회)
  - `Point` allocation 0회 (기존: dot당 최대 12회)
- `executeDotProgram` 시그니처도 새 데이터에 맞게 변경

## 데이터량 비교 (per dot)

| 항목 | 기존 | 신규 |
|---|---|---|
| points | 8 floats | (clipCenter+axisU+axisV) 6 floats |
| tip UV | 8 floats | 4 floats |
| pattern UV | 8 floats | 6 floats |
| smudging UV | 8 floats × 2 | 6 floats × 2 |
| color | 16 floats (4× 복제) | 4 floats |
| opacity | 16 floats (4× 복제) | 4 floats |
| corrosion | 16 floats (4× 복제) | 4 floats |
| **attribute 합계** | **88 floats = 352 B** | **40 floats = 160 B** |
| index buffer | 6 ushort = 12 B | 0 |
| **총합** | **~364 B/dot** | **160 B/dot** (≈ 56% 감소) |

색상/오패시티/코로전 한정으로는 정확히 4× 감소.

## 검증

- TypeScript `tsc --noEmit` 통과 (사전 존재하던 React/JSX 환경 에러 외 신규 에러 0)
- `Common.pointInStage` / `Common.pointInTexture`가 순수 affine임을 코드로 확인 — 셰이더 측 UV 선형 복원 안전
- pattern UV 도출식을 4개 코너에서 모두 기존식과 비교 → 일치 확인

## Phase 4 — typed-array 풀링 (완료)

### CPU-side: `DrawingEngine._f32Pool`
- 12개 attribute(`posCenterAxisU`, `posAxisV`, `tipUV`, `patternUVa/b`, `smudging0UVa/b`, `smudgingUVa/b`, `tintColor`, `opacity`, `corrosion`)에 대응하는 백킹 `Float32Array`를 인스턴스 필드로 보관.
- `_acquireF32(key, length)`: 요청 길이가 백킹보다 크면 `max(length, ceil(capacity * 1.5))`로 재할당. 작거나 같으면 `subarray(0, length)`만 반환 — ArrayBuffer 신규 할당 없음.
- 이전 stamp의 zero-init 가정을 유지하기 위해 `useSmudging === false`일 때 4개 smudging UV subarray를 `fill(0)`로 클리어 (4 작은 fill — 종전 4 fresh `Float32Array`보다 저렴).

### GPU-side: `UBrushContext.render` `bufferSubData` 재사용
- `properties[renderObject][name]`의 값이 `WebGLBuffer` → `{ buf, byteCapacity }` 로 변경.
- 업로드 분기:
  - `attribute.data.byteLength <= byteCapacity` → `bufferSubData(target, 0, data)` (재할당 없음)
  - 초과 → `bufferData(target, data, DYNAMIC_DRAW)` 후 `byteCapacity = byteLength` 갱신 (high-water 추적)
- `ELEMENT_ARRAY_BUFFER`(인덱스) 경로에도 동일 패턴 적용.
- 이로써 `numberOfDots` 단조증가 stroke에서 GPU 버퍼는 ~log₁.₅(N)회만 reallocate, 정상 stroke에서는 첫 stamp 이후 재할당 0회.

### 검증
- TypeScript `tsc --noEmit` 통과 (사전 React/JSX 에러 외 신규 에러 0).
- 시맨틱 변경 없음 — `attribute.data`는 이전과 같은 길이의 typed-array view, 셰이더는 그대로.

## 미수행 / 후속 작업

- **브라우저 pixel-diff 검증** — 동일 stroke의 픽셀 동일성 실측 (코드 동치성은 수학적으로 확인됨; 실측은 권장 사항)
- **벤치마크 측정** — `benchmark/main.ts`에서 `cpuMs` / `flushMs` / `heapDeltaMb` 비교  
  예상: cpuMs 큰 감소 (4× 복제 + `new Float32Array` 제거 + Phase 4의 풀 재사용), flushMs 작은 감소 (vertex setup), heap delta 큰 감소
- **Phase 5 — `#version 300 es` 승격 (선택)**: `gl_VertexID`로 `a_corner` vertex-rate 버퍼 제거. 추가 ~32 byte/draw 절감 + 1 attribute slot 회수. 본 작업과 직교하므로 별도 진행.

## 위험 및 검토 포인트

- **divisor 누수**: 다른 program(MaskAndCut, HighLowCut 등)이 같은 attribute slot을 vertex-rate로 사용할 수 있어 정리 루프에서 0 복원 필수 — `UBrushContext.render` 끝 부분에서 처리됨
- **Attribute 슬롯 한도**: 13개 사용, 모바일 WebGL2 최소치 16 안쪽으로 안전
- **셰이더 정밀도**: 기존 `varying` 정밀도(`lowp` / `highp`) 그대로 유지 — 정밀도 회귀 없음

## 변경 파일

Phase 1–3 (instanced rendering 전환):
```
src/UBrushCore/engine/DrawingEngine.ts           +180 -145
src/UBrushCore/gpu/RenderObject.ts               +3
src/UBrushCore/gpu/UBrushContext.ts              +20 -5
src/UBrushCore/program/DrawDotProgram.ts         +70 -38
src/UBrushCore/program/SmudgingDrawDotProgram.ts +75 -47
```

Phase 4 (typed-array 풀링):
```
src/UBrushCore/engine/DrawingEngine.ts           +28 -12
src/UBrushCore/gpu/UBrushContext.ts              +25 -5
```
