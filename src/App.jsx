import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Upload, FileText, FileSpreadsheet, Loader2, CheckCircle2, AlertCircle, Download, X, Eye, EyeOff, Edit3, ChevronDown, ChevronUp, RefreshCw, Sparkles, Image as ImageIcon, Key } from 'lucide-react';

export default function App() {
  const [pdfFile, setPdfFile] = useState(null);
  const [excelFile, setExcelFile] = useState(null);
  const [codeMaps, setCodeMaps] = useState(null);
  const [excelBuffer, setExcelBuffer] = useState(null); // 원본 코드 테이블 엑셀 buffer (시트 복사용)
  const [stage, setStage] = useState('idle');
  const [progress, setProgress] = useState({ current: 0, total: 0, label: '' });
  const [extractedRecords, setExtractedRecords] = useState([]);
  const [logs, setLogs] = useState([]);
  const [error, setError] = useState(null);
  const [pdfjsReady, setPdfjsReady] = useState(false);
  const [xlsxReady, setXlsxReady] = useState(false);
  const [editingIdx, setEditingIdx] = useState(null);
  const [showRawText, setShowRawText] = useState(false);
  const [pageThumbnails, setPageThumbnails] = useState([]);
  const [resultFileBlob, setResultFileBlob] = useState(null);
  const [renderScale, setRenderScale] = useState(2.0); // PDF → 이미지 렌더 배율
  const [pagesPerCall, setPagesPerCall] = useState(2); // API 호출당 페이지 수
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('gemini_api_key') || '');
  const [showApiKey, setShowApiKey] = useState(false);
  const [geminiModel, setGeminiModel] = useState(() => localStorage.getItem('gemini_model') || 'gemini-2.5-flash');

  const pdfInputRef = useRef(null);
  const excelInputRef = useRef(null);
  const cancelRef = useRef(false);

  // ==========  외부 라이브러리 로드  ==========
  useEffect(() => {
    const loadScript = (src, globalCheck) => new Promise((resolve, reject) => {
      if (globalCheck()) { resolve(); return; }
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(s);
    });

    (async () => {
      try {
        await loadScript(
          'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
          () => !!window.pdfjsLib
        );
        if (window.pdfjsLib) {
          window.pdfjsLib.GlobalWorkerOptions.workerSrc =
            'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
          setPdfjsReady(true);
        }
        await loadScript(
          'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
          () => !!window.XLSX
        );
        if (window.XLSX) setXlsxReady(true);
      } catch (e) {
        setError('외부 라이브러리 로드 실패: ' + e.message);
      }
    })();
  }, []);

  const addLog = useCallback((msg, type = 'info') => {
    setLogs(prev => [...prev.slice(-200), { msg, type, time: new Date().toLocaleTimeString('ko-KR') }]);
  }, []);

  // ==========  엑셀 코드 테이블 로드  ==========
  const handleExcelUpload = async (file) => {
    if (!file) return;
    if (!window.XLSX) { setError('엑셀 라이브러리가 아직 로드되지 않았습니다.'); return; }
    setExcelFile(file);
    addLog(`코드 테이블 엑셀 로딩: ${file.name}`);
    try {
      const buf = await file.arrayBuffer();
      setExcelBuffer(buf.slice(0)); // 원본 buffer 보존 (출력 시 시트 복사에 사용)
      const wb = window.XLSX.read(buf, { type: 'array' });
      const maps = {};
      const readSheet = (name, hasHeader = true) => {
        if (!wb.Sheets[name]) return [];
        const json = window.XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' });
        const rows = hasHeader ? json.slice(1) : json;
        return rows.filter(r => r[0] && r[1]).map(r => ({ code: String(r[0]).trim(), name: String(r[1]).trim() }));
      };
      maps.근무처 = readSheet('근무처', true);
      maps.직위 = readSheet('직위', true);
      maps.발주자 = readSheet('발주자', true);
      maps.담당업무 = readSheet('담당업무', false);
      maps.공사종류 = readSheet('공사종류', true);
      setCodeMaps(maps);
      addLog(
        `코드 테이블 로딩 완료: 근무처 ${maps.근무처.length} · 발주자 ${maps.발주자.length} · ` +
        `직위 ${maps.직위.length} · 담당업무 ${maps.담당업무.length} · 공사종류 ${maps.공사종류.length}`,
        'success'
      );
    } catch (e) {
      setError('엑셀 파일 분석 실패: ' + e.message);
      addLog('엑셀 분석 실패: ' + e.message, 'error');
    }
  };

  const handlePdfUpload = (file) => {
    if (!file) return;
    setPdfFile(file);
    setExtractedRecords([]);
    setPageThumbnails([]);
    setStage('idle');
    addLog(`PDF 파일 선택: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);
  };

  // ==========  PDF 페이지 → 이미지 (base64)  ==========
  const renderPageToBase64 = async (pdf, pageNum, scale) => {
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    // 흰 배경
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    // JPEG로 압축 (PNG보다 훨씬 작음, 텍스트 인식엔 충분)
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    const base64 = dataUrl.split(',')[1];
    canvas.width = 0; canvas.height = 0;
    return { base64, width: viewport.width, height: viewport.height };
  };

  // ==========  Gemini Vision API 호출  ==========
  const extractPagesWithClaude = async (pageImages, startPageNum) => {
    const sysPrompt = `당신은 한국 건설기술인협회의 "건설기술인 경력증명서" PDF에서 기술경력 항목을 추출하는 전문가입니다.

경력증명서의 "1. 기술경력" 섹션은 표 형식으로 되어 있으며, 각 행은 하나의 경력 항목입니다. 각 항목은 다음 컬럼을 가집니다:

| 참여기간(인정일) | 사업명 / 발주자 / 공사(용역)개요 / 적용공법 | 직무분야 / 전문분야 / 책임정도 / 적용 신·복합건설기술 | 담당업무 / 직위 / 공사(용역)금액(백만원) / 시설물 종류 |

표에서 읽어야 할 핵심 정보:
- **참여기간**: 시작일 ~ 종료일 (yyyy.mm.dd 형식), 그리고 (N일) 형식의 인정일수
- **사업명**: 첫 번째 큰 글자로 적힌 공사/사업 이름 (예: "중앙선도농지하차도공사")
- **발주자**: 사업명 아래줄 (예: "철도청", "국가철도공단")
- **공사개요**: 발주자 다음 줄, 콤마로 연결된 시설물 키워드 (예: "교량,궤도", "노반,교량,궤도")
- **직무분야**: 예 "토목", "건축", "기계"
- **전문분야**: 예 "철도·삭도", "철도ㆍ삭도" → "철도.삭도"로 통일
- **책임정도**: 예 "*공사감독", "공사감독", "참여기술자"
- **담당업무**: 예 "감독", "사업관리", "설계"
- **직위**: 예 "토목서기", "토목주사보", "과장"
- **공사금액**: 숫자 (백만원 단위)
- **시설물종류**: 예 "레일용접 (가스압접 460개소, 테르밋 252개소)"

추출 규칙:
1. 각 항목의 데이터는 표 한 행 안에 있으므로, 위에서 아래로 같은 행 안의 텍스트를 모두 같은 항목으로 묶어야 합니다.
2. 다음 항목으로 넘어가는 기준은 새로운 "yyyy.mm.dd ~ yyyy.mm.dd" 기간이 시작될 때입니다.
3. 페이지 헤더("성명 : ...", "Page : N / N", "1. 기술경력") 등은 무시합니다.
4. 빈 필드는 빈 문자열 ""로 두세요. 절대 추측하지 마세요.
5. 날짜는 반드시 YYYY-MM-DD 형식으로 변환하세요 (예: "1982.02.26" → "1982-02-26").

응답은 반드시 JSON 배열로만 출력하세요. 마크다운, 설명, 주석 없이 순수 JSON만.`;

    const userText = `다음은 건설기술인 경력증명서 PDF의 페이지 ${pageImages.map((_, i) => startPageNum + i).join(', ')}입니다.
각 페이지의 "1. 기술경력" 표에서 모든 경력 항목을 추출하여 아래 형식의 JSON 배열로 출력하세요:

[
  {
    "startDate": "YYYY-MM-DD",
    "endDate": "YYYY-MM-DD",
    "days": "734",
    "projectName": "중앙선도농지하차도공사",
    "owner": "철도청",
    "overview": "교량,궤도",
    "constructionType": "교량,궤도",
    "specialty": "철도.삭도",
    "duty": "감독",
    "position": "토목서기",
    "responsibility": "공사감독",
    "amount": "",
    "facilityType": ""
  }
]

각 페이지의 표에서 보이는 모든 경력 항목을 빠짐없이 추출하세요. 페이지 끝에서 다음 페이지로 이어지는 항목은 한 번만 추출합니다(중복 방지). JSON 배열만 출력하세요.`;

    // Gemini API 호출 형식: parts 배열 안에 inline_data와 text를 함께 넣음
    // 시스템 프롬프트는 별도 필드(systemInstruction)로 전달
    const parts = [
      ...pageImages.map(img => ({
        inline_data: { mime_type: 'image/jpeg', data: img.base64 }
      })),
      { text: userText }
    ];

    if (!apiKey) {
      throw new Error('Google Gemini API 키가 설정되지 않았습니다. 상단의 API 키 입력란을 확인하세요.');
    }
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent`;
    const requestBody = JSON.stringify({
      systemInstruction: { parts: [{ text: sysPrompt }] },
      contents: [{ role: 'user', parts }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 8000,
        responseMimeType: 'application/json',
      }
    });

    // 자동 재시도 로직: 503/429/500 등 일시적 에러는 지수 백오프로 재시도
    const maxRetries = 3;
    const retryDelays = [5000, 10000, 20000]; // 5초, 10초, 20초
    let response;
    let lastError = '';

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: requestBody
      });

      if (response.ok) break; // 성공이면 루프 탈출

      const errText = await response.text();
      lastError = errText;
      const isRetryable = [429, 500, 502, 503, 504].includes(response.status);

      if (!isRetryable || attempt === maxRetries) {
        // 재시도 불가능한 에러이거나 마지막 시도이면 에러 발생
        if (response.status === 429) {
          throw new Error(`Gemini API 한도 초과 (분당/일일 한도). 잠시 후 다시 시도하거나 다른 모델로 변경하세요. ${errText.slice(0, 200)}`);
        }
        if (response.status === 400 && errText.includes('API key')) {
          throw new Error(`Gemini API 키가 유효하지 않습니다. aistudio.google.com에서 새 키를 발급받으세요.`);
        }
        if (response.status === 503) {
          throw new Error(`Gemini ${geminiModel} 모델이 현재 매우 혼잡합니다. 다른 모델(Flash-Lite 등)로 변경하거나 5-10분 후 다시 시도하세요.`);
        }
        throw new Error(`Gemini API ${response.status}: ${errText.slice(0, 300)}`);
      }

      // 재시도 가능한 에러 → 잠시 기다렸다가 재시도
      const delay = retryDelays[attempt];
      addLog(`⚠ Gemini ${response.status} 에러. ${delay/1000}초 후 재시도 (${attempt + 1}/${maxRetries})...`, 'info');
      await new Promise(r => setTimeout(r, delay));
      // 사용자가 중단 버튼 눌렀으면 더 시도하지 않음
      if (cancelRef.current) throw new Error('사용자가 중단했습니다.');
    }

    if (!response.ok) {
      throw new Error(`Gemini API ${response.status}: ${lastError.slice(0, 300)}`);
    }
    const data = await response.json();
    // Gemini 응답 구조: candidates[0].content.parts[0].text
    if (!data.candidates || !data.candidates[0]) {
      throw new Error('Gemini 응답에 candidates가 없음. ' + JSON.stringify(data).slice(0, 200));
    }
    const candidate = data.candidates[0];
    if (candidate.finishReason && candidate.finishReason !== 'STOP') {
      console.warn('Gemini finishReason:', candidate.finishReason);
    }
    const text = (candidate.content?.parts || []).map(p => p.text || '').join('');
    const cleaned = text.replace(/```json\s*|\s*```/g, '').trim();
    const arrMatch = cleaned.match(/\[[\s\S]*\]/);
    if (!arrMatch) {
      console.warn('Gemini response without JSON array:', text);
      return [];
    }
    const parsed = JSON.parse(arrMatch[0]);
    return parsed.map(r => ({
      startDate: r.startDate || '',
      endDate: r.endDate || '',
      days: r.days || '',
      projectName: r.projectName || '',
      owner: r.owner || '',
      overview: r.overview || r.facilityType || '',
      constructionType: r.constructionType || '',
      specialty: r.specialty || '',
      duty: r.duty || '',
      position: r.position || '',
      responsibility: r.responsibility || '',
      amount: r.amount || '',
      note: '',
      rawBlock: ''
    }));
  };

  // ==========  코드 매핑  ==========
  const normalize = (s) => (s || '').replace(/\s/g, '').replace(/[ㆍ·.·•,，\-]/g, '').toLowerCase();

  const findCode = (list, query) => {
    if (!query || !list?.length) return { code: '', matchedName: '', confidence: 0 };
    const qNorm = normalize(query);
    if (!qNorm) return { code: '', matchedName: '', confidence: 0 };
    let exact = list.find(it => it.name === query);
    if (exact) return { code: exact.code, matchedName: exact.name, confidence: 1 };
    exact = list.find(it => normalize(it.name) === qNorm);
    if (exact) return { code: exact.code, matchedName: exact.name, confidence: 0.95 };
    let partial = list.find(it => normalize(it.name).includes(qNorm) || qNorm.includes(normalize(it.name)));
    if (partial) return { code: partial.code, matchedName: partial.name, confidence: 0.7 };
    const firstToken = query.split(/[ ,，]/)[0];
    if (firstToken && firstToken !== query) {
      const tokenNorm = normalize(firstToken);
      partial = list.find(it => normalize(it.name).includes(tokenNorm));
      if (partial) return { code: partial.code, matchedName: partial.name, confidence: 0.5 };
    }
    return { code: '', matchedName: '', confidence: 0 };
  };

  const applyCodeMapping = (records) => {
    if (!codeMaps) return records;
    return records.map(r => {
      const ownerMatch = findCode(codeMaps.발주자, r.owner);
      const dutyMatch = findCode(codeMaps.담당업무, r.duty);
      const positionMatch = findCode(codeMaps.직위, r.position);
      const constructionMatch = findCode(codeMaps.공사종류, r.constructionType);
      return {
        ...r,
        ownerCode: ownerMatch.code, ownerMatchedName: ownerMatch.matchedName, ownerConfidence: ownerMatch.confidence,
        dutyCode: dutyMatch.code, dutyMatchedName: dutyMatch.matchedName, dutyConfidence: dutyMatch.confidence,
        positionCode: positionMatch.code, positionMatchedName: positionMatch.matchedName, positionConfidence: positionMatch.confidence,
        constructionCode: constructionMatch.code, constructionMatchedName: constructionMatch.matchedName, constructionConfidence: constructionMatch.confidence,
      };
    });
  };

  // ==========  메인 변환 프로세스  ==========
  const runConversion = async () => {
    if (!pdfFile) { setError('PDF 파일을 먼저 업로드하세요.'); return; }
    if (!codeMaps) { setError('코드 테이블 엑셀 파일을 먼저 업로드하세요.'); return; }
    if (!pdfjsReady) { setError('PDF 라이브러리가 아직 준비되지 않았습니다.'); return; }

    cancelRef.current = false;
    setError(null); setLogs([]); setExtractedRecords([]); setResultFileBlob(null); setPageThumbnails([]);

    try {
      setStage('rendering');
      addLog('PDF 로딩 중...');
      const buf = await pdfFile.arrayBuffer();
      const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
      const totalPages = pdf.numPages;
      addLog(`PDF 로딩 완료: 총 ${totalPages}페이지`);

      // 1단계: 모든 페이지를 이미지로 렌더링
      const pageImages = [];
      const thumbs = [];
      for (let p = 1; p <= totalPages; p++) {
        if (cancelRef.current) { addLog('중단됨', 'error'); return; }
        setProgress({ current: p, total: totalPages, label: `페이지 이미지 렌더링 (${p}/${totalPages})` });
        try {
          const img = await renderPageToBase64(pdf, p, renderScale);
          pageImages.push({ page: p, ...img });
          // 썸네일도 생성 (작은 크기)
          if (p <= 10) {
            const thumb = await renderPageToBase64(pdf, p, 0.5);
            thumbs.push({ page: p, dataUrl: 'data:image/jpeg;base64,' + thumb.base64 });
          }
          addLog(`페이지 ${p} 이미지 생성: ${(img.base64.length / 1024).toFixed(0)}KB`);
        } catch (e) {
          addLog(`페이지 ${p} 렌더링 실패: ${e.message}`, 'error');
        }
      }
      setPageThumbnails(thumbs);

      // 2단계: Gemini Vision으로 페이지 묶음 단위 추출
      setStage('extracting');
      let allRecords = [];
      const failedBatches = []; // 실패한 청크 추적 (자동 재시도용)
      const totalCalls = Math.ceil(pageImages.length / pagesPerCall);
      for (let ci = 0; ci < totalCalls; ci++) {
        if (cancelRef.current) { addLog('중단됨', 'error'); break; }
        const startIdx = ci * pagesPerCall;
        const batch = pageImages.slice(startIdx, startIdx + pagesPerCall);
        const startPageNum = batch[0].page;
        const endPageNum = batch[batch.length - 1].page;
        setProgress({
          current: ci + 1, total: totalCalls,
          label: `Gemini Vision 추출 (${ci + 1}/${totalCalls}회 · 페이지 ${startPageNum}-${endPageNum})`
        });
        try {
          const t0 = performance.now();
          const records = await extractPagesWithClaude(batch, startPageNum);
          const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
          addLog(`페이지 ${startPageNum}-${endPageNum}: ${records.length}건 추출, ${elapsed}초`, 'success');
          allRecords.push(...records);
        } catch (e) {
          addLog(`페이지 ${startPageNum}-${endPageNum} 추출 실패: ${e.message}`, 'error');
          failedBatches.push({ batch, startPageNum, endPageNum });
        }
      }

      // 실패한 청크 자동 재시도 (1회) — 보통 503은 잠깐 후 풀림
      if (failedBatches.length > 0 && !cancelRef.current) {
        addLog(`실패한 ${failedBatches.length}개 청크를 30초 후 자동 재시도합니다...`, 'info');
        await new Promise(r => setTimeout(r, 30000));
        if (!cancelRef.current) {
          for (let i = 0; i < failedBatches.length; i++) {
            if (cancelRef.current) break;
            const { batch, startPageNum, endPageNum } = failedBatches[i];
            setProgress({
              current: i + 1, total: failedBatches.length,
              label: `실패 청크 재시도 (${i + 1}/${failedBatches.length} · 페이지 ${startPageNum}-${endPageNum})`
            });
            try {
              const records = await extractPagesWithClaude(batch, startPageNum);
              addLog(`재시도 성공 페이지 ${startPageNum}-${endPageNum}: ${records.length}건`, 'success');
              allRecords.push(...records);
            } catch (e) {
              addLog(`재시도 실패 페이지 ${startPageNum}-${endPageNum}: ${e.message}. 수동으로 다시 변환하세요.`, 'error');
            }
          }
        }
      }

      // 중복 제거 (페이지 경계 중복)
      const seen = new Set();
      allRecords = allRecords.filter(r => {
        const key = `${r.startDate}|${r.endDate}|${r.projectName}`;
        if (seen.has(key)) return false;
        seen.add(key); return true;
      });
      addLog(`총 ${allRecords.length}건 추출 (중복 제거 후)`, 'success');

      // 3단계: 코드 매핑
      setStage('mapping');
      setProgress({ current: 0, total: allRecords.length, label: '코드 매핑 중...' });
      const mapped = applyCodeMapping(allRecords);
      const mappedCount = mapped.filter(r => r.ownerCode || r.dutyCode || r.positionCode).length;
      addLog(`코드 매핑 완료: ${mappedCount}/${allRecords.length}건 자동 매칭`, 'success');

      setExtractedRecords(mapped);
      setStage('done');
      setProgress({ current: 0, total: 0, label: '' });
      const blob = generateExcelBlob(mapped);
      setResultFileBlob(blob);
      addLog('엑셀 파일 생성 완료. 다운로드 가능합니다.', 'success');
    } catch (e) {
      console.error(e);
      setError('변환 중 오류: ' + e.message);
      setStage('error');
      addLog('오류: ' + e.message, 'error');
    }
  };

  const cancelConversion = () => {
    cancelRef.current = true;
    addLog('중단 요청됨...', 'info');
  };

  // ==========  엑셀 생성  ==========
  const generateExcelBlob = (records) => {
    const XLSX = window.XLSX;
    const headers = [
      '착공일(yyyy-MM-dd)', '준공일(yyyy-MM-dd)', '인정일\n숫자만 입력해주세요',
      '참여사업명', '발주자\n발주자 코드값 사용 ex)00001', '공사개요',
      '공사종류\n구분 코드명 사용 ex)전차선로', '전문분야',
      '담당업무\n담당업무 코드값 사용 ex)00001', '직위\n직위 코드값 사용 ex)00001',
      '공사금액(단위,100만원)\n숫자만 입력해주세요', '비고'
    ];
    const rows = records.map(r => [
      r.startDate || '', r.endDate || '', r.days || '',
      r.projectName || '', r.ownerCode || '', r.overview || '',
      r.constructionCode || '', r.specialty || '',  // G열: 공사종류 코드값 (매칭 안 되면 빈칸)
      r.dutyCode || '', r.positionCode || '',
      r.amount || '', r.note || ''
    ]);
    const aoa = [
      ['모든 항목의 셀서식은 텍스트로 해주셔야 합니다.'],
      headers,
      ...rows
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const range = XLSX.utils.decode_range(ws['!ref']);
    for (let R = range.s.r; R <= range.e.r; ++R) {
      for (let C = range.s.c; C <= range.e.c; ++C) {
        const addr = XLSX.utils.encode_cell({ r: R, c: C });
        if (ws[addr]) { ws[addr].t = 's'; ws[addr].z = '@'; }
      }
    }
    ws['!cols'] = [
      { wch: 14 }, { wch: 14 }, { wch: 10 }, { wch: 35 }, { wch: 12 }, { wch: 30 },
      { wch: 18 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 20 }
    ];

    // 원본 코드 테이블 시트들을 그대로 가져와 복사
    let wb;
    if (excelBuffer) {
      try {
        wb = XLSX.read(excelBuffer, { type: 'array' });
        // 일괄등록 시트가 원본에 있다면 제거 후 새로 만든 시트로 대체
        const sheetsToKeep = ['근무처', '직위', '발주자', '담당업무', '공사종류'];
        const newWb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(newWb, ws, '일괄등록');
        for (const name of sheetsToKeep) {
          if (wb.Sheets[name]) {
            XLSX.utils.book_append_sheet(newWb, wb.Sheets[name], name);
          }
        }
        wb = newWb;
      } catch (e) {
        console.warn('코드 시트 복사 실패, 일괄등록 시트만 출력:', e);
        wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, '일괄등록');
      }
    } else {
      wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, '일괄등록');
    }

    const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    return new Blob([wbout], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  };

  const downloadExcel = () => {
    if (!resultFileBlob) return;
    const url = URL.createObjectURL(resultFileBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (pdfFile?.name?.replace(/\.pdf$/i, '') || '경력사항') + '_변환결과.xlsx';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const updateRecord = (idx, field, value) => {
    setExtractedRecords(prev => {
      const next = [...prev]; next[idx] = { ...next[idx], [field]: value }; return next;
    });
  };

  const remapRecord = (idx) => {
    setExtractedRecords(prev => {
      const next = [...prev]; const r = next[idx];
      const ownerMatch = findCode(codeMaps.발주자, r.owner);
      const dutyMatch = findCode(codeMaps.담당업무, r.duty);
      const positionMatch = findCode(codeMaps.직위, r.position);
      const constructionMatch = findCode(codeMaps.공사종류, r.constructionType);
      next[idx] = {
        ...r,
        ownerCode: ownerMatch.code, ownerMatchedName: ownerMatch.matchedName, ownerConfidence: ownerMatch.confidence,
        dutyCode: dutyMatch.code, dutyMatchedName: dutyMatch.matchedName, dutyConfidence: dutyMatch.confidence,
        positionCode: positionMatch.code, positionMatchedName: positionMatch.matchedName, positionConfidence: positionMatch.confidence,
        constructionCode: constructionMatch.code, constructionMatchedName: constructionMatch.matchedName, constructionConfidence: constructionMatch.confidence,
      };
      return next;
    });
  };

  const removeRecord = (idx) => setExtractedRecords(prev => prev.filter((_, i) => i !== idx));

  useEffect(() => {
    if (extractedRecords.length > 0 && stage === 'done' && window.XLSX) {
      setResultFileBlob(generateExcelBlob(extractedRecords));
    }
  }, [extractedRecords, stage]);

  const isProcessing = ['rendering', 'extracting', 'mapping'].includes(stage);
  const progressPct = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;
  const allReady = pdfjsReady && xlsxReady;

  return (
    <div className="min-h-screen bg-stone-50" style={{ fontFamily: "'Pretendard', -apple-system, BlinkMacSystemFont, system-ui, sans-serif" }}>
      <style>{`
        @import url('https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css');
        .number-tabular { font-variant-numeric: tabular-nums; }
        .scrollbar-thin::-webkit-scrollbar { width: 6px; height: 6px; }
        .scrollbar-thin::-webkit-scrollbar-track { background: transparent; }
        .scrollbar-thin::-webkit-scrollbar-thumb { background: #d6d3d1; border-radius: 3px; }
      `}</style>

      <header className="border-b border-stone-200 bg-white">
        <div className="max-w-6xl mx-auto px-6 py-5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-stone-900 flex items-center justify-center">
              <FileSpreadsheet className="w-5 h-5 text-white" strokeWidth={1.5} />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-stone-900 tracking-tight">경력증명서 PDF 일괄등록 변환기</h1>
              <p className="text-xs text-stone-500 mt-0.5">Google Gemini로 스캔 PDF 직접 분석 → 협회 양식 자동 변환</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 text-[10px]">
            <LibBadge ready={pdfjsReady} label="PDF.js" />
            <LibBadge ready={xlsxReady} label="SheetJS" />
            <LibBadge ready={true} label="Gemini" />
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-8">
        {/* API Key Section - Google Gemini API 키 입력 */}
        <section className="mb-6 bg-white border border-stone-200 rounded-xl p-4">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-lg bg-blue-50 flex items-center justify-center flex-shrink-0">
              <Key className="w-4 h-4 text-blue-600" strokeWidth={1.5} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-medium text-stone-900">Google Gemini API 키 <span className="text-emerald-600 text-[10px] font-normal ml-1">무료</span></h3>
                {apiKey && (
                  <button
                    onClick={() => { setApiKey(''); localStorage.removeItem('gemini_api_key'); }}
                    className="text-[10px] text-stone-400 hover:text-rose-600"
                  >저장된 키 삭제</button>
                )}
              </div>
              <div className="flex items-center gap-2 mb-2">
                <div className="flex-1 relative">
                  <input
                    type={showApiKey ? 'text' : 'password'}
                    value={apiKey}
                    onChange={e => {
                      setApiKey(e.target.value);
                      if (e.target.value) localStorage.setItem('gemini_api_key', e.target.value);
                    }}
                    placeholder="AIzaSy..."
                    className="w-full pl-3 pr-10 py-2 text-xs border border-stone-200 rounded-md font-mono focus:outline-none focus:border-blue-300"
                  />
                  <button
                    onClick={() => setShowApiKey(!showApiKey)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-stone-400 hover:text-stone-700"
                    type="button"
                  >
                    {showApiKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  </button>
                </div>
                <span className={`text-[10px] px-2 py-1 rounded ${apiKey ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
                  {apiKey ? '✓ 설정됨' : '필요'}
                </span>
              </div>
              {/* 모델 선택 */}
              <div className="flex items-center gap-2 mb-2">
                <span className="text-[11px] text-stone-600 font-medium min-w-[50px]">모델</span>
                <select
                  value={geminiModel}
                  onChange={e => { setGeminiModel(e.target.value); localStorage.setItem('gemini_model', e.target.value); }}
                  className="flex-1 text-xs border border-stone-200 rounded-md px-2 py-1.5 bg-white focus:outline-none focus:border-blue-300"
                >
                  <option value="gemini-2.5-flash-lite">Gemini 2.5 Flash-Lite — 무료 한도 가장 큼 (일 1,000회) · 가벼운 작업</option>
                  <option value="gemini-2.5-flash">Gemini 2.5 Flash — 균형 (일 250회) · 권장</option>
                  <option value="gemini-2.5-pro">Gemini 2.5 Pro — 가장 정확 (일 100회) · 흐릿한 PDF용</option>
                </select>
              </div>
              <p className="text-[11px] text-stone-500 mt-2 leading-relaxed">
                <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">aistudio.google.com</a>
                에서 무료로 API 키 발급 (신용카드 등록 불필요).
                키는 브라우저 localStorage에만 저장되며 외부로 전송되지 않습니다.
                Flash-Lite 기준 <strong className="text-stone-700">일일 1,000회 요청까지 무료</strong>이며, 한 달 50~500페이지 사용량은 충분히 무료 한도 안에서 처리됩니다.
              </p>
            </div>
          </div>
        </section>

        <section className="mb-6">
          <div className="flex items-center gap-3 mb-3">
            <div className={`w-7 h-7 rounded-full flex items-center justify-center text-sm font-medium ${codeMaps ? 'bg-emerald-100 text-emerald-700' : 'bg-stone-200 text-stone-700'}`}>
              {codeMaps ? <CheckCircle2 className="w-4 h-4" /> : '1'}
            </div>
            <h2 className="text-base font-semibold text-stone-900">코드 테이블 엑셀 업로드</h2>
            <span className="text-xs text-stone-500">건설기술인협회 "경력사항 일괄등록" 양식 파일</span>
          </div>
          <FileDropZone
            file={excelFile}
            onClick={() => excelInputRef.current?.click()}
            onClear={() => { setExcelFile(null); setCodeMaps(null); setExcelBuffer(null); }}
            icon={FileSpreadsheet}
            iconBg="bg-emerald-50"
            iconColor="text-emerald-600"
            placeholder="코드 테이블 엑셀 파일 선택"
            description="근무처/발주자/직위/담당업무/공사종류 시트 포함"
            meta={codeMaps && (
              <span className="number-tabular">
                근무처 {codeMaps.근무처.length} · 발주자 {codeMaps.발주자.length} · 직위 {codeMaps.직위.length} · 담당업무 {codeMaps.담당업무.length} · 공사종류 {codeMaps.공사종류.length}
              </span>
            )}
          />
          <input ref={excelInputRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={(e) => handleExcelUpload(e.target.files?.[0])} />
        </section>

        <section className="mb-6">
          <div className="flex items-center gap-3 mb-3">
            <div className={`w-7 h-7 rounded-full flex items-center justify-center text-sm font-medium ${pdfFile ? 'bg-emerald-100 text-emerald-700' : 'bg-stone-200 text-stone-700'}`}>
              {pdfFile ? <CheckCircle2 className="w-4 h-4" /> : '2'}
            </div>
            <h2 className="text-base font-semibold text-stone-900">경력증명서 PDF 업로드</h2>
            <span className="text-xs text-stone-500">스캔본도 Claude가 직접 인식</span>
          </div>
          <FileDropZone
            file={pdfFile}
            onClick={() => pdfInputRef.current?.click()}
            onClear={() => { setPdfFile(null); setExtractedRecords([]); setPageThumbnails([]); }}
            icon={FileText}
            iconBg="bg-rose-50"
            iconColor="text-rose-600"
            placeholder="PDF 파일 선택"
            description="건설기술인 경력증명서"
            meta={pdfFile && <span className="number-tabular">{(pdfFile.size / 1024 / 1024).toFixed(2)} MB</span>}
          />
          <input ref={pdfInputRef} type="file" accept=".pdf" className="hidden" onChange={(e) => handlePdfUpload(e.target.files?.[0])} />
        </section>

        <section className="mb-6 bg-white border border-stone-200 rounded-xl p-4">
          <h3 className="text-xs font-semibold text-stone-700 mb-3 uppercase tracking-wider flex items-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5 text-violet-500" />변환 옵션
          </h3>
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <ImageIcon className="w-3.5 h-3.5 text-stone-500" />
              <span className="text-sm text-stone-800 font-medium min-w-[100px]">렌더 해상도</span>
              <input type="range" min="1.5" max="3.0" step="0.5" value={renderScale} onChange={e => setRenderScale(parseFloat(e.target.value))} className="flex-1 max-w-[200px]" />
              <span className="text-xs text-stone-600 number-tabular">{renderScale}x</span>
              <span className="text-[10px] text-stone-400">{renderScale <= 1.5 ? '빠름' : renderScale <= 2.0 ? '권장' : '정확'}</span>
            </div>
            <div className="flex items-center gap-3">
              <FileText className="w-3.5 h-3.5 text-stone-500" />
              <span className="text-sm text-stone-800 font-medium min-w-[100px]">호출당 페이지</span>
              <input type="range" min="1" max="4" step="1" value={pagesPerCall} onChange={e => setPagesPerCall(parseInt(e.target.value))} className="flex-1 max-w-[200px]" />
              <span className="text-xs text-stone-600 number-tabular">{pagesPerCall}페이지</span>
              <span className="text-[10px] text-stone-400">{pagesPerCall === 1 ? '안정' : pagesPerCall <= 2 ? '권장' : '빠름·위험'}</span>
            </div>
            <p className="text-[11px] text-stone-500 leading-relaxed pl-6">
              Gemini는 OCR + 표 구조 분석을 한 번에 처리합니다. 페이지를 묶어 보내면 호출 횟수가 줄어 무료 한도를 효율적으로 사용할 수 있지만,
              너무 많이 묶으면 응답이 잘릴 수 있습니다 (3-4페이지 권장).
            </p>
          </div>
        </section>

        <section className="mb-6 flex gap-2">
          <button
            onClick={runConversion}
            disabled={!pdfFile || !codeMaps || !apiKey || isProcessing || !allReady}
            className="flex-1 bg-stone-900 text-white rounded-xl py-3.5 px-5 font-medium text-sm hover:bg-stone-800 disabled:bg-stone-300 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
          >
            {isProcessing ? (
              <><Loader2 className="w-4 h-4 animate-spin" />{progress.label || '처리 중...'}</>
            ) : (
              <>변환 시작<span className="text-xs opacity-60">PDF → Gemini → Excel</span></>
            )}
          </button>
          {isProcessing && (
            <button onClick={cancelConversion} className="px-4 py-3.5 bg-white border border-stone-200 rounded-xl text-sm text-stone-700 hover:bg-stone-50">중단</button>
          )}
        </section>

        {isProcessing && (
          <section className="mb-6 bg-white border border-stone-200 rounded-xl p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-stone-700 font-medium">{progress.label}</span>
              <span className="text-xs text-stone-500 number-tabular">
                {progress.total > 0 ? `${progress.current}/${progress.total}` : ''}{progressPct > 0 ? ` (${progressPct}%)` : ''}
              </span>
            </div>
            <div className="h-1.5 bg-stone-100 rounded-full overflow-hidden">
              <div className="h-full bg-stone-900 transition-all duration-300" style={{ width: `${progressPct}%` }} />
            </div>
          </section>
        )}

        {error && (
          <div className="mb-6 bg-rose-50 border border-rose-200 rounded-xl p-4 flex items-start gap-3">
            <AlertCircle className="w-4 h-4 text-rose-600 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm text-rose-900 font-medium">변환 오류</p>
              <p className="text-xs text-rose-700 mt-0.5 break-all">{error}</p>
            </div>
            <button onClick={() => setError(null)} className="text-rose-400 hover:text-rose-700"><X className="w-4 h-4" /></button>
          </div>
        )}

        {logs.length > 0 && (
          <section className="mb-6 bg-stone-900 rounded-xl p-4 max-h-56 overflow-y-auto scrollbar-thin">
            <p className="text-[11px] uppercase tracking-wider text-stone-400 mb-2 font-medium">진행 로그</p>
            <div className="space-y-1 font-mono text-[11px]">
              {logs.map((log, i) => (
                <div key={i} className="flex gap-2">
                  <span className="text-stone-500 number-tabular">{log.time}</span>
                  <span className={
                    log.type === 'success' ? 'text-emerald-400' :
                    log.type === 'error' ? 'text-rose-400' : 'text-stone-300'
                  }>{log.msg}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        {pageThumbnails.length > 0 && (
          <section className="mb-6">
            <h3 className="text-xs font-semibold text-stone-700 mb-2 uppercase tracking-wider">페이지 미리보기 (앞 10페이지)</h3>
            <div className="flex gap-2 overflow-x-auto scrollbar-thin pb-2">
              {pageThumbnails.map(t => (
                <div key={t.page} className="flex-shrink-0">
                  <img src={t.dataUrl} alt={`Page ${t.page}`} className="h-32 border border-stone-200 rounded shadow-sm" />
                  <div className="text-[10px] text-stone-500 text-center mt-1">p.{t.page}</div>
                </div>
              ))}
            </div>
          </section>
        )}

        {extractedRecords.length > 0 && (
          <section className="bg-white border border-stone-200 rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-stone-200 flex items-center justify-between bg-stone-50">
              <div>
                <h3 className="text-sm font-semibold text-stone-900">변환 결과</h3>
                <p className="text-xs text-stone-500 mt-0.5 number-tabular">
                  총 {extractedRecords.length}건 · 자동 매칭 {extractedRecords.filter(r => r.ownerCode || r.dutyCode || r.positionCode).length}건
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={downloadExcel} disabled={!resultFileBlob} className="px-4 py-1.5 text-xs bg-stone-900 text-white rounded-md hover:bg-stone-800 disabled:bg-stone-300 transition-colors flex items-center gap-1.5 font-medium">
                  <Download className="w-3 h-3" />엑셀 다운로드
                </button>
              </div>
            </div>

            <div className="overflow-x-auto scrollbar-thin">
              <table className="w-full text-xs">
                <thead className="bg-stone-50 border-b border-stone-200">
                  <tr className="text-stone-600">
                    <th className="px-3 py-2.5 text-left font-medium w-10">#</th>
                    <th className="px-3 py-2.5 text-left font-medium">기간</th>
                    <th className="px-3 py-2.5 text-left font-medium">사업명</th>
                    <th className="px-3 py-2.5 text-left font-medium">발주자</th>
                    <th className="px-3 py-2.5 text-left font-medium">공사종류</th>
                    <th className="px-3 py-2.5 text-left font-medium">담당업무</th>
                    <th className="px-3 py-2.5 text-left font-medium">직위</th>
                    <th className="px-3 py-2.5 text-right font-medium">금액</th>
                    <th className="px-3 py-2.5 text-center font-medium w-16">작업</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100">
                  {extractedRecords.map((r, idx) => (
                    <React.Fragment key={idx}>
                      <tr className="hover:bg-stone-50">
                        <td className="px-3 py-2.5 text-stone-400 number-tabular">{idx + 1}</td>
                        <td className="px-3 py-2.5 number-tabular text-stone-700 whitespace-nowrap">
                          <div>{r.startDate}</div>
                          <div className="text-stone-400">{r.endDate}</div>
                          {r.days && <div className="text-stone-400 text-[10px]">{r.days}일</div>}
                        </td>
                        <td className="px-3 py-2.5 max-w-xs">
                          <div className="text-stone-900 font-medium truncate" title={r.projectName}>{r.projectName || <span className="text-stone-300">―</span>}</div>
                          {r.overview && <div className="text-stone-500 text-[10px] truncate mt-0.5" title={r.overview}>{r.overview}</div>}
                        </td>
                        <td className="px-3 py-2.5"><CodeBadge code={r.ownerCode} name={r.ownerMatchedName || r.owner} confidence={r.ownerConfidence} fallback={r.owner} /></td>
                        <td className="px-3 py-2.5"><CodeBadge code={r.constructionCode} name={r.constructionMatchedName || r.constructionType} confidence={r.constructionConfidence} fallback={r.constructionType} showName /></td>
                        <td className="px-3 py-2.5"><CodeBadge code={r.dutyCode} name={r.dutyMatchedName || r.duty} confidence={r.dutyConfidence} fallback={r.duty} /></td>
                        <td className="px-3 py-2.5"><CodeBadge code={r.positionCode} name={r.positionMatchedName || r.position} confidence={r.positionConfidence} fallback={r.position} /></td>
                        <td className="px-3 py-2.5 text-right number-tabular text-stone-700">{r.amount || <span className="text-stone-300">―</span>}</td>
                        <td className="px-3 py-2.5 text-center">
                          <div className="flex items-center justify-center gap-1">
                            <button onClick={() => setEditingIdx(editingIdx === idx ? null : idx)} className="p-1 text-stone-400 hover:text-stone-700 rounded hover:bg-stone-100" title="편집">
                              {editingIdx === idx ? <ChevronUp className="w-3.5 h-3.5" /> : <Edit3 className="w-3.5 h-3.5" />}
                            </button>
                            <button onClick={() => removeRecord(idx)} className="p-1 text-stone-400 hover:text-rose-600 rounded hover:bg-stone-100" title="삭제">
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                      {editingIdx === idx && (
                        <tr className="bg-stone-50">
                          <td colSpan={9} className="px-5 py-4">
                            <RecordEditor record={r} codeMaps={codeMaps}
                              onChange={(field, value) => updateRecord(idx, field, value)}
                              onRemap={() => remapRecord(idx)} />
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <footer className="mt-8 text-xs text-stone-400 leading-relaxed">
          <p>
            PDF 페이지를 이미지로 변환한 후 Google Gemini API에 직접 전송하여 표 구조를 분석합니다.
            OCR 라이브러리보다 인식률이 높고 표 구조도 함께 이해하므로, 흐릿한 스캔 PDF에서도 좋은 결과를 얻습니다.
            Gemini 무료 등급은 분당 10-15회 / 일일 250-1,000회 요청을 제공하므로 일반적인 사용에는 비용이 발생하지 않습니다.
            처리 시간은 페이지당 약 3–8초이며, 노란색 표시 항목은 다운로드 전에 직접 검수하세요.
          </p>
        </footer>
      </main>
    </div>
  );
}

function LibBadge({ ready, label }) {
  return (
    <span className={`flex items-center gap-1 px-1.5 py-0.5 rounded ${ready ? 'bg-emerald-50 text-emerald-700' : 'bg-stone-100 text-stone-500'}`}>
      <span className={`w-1 h-1 rounded-full ${ready ? 'bg-emerald-500' : 'bg-stone-400'}`} />
      {label}
    </span>
  );
}

function FileDropZone({ file, onClick, onClear, icon: Icon, iconBg, iconColor, placeholder, description, meta }) {
  return (
    <div onClick={onClick} className="bg-white border border-stone-200 rounded-xl p-4 cursor-pointer hover:border-stone-300 transition-colors">
      {file ? (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`w-9 h-9 rounded-lg ${iconBg} flex items-center justify-center`}>
              <Icon className={`w-5 h-5 ${iconColor}`} strokeWidth={1.5} />
            </div>
            <div>
              <p className="text-sm font-medium text-stone-900">{file.name}</p>
              {meta && <p className="text-xs text-stone-500 mt-0.5">{meta}</p>}
            </div>
          </div>
          <button onClick={(e) => { e.stopPropagation(); onClear(); }} className="text-stone-400 hover:text-stone-700 p-1">
            <X className="w-4 h-4" />
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-stone-100 flex items-center justify-center">
            <Upload className="w-4 h-4 text-stone-500" strokeWidth={1.5} />
          </div>
          <div>
            <p className="text-sm text-stone-700">{placeholder}</p>
            <p className="text-xs text-stone-500 mt-0.5">{description}</p>
          </div>
        </div>
      )}
    </div>
  );
}

function CodeBadge({ code, name, confidence, fallback, showName }) {
  if (!code && !fallback) return <span className="text-stone-300">―</span>;
  if (!code) {
    return (
      <div className="inline-flex items-center gap-1.5">
        <span className="text-amber-700 text-[11px]">⚠ 미매칭</span>
        <span className="text-stone-600 text-[11px]" title={fallback}>{fallback}</span>
      </div>
    );
  }
  const conf = confidence || 0;
  const color = conf >= 0.95 ? 'emerald' : conf >= 0.7 ? 'sky' : 'amber';
  const colorClasses = {
    emerald: 'bg-emerald-50 text-emerald-700 border-emerald-100',
    sky: 'bg-sky-50 text-sky-700 border-sky-100',
    amber: 'bg-amber-50 text-amber-700 border-amber-100',
  };
  return (
    <div className="inline-flex flex-col gap-0.5">
      <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] number-tabular border ${colorClasses[color]}`}>
        {code}
      </span>
      {(showName || conf < 0.95) && (
        <span className="text-[10px] text-stone-500 truncate max-w-[120px]" title={name}>{name}</span>
      )}
    </div>
  );
}

function RecordEditor({ record, codeMaps, onChange, onRemap }) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="착공일">
          <input value={record.startDate || ''} onChange={e => onChange('startDate', e.target.value)} placeholder="YYYY-MM-DD" className="w-full px-2 py-1.5 text-xs border border-stone-200 rounded number-tabular" />
        </Field>
        <Field label="준공일">
          <input value={record.endDate || ''} onChange={e => onChange('endDate', e.target.value)} placeholder="YYYY-MM-DD" className="w-full px-2 py-1.5 text-xs border border-stone-200 rounded number-tabular" />
        </Field>
      </div>
      <Field label="사업명">
        <input value={record.projectName || ''} onChange={e => onChange('projectName', e.target.value)} className="w-full px-2 py-1.5 text-xs border border-stone-200 rounded" />
      </Field>
      <Field label="공사개요">
        <input value={record.overview || ''} onChange={e => onChange('overview', e.target.value)} className="w-full px-2 py-1.5 text-xs border border-stone-200 rounded" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="발주자 (이름)">
          <input value={record.owner || ''} onChange={e => onChange('owner', e.target.value)} className="w-full px-2 py-1.5 text-xs border border-stone-200 rounded" />
        </Field>
        <Field label="발주자 코드">
          <CodeSelect list={codeMaps.발주자} value={record.ownerCode}
            onChange={(code, name) => { onChange('ownerCode', code); onChange('ownerMatchedName', name); onChange('ownerConfidence', 1); }} />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="담당업무 (이름)">
          <input value={record.duty || ''} onChange={e => onChange('duty', e.target.value)} className="w-full px-2 py-1.5 text-xs border border-stone-200 rounded" />
        </Field>
        <Field label="담당업무 코드">
          <CodeSelect list={codeMaps.담당업무} value={record.dutyCode}
            onChange={(code, name) => { onChange('dutyCode', code); onChange('dutyMatchedName', name); onChange('dutyConfidence', 1); }} />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="직위 (이름)">
          <input value={record.position || ''} onChange={e => onChange('position', e.target.value)} className="w-full px-2 py-1.5 text-xs border border-stone-200 rounded" />
        </Field>
        <Field label="직위 코드">
          <CodeSelect list={codeMaps.직위} value={record.positionCode}
            onChange={(code, name) => { onChange('positionCode', code); onChange('positionMatchedName', name); onChange('positionConfidence', 1); }} />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="공사종류 (이름)">
          <input value={record.constructionType || ''} onChange={e => onChange('constructionType', e.target.value)} className="w-full px-2 py-1.5 text-xs border border-stone-200 rounded" />
        </Field>
        <Field label="공사종류 코드명">
          <CodeSelect list={codeMaps.공사종류} value={record.constructionCode}
            onChange={(code, name) => { onChange('constructionCode', code); onChange('constructionMatchedName', name); onChange('constructionConfidence', 1); }}
            useNameAsValue />
        </Field>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Field label="인정일(일)">
          <input value={record.days || ''} onChange={e => onChange('days', e.target.value)} className="w-full px-2 py-1.5 text-xs border border-stone-200 rounded number-tabular" />
        </Field>
        <Field label="공사금액(백만원)">
          <input value={record.amount || ''} onChange={e => onChange('amount', e.target.value)} className="w-full px-2 py-1.5 text-xs border border-stone-200 rounded number-tabular" />
        </Field>
        <Field label="전문분야">
          <input value={record.specialty || ''} onChange={e => onChange('specialty', e.target.value)} className="w-full px-2 py-1.5 text-xs border border-stone-200 rounded" />
        </Field>
      </div>
      <div className="flex justify-between items-center pt-2 border-t border-stone-200">
        <button onClick={onRemap} className="px-3 py-1.5 text-xs bg-white border border-stone-200 rounded-md hover:bg-stone-50 transition-colors flex items-center gap-1.5">
          <RefreshCw className="w-3 h-3" />이름 기반으로 코드 재매칭
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="block text-[10px] uppercase tracking-wider text-stone-500 mb-1 font-medium">{label}</span>
      {children}
    </label>
  );
}

function CodeSelect({ list, value, onChange, useNameAsValue }) {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const filtered = !search ? list.slice(0, 50) : list.filter(it => it.name.includes(search) || it.code.includes(search)).slice(0, 50);
  const selected = list.find(it => useNameAsValue ? it.name === value : it.code === value);
  return (
    <div className="relative">
      <div onClick={() => setOpen(!open)} className="w-full px-2 py-1.5 text-xs border border-stone-200 rounded cursor-pointer flex items-center justify-between bg-white hover:bg-stone-50">
        <span className={selected ? 'text-stone-900' : 'text-stone-400'}>
          {selected ? `${selected.code} · ${selected.name}` : '선택 안됨'}
        </span>
        <ChevronDown className="w-3 h-3 text-stone-400" />
      </div>
      {open && (
        <div className="absolute z-10 mt-1 w-full bg-white border border-stone-200 rounded-md shadow-lg max-h-64 overflow-hidden flex flex-col">
          <input autoFocus placeholder="검색..." value={search} onChange={e => setSearch(e.target.value)}
            className="px-2 py-1.5 text-xs border-b border-stone-200 focus:outline-none" />
          <div className="overflow-y-auto scrollbar-thin">
            <div onClick={() => { onChange('', ''); setOpen(false); setSearch(''); }} className="px-2 py-1.5 text-xs hover:bg-stone-100 cursor-pointer text-stone-500">― 선택 안함 ―</div>
            {filtered.map(it => (
              <div key={it.code} onClick={() => { onChange(useNameAsValue ? it.name : it.code, it.name); setOpen(false); setSearch(''); }}
                className="px-2 py-1.5 text-xs hover:bg-stone-100 cursor-pointer flex justify-between gap-2">
                <span className="text-stone-500 number-tabular">{it.code}</span>
                <span className="text-stone-900 truncate flex-1">{it.name}</span>
              </div>
            ))}
            {filtered.length === 0 && <div className="px-2 py-3 text-xs text-stone-400 text-center">검색 결과 없음</div>}
          </div>
        </div>
      )}
    </div>
  );
}
