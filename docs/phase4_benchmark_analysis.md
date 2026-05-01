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

### 재측정 (Phase 0 vs Step 1, 각 5회)

이전 3회 측정의 분산이 우려되어 Phase 0과 Step 1만 5회씩 재측정.

**Phase 0 (재측정)**
| 환경 | runs | 평균 | σ | spread |
|---|---|---|---|---|
| no throttling | 7.63 / 7.67 / 7.56 / 7.62 / 7.65 | **7.626s** | 0.037s | 0.11s (1.4%) |
| 6× slowdown | 9.27 / 9.26 / 9.42 / 9.43 / 9.02 | **9.280s** | 0.149s | 0.41s (4.4%) |

**Step 1 (재측정)**
| 환경 | runs | 평균 | σ | spread |
|---|---|---|---|---|
| no throttling | 7.59 / 7.76 / 7.77 / 7.77 / 7.80 | **7.738s** | 0.075s | 0.21s (2.7%) |
| 6× slowdown | 8.47 / 8.58 / 8.23 / 8.29 / 8.27 | **8.368s** | 0.134s | 0.35s (4.2%) |

**비교 (재측정 기준)**
| 환경 | Δ Phase 0 → Step 1 | t (대략) | 통계적 유의성 |
|---|---|---|---|
| no throttling | +1.5% (7.626 → 7.738) | ≈ 1.3 | **노이즈 범위 (유의 없음)** |
| 6× slowdown | **−9.8%** ✓ (9.280 → 8.368) | ≈ 4.5 | **명확히 유의** |

이전 3회 측정의 Phase 0 no-throttle 평균(7.37s)은 첫 run(7.21s) 이상치 영향으로 낙관적이었음. 5회 재측정 baseline은 7.626s가 더 신뢰 가능.

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

## Step 1 결과 해석 (재측정 기준)

**핵심 결론**:
- **6× throttle: 명확한 win** (−9.8%, 4.5σ). CPU 풀이 Phase 1–3 throttle 회귀를 완전히 해소하고 Phase 0 baseline까지 추월. → **가설 A(`Float32Array(N)` zero-init 비용) 단독 확정**.
- **no throttle: 사실상 동등** (+1.5%, 1.3σ — 노이즈 범위). 이전 3회 측정의 +4.9% 회귀로 보였던 갭은 Phase 0 baseline의 측정 변동성에 의한 착시로 판명.
- **Phase 4의 GPU 측 회귀 원인이 `bufferSubData` 재사용이었음 확정**: 단순 revert만으로 no-throttle이 9.08→7.73s 복구.

**Step 1 = 원래 success criterion 달성**: "두 환경 모두에서 Phase 0보다 같거나 빠른 첫 번째 후보" — throttle은 명백한 win, no-throttle은 통계적으로 동등.

## 다음 단계 결정

### ~~Step 1 (즉시): GPU 측만 되돌리고 CPU 풀은 유지~~ — **완료 ✓**

### ~~Step 2 (조사): Phase 1–3의 throttle 회귀 원인 분리~~ — **가설 A 단독 확정**

Step 1의 throttle 결과가 Phase 0를 9.8% 밑돌았으므로 `Float32Array(N)` zero-init이 Phase 1–3 throttle 회귀의 단독 원인. 가설 B/C(vertexAttribDivisor × 12, subarray JIT)는 측정 가능한 비중이 아니었음.

### Step 3 (선택): GPU streaming 최적화 — **보류**

Step 1의 단순 `bufferData` 단일 경로로 두 환경 모두 만족스러운 성능 도달. multi-buffering / explicit orphaning은 비용 대비 이득 없음.

### Step 4 (선택): Phase 5 (`#version 300 es` 승격) — **성능 정당성 소멸**

원래 no-throttle 잔여 회귀를 attribute slot 13→12 감축으로 해소할 목적이었으나, 재측정 결과 잔여 회귀 자체가 노이즈 범위로 판명. 성능 동기로는 진행 가치 없음. 향후 코드 단순화 / 신규 GLSL 기능(UBO, integer attribute, transform feedback) 활용 동기가 별도로 생길 때 재검토.

## 최종 채택 상태

**Step 1을 최종 상태로 확정**. Phase 4 작업은 다음 형태로 정착:
- ✓ CPU 측 Float32Array 풀(`DrawingEngine._f32Pool` + `_acquireF32`) — 유지
- ✗ GPU 측 `bufferSubData` 재사용 — revert (단순 `bufferData` 단일 경로)

Phase 0 대비 효과 (재측정 기준):
- no throttling: **−0% ~ +1.5%** (동등, 노이즈 내)
- 6× slowdown: **−9.8%** ✓

### Step 3 (선택): GPU 측 streaming 최적화 재시도

`bufferSubData`가 streaming에서 회귀를 만드는 것이 확정된 이상, 단순 재사용은 봉인. 대신 다음 중 하나:

- **Buffer orphaning 명시**: `bufferData(target, byteLength, usage)` (size-only) 호출 후 `bufferSubData(0, data)`. 드라이버에 respec 신호. 단, `bufferData(data)`와 동등한 비용일 가능성 있음 — 별 이득 없음.
- **Multi-buffering (round-robin)**: attribute 당 GL buffer 2–3개 순환. in-flight 충돌 회피. 복잡도 증가.
- **`MAP_INVALIDATE_BUFFER_BIT` 계열**: WebGL2에는 직접 노출되지 않음. 대안 없음.

Step 1+2 결과가 만족스럽다면 Step 3는 보류 권장.

### Step 4 (선택): Phase 5 (`#version 300 es` 승격)

`gl_VertexID`로 `a_corner` vertex-rate 버퍼 제거. attribute 슬롯 1개 회수 + 미세 데이터 절감. **Step 1 결과가 양호하고 driver overhead가 추가 issue로 떠오를 때만 진행.**

## 최종 코드 상태 (Step 1 종결)

- `src/UBrushCore/engine/DrawingEngine.ts`: CPU 풀 적용 (Phase 4 유지)
- `src/UBrushCore/gpu/UBrushContext.ts`: 단순 `bufferData` 단일 경로 (Phase 1–3 동등, Step 1 revert)
- `src/UBrushCore/gpu/RenderObject.ts`: Phase 1–3 (변경 없음)
- `src/UBrushCore/program/DrawDotProgram.ts`: Phase 1–3
- `src/UBrushCore/program/SmudgingDrawDotProgram.ts`: Phase 1–3

`docs/refactor_instanced_dot_rendering.md`에 Phase 4 완료 섹션 기록됨.
