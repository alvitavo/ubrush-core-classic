const fs = require('fs');
const path = require('path');

const SWIFT_DIR = '/Users/hwanghochul/sourcetree_ind/ubrushcore-for-swift/resource/brushes';
const CLASSIC_DIR = '/Users/hwanghochul/sourcetree_ind/ubrush-core-classic/brushes';

// 파일 매핑 (Swift 파일명 -> Classic 파일명)
const FILE_MAPPING = {
  'Airbrush.json': 'airbrush.json',
  'Dry media.json': 'dry_media.json',
  'Halftone.json': 'halftone.json',
  'Marker.json': 'marker.json',
  'Pen.json': 'pen.json',
  'Sketch.json': 'sketch.json',
  'Watercolor.json': 'watercolor.json',
  'Wet media.json': 'wet.json',
  'Painting.json': 'acrylic.json',
  'Mix brush.json': 'oil_mix.json',
  'Artist.json': 'impressionist.json',
  'Effect.json': 'special.json',
};

// 추출할 속성들
const PROPERTIES_TO_SYNC = [
  'scaleForAltitude',
  'textureJitter',
  'alphaAngle',
  'tipRepeatCount',
  'dualTipAlphaAngle',
  'dualTipRepeatCount',
];

/**
 * Swift 형식의 range를 Classic 형식으로 변환
 * { range: [min, max] } -> { min, max }
 */
function convertExpressionFormat(swiftExpr) {
  if (!swiftExpr) return swiftExpr;

  if (swiftExpr.range && Array.isArray(swiftExpr.range)) {
    // Swift 형식 -> Classic 형식
    return {
      min: swiftExpr.range[0],
      max: swiftExpr.range[1],
      sources: swiftExpr.sources || []
    };
  }
  return swiftExpr;
}

/**
 * 한 브러시의 속성을 Swift -> Classic으로 복사
 */
function syncBrushProperties(swiftBrush, classicBrush) {
  for (const prop of PROPERTIES_TO_SYNC) {
    if (swiftBrush[prop] !== undefined) {
      // Expression 타입 속성 (min/max 형식 필요)
      if (prop === 'alphaAngle' || prop === 'dualTipAlphaAngle') {
        classicBrush[prop] = convertExpressionFormat(swiftBrush[prop]);
      } else {
        // 단순 값 복사
        classicBrush[prop] = swiftBrush[prop];
      }
    }
  }
  return classicBrush;
}

/**
 * 파일 동기화 실행
 */
function syncFile(swiftFileName, classicFileName) {
  const swiftPath = path.join(SWIFT_DIR, swiftFileName);
  const classicPath = path.join(CLASSIC_DIR, classicFileName);

  // 파일 존재 확인
  if (!fs.existsSync(swiftPath)) {
    console.log(`⚠️  Swift 파일 없음: ${swiftFileName}`);
    return;
  }

  if (!fs.existsSync(classicPath)) {
    console.log(`⚠️  Classic 파일 없음: ${classicFileName}`);
    return;
  }

  try {
    // Swift 파일 읽기
    const swiftData = fs.readFileSync(swiftPath, 'utf8');
    const swiftBrushes = JSON.parse(swiftData);

    // Classic 파일 읽기
    const classicData = fs.readFileSync(classicPath, 'utf8');
    const classicBrushes = JSON.parse(classicData);

    let updateCount = 0;

    // 각 Classic 브러시에 대해 Swift 데이터 적용
    for (let i = 0; i < classicBrushes.length; i++) {
      const classicBrush = classicBrushes[i];

      // Swift 파일에서 같은 이름의 브러시 찾기
      const swiftBrush = swiftBrushes.find(b =>
        b.name && classicBrush.name &&
        b.name.toLowerCase().includes(classicBrush.name.split(' ')[0].toLowerCase())
      ) || swiftBrushes[i]; // 없으면 인덱스로 매칭

      if (swiftBrush) {
        syncBrushProperties(swiftBrush, classicBrush);
        updateCount++;
      }
    }

    // Classic 파일 저장
    fs.writeFileSync(classicPath, JSON.stringify(classicBrushes, null, 2), 'utf8');
    console.log(`✅ ${classicFileName}: ${updateCount}개 브러시 업데이트`);

  } catch (error) {
    console.error(`❌ ${classicFileName} 처리 오류:`, error.message);
  }
}

/**
 * 메인 실행
 */
function main() {
  console.log('🔄 브러시 속성 동기화 시작...\n');

  let totalFiles = 0;
  let processedFiles = 0;

  for (const [swiftFile, classicFile] of Object.entries(FILE_MAPPING)) {
    totalFiles++;
    try {
      syncFile(swiftFile, classicFile);
      processedFiles++;
    } catch (error) {
      console.error(`Error processing ${classicFile}:`, error);
    }
  }

  console.log(`\n✨ 완료! (${processedFiles}/${totalFiles} 파일)`);
}

main();
