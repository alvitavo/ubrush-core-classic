# Phase 4 (typed-array 풀링) 벤치마크 분석

Phase 4 적용 직후 측정 결과 분석 및 다음 단계 제안. 후속 작업 재개 시 이 문서를 출발점으로 사용.

## 측정 결과

벤치마크: 19 favorites stroke 재생, 각 환경 3회 측정.

### Phase 0 (리팩토링 이전)
| 환경 | run 1 | run 2 | run 3 | 평균 |
|---|---|---|---|---|
| no throttling | 7.21s | 7.45s | 7.44s | **7.37s** |
| 6× slowdown | 9.16s | 9.02s | 9.37s | **9.18s** |

### Phase 1–3 (instanced rendering 전환 직후)
| 환경 | run 1 | run 2 | run 3 | 평균 | Δ Phase 0 |
|---|---|---|---|---|---|
| no throttling | 7.38s | 7.44s | 7.43s | **7.42s** | +0.7% |
| 6× slowdown | 10.33s | 9.88s | 10.05s | **10.09s** | **+10%** ⚠ |

### Phase 4 (typed-array 풀링 + bufferSubData 재사용 직후)
| 환경 | run 1 | run 2 | run 3 | 평균 | Δ Phase 0 | Δ Phase 1–3 |
|---|---|---|---|---|---|---|
| no throttling | 9.05s | 9.02s | 9.18s | **9.08s** | **+23%** ⚠ | **+22%** ⚠ |
| 6× slowdown | 8.17s | 8.12s | 8.19s | **8.16s** | **−11%** ✓ | **−19%** ✓ |

### Step 1 (GPU 측 `bufferSubData` 재사용 revert + CPU 풀 유지)
| 환경 | run 1 | run 2 | run 3 | 평균 | Δ Phase 0 | Δ Phase 1–3 | Δ Phase 4 |
|---|---|---|---|---|---|---|---|
| no throttling | 7.67s | 7.76s | 7.77s | **7.73s** | +4.9% | +4.2% | **−15%** ✓ |
| 6× slowdown | 8.67s | 8.24s | 8.20s | **8.37s** | **−8.8%** ✓ | **−17%** ✓ | +2.6% |

## 해석

**핵심 관찰: Phase 4는 CPU-bound일 때 큰 폭으로 빨라지고, GPU-bound일 때 큰 폭으로 느려진다 — 정반대 방향.**

원인이 변경의 두 부분에 따라 갈린다.

### CPU 측 풀 (`DrawingEngine._acquireF32`) — 정확히 의도대로 작동

- 6× throttle 환경에서 −1.93s 큰 폭 win (10.09→8.16). Phase 0(9.18s) 보다도 1초 이상 빨라짐.
- **추론**: Phase 1–3에서 매 stamp `new Float32Array(N × size)` × 12 호출의 ArrayBuffer 할당 + zero-fill이 throttle CPU의 주된 부담이었음. 풀이 이를 제거.

### GPU 측 `bufferSubData` 재사용 (`UBrushContext.render`) — 회귀의 원인

- no-throttle 환경에서 +1.66s 큰 폭 lose (7.42→9.08).
- **추론**: WebGL 잘 알려진 함정. Streaming 데이터에서:
  - `bufferData(data)`는 드라이버가 implicit orphaning(buffer respec)으로 처리 → 새 GPU 메모리 즉시 할당, 옛 버퍼는 in-flight draw 끝나면 자동 해제. **파이프라인 직선 흐름.**
  - `bufferSubData(0, data)`는 같은 버퍼 in-place 수정 → 드라이버가 (a) 이전 draw 완료까지 stall 하거나 (b) shadow buffer copy. **GPU가 바쁠수록 비싸짐.**
- Throttle 환경에서는 GPU가 한가하므로 stall이 발생하지 않아 `bufferSubData`의 micro-saving만 잡힘.

## 추가로 발견된 회귀

**Phase 1–3 자체에 throttle +10% 회귀가 이미 있음** (9.18→10.09). 풀 도입 전이라 매 stamp 12× Float32Array zero-fill 할당이 새 부담으로 추가된 것과 정합적. Phase 4가 이를 가려주고 더 좋은 결과로 보이게 만든 것.

즉 Phase 1–3는 vertex-rate 4× 복제와 인덱스 버퍼는 제거했지만, 데이터 컨테이너를 `number[]` → `Float32Array(N×size)`로 바꾸면서 stamp당 할당 비용이 오히려 증가. **Phase 4의 풀이 이를 흡수해야 비로소 net win이 됨.**

## Step 1 결과 해석

**핵심 결론**:
- **6× throttle**: Phase 0(9.18s)보다 **0.81s 빠름**(−8.8%). CPU 풀이 throttle 회귀를 완전히 해소하고 baseline까지 추월. → **가설 A(Float32Array zero-init 비용) 확정**.
- **no throttle**: Phase 4의 +23% 큰 폭 회귀를 −15%로 거의 완전히 해소. Phase 0 대비 +4.9%, Phase 1–3 대비 +4.2% **잔여 회귀** 존재.
- **GPU 측 회귀의 원인이 `bufferSubData`였음 확정**: 단순 revert만으로 no-throttle이 9.08→7.73s 복구됨.

**no throttle 잔여 ~5% 회귀의 가능 원인**:
- 가설 B: instanced rendering의 driver overhead (`vertexAttribDivisor` × 12 호출, attribute slot 13개 setup) — Phase 1–3에서 도입된 비용
- CPU 풀 자체의 미세 오버헤드 (key lookup × 12 per stamp) — 가능성 작음

Phase 1–3 시점에 no-throttle이 Phase 0 대비 +0.7%로 거의 동등했음을 고려하면, Step 1 시점 +4.9% 회귀는 단순히 Phase 1–3 대비 더 나빠진 것이 아니라, Phase 0 시절 측정 변동성(7.21~7.45 spread)에 묻혀 있던 instanced rendering 도입 비용이 표면으로 드러난 가능성도 있음. 변동성 vs 실제 회귀 구분을 위해 측정 추가가 필요할 수 있음.

## 다음 단계 제안

### ~~Step 1 (즉시): GPU 측만 되돌리고 CPU 풀은 유지~~ — 완료 (위 결과 참조)

### Step 2 (조사): Phase 1–3의 throttle 회귀 원인 분리 — **가설 A 단독 확정**

Step 1의 throttle 결과가 9.18s를 크게 밑돌았으므로(8.37s), `Float32Array(N)` zero-init이 Phase 1–3 throttle 회귀의 단독 원인으로 확정. 가설 B/C(vertexAttribDivisor × 12, subarray JIT)는 throttle 환경에서 의미 있는 비중이 아니었음.

남은 의문은 no-throttle의 잔여 5% — 이는 가설 B(driver overhead)일 가능성이 가장 높음. Step 4가 이를 직접적으로 줄임.

### Step 3 (선택): GPU 측 streaming 최적화 재시도

`bufferSubData`가 streaming에서 회귀를 만드는 것이 확정된 이상, 단순 재사용은 봉인. 대신 다음 중 하나:

- **Buffer orphaning 명시**: `bufferData(target, byteLength, usage)` (size-only) 호출 후 `bufferSubData(0, data)`. 드라이버에 respec 신호. 단, `bufferData(data)`와 동등한 비용일 가능성 있음 — 별 이득 없음.
- **Multi-buffering (round-robin)**: attribute 당 GL buffer 2–3개 순환. in-flight 충돌 회피. 복잡도 증가.
- **`MAP_INVALIDATE_BUFFER_BIT` 계열**: WebGL2에는 직접 노출되지 않음. 대안 없음.

Step 1+2 결과가 만족스럽다면 Step 3는 보류 권장.

### Step 4 (선택): Phase 5 (`#version 300 es` 승격)

`gl_VertexID`로 `a_corner` vertex-rate 버퍼 제거. attribute 슬롯 1개 회수 + 미세 데이터 절감. **Step 1 결과가 양호하고 driver overhead가 추가 issue로 떠오를 때만 진행.**

## 보존된 코드 상태

Step 1 적용 시점:
- `src/UBrushCore/engine/DrawingEngine.ts`: Phase 4 적용 (CPU 풀 유지)
- `src/UBrushCore/gpu/UBrushContext.ts`: **Step 1 적용** (`bufferSubData` 재사용 revert, `bufferData` 단일 경로 복원)
- `src/UBrushCore/gpu/RenderObject.ts`: Phase 1–3 (변경 없음)
- `src/UBrushCore/program/DrawDotProgram.ts`: Phase 1–3
- `src/UBrushCore/program/SmudgingDrawDotProgram.ts`: Phase 1–3

`docs/refactor_instanced_dot_rendering.md`에 Phase 4 완료 섹션 기록됨.
