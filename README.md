# 경력증명서 PDF → 엑셀 일괄등록 변환기

한국건설기술인협회 경력증명서 PDF(스캔본 포함)를 자동 인식하여 협회 일괄등록 엑셀 양식으로 변환하는 웹앱입니다.

## 주요 기능

- 스캔 PDF도 Google Gemini Vision으로 직접 인식 (별도 OCR 불필요)
- 발주자/직위/담당업무/공사종류 코드 자동 매핑
- 변환 결과 미리보기 및 수동 편집
- 원본 코드 시트가 포함된 엑셀 파일 출력
- 모든 처리는 브라우저에서 실행 (PDF는 외부 서버에 저장되지 않음)
- **Google Gemini 무료 등급으로 대부분 무료 사용 가능**

## 비용

| 모델 | 일일 무료 한도 | 분당 한도 | 추천 사용 |
|---|---|---|---|
| Gemini 2.5 Flash-Lite | 1,000회 | 15회 | 일반 사용 |
| Gemini 2.5 Flash | 250회 | 10회 | 균형(권장) |
| Gemini 2.5 Pro | 100회 | 5회 | 흐릿한 PDF |

신용카드 등록 없이 무료 사용 가능. 한 달 50~500페이지 사용량은 무료 한도 안에서 충분히 처리됩니다.

## 로컬 실행

```bash
npm install
npm run dev
```

브라우저에서 `http://localhost:5173` 접속.

## GitHub Pages 배포 방법

### 1단계: GitHub 저장소 만들기

1. GitHub.com 로그인 → 우측 상단 `+` → `New repository`
2. 저장소 이름 입력 (예: `pdf-converter`)
3. Public으로 설정 (Private이면 GitHub Pages 무료 플랜에서 사용 불가)
4. `Create repository`

### 2단계: 코드 업로드 (드래그&드롭)

1. 만든 저장소 페이지에서 `uploading an existing file` 링크 클릭
2. `pdf-converter-app` 폴더 안의 모든 파일과 폴더를 드래그
   - `.github`, `.gitignore` 같은 점으로 시작하는 항목도 포함
   - `node_modules`, `dist`는 제외 (있다면)
3. 하단 `Commit changes` 클릭

### 3단계: GitHub Pages 활성화

1. 저장소 페이지에서 `Settings` 탭
2. 좌측 메뉴 `Pages`
3. `Build and deployment` 섹션의 `Source`를 **GitHub Actions** 로 변경

### 4단계: 자동 배포 확인

1. `Actions` 탭에서 워크플로우 진행 상황 확인 (1-2분)
2. 초록색 체크 표시가 뜨면 배포 완료
3. URL: `https://YOUR_USERNAME.github.io/pdf-converter/`

## 사용 방법

1. 배포된 URL에 접속
2. **Google Gemini API 키 입력**
   - [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey) 접속
   - 구글 계정으로 로그인
   - **Create API key** 클릭
   - `AIzaSy...` 로 시작하는 키 복사
3. 코드 테이블 엑셀 업로드 (협회 일괄등록 양식)
4. 변환할 경력증명서 PDF 업로드
5. 변환 옵션 조정 (해상도, 호출당 페이지)
6. **변환 시작** 클릭
7. 결과 확인 후 **엑셀 다운로드**

## 무료 한도 초과 시

분당 한도 초과: 잠시 후 다시 시도
일일 한도 초과: 다음날 자정(태평양 시간) 이후 리셋, 또는 다른 모델로 변경

## 보안 안내

- API 키는 브라우저 localStorage에만 저장되며 서버로 전송되지 않습니다
- PDF 파일은 Google Gemini API로만 전송되고 다른 곳에 저장되지 않습니다
- 무료 등급 사용 시 Google이 입력 데이터를 모델 개선에 사용할 수 있습니다 (Google 약관 참조)
- 민감한 데이터를 다룰 경우 유료 등급 또는 별도 백엔드 구축 권장

## 기술 스택

- React 18 + Vite
- Tailwind CSS (CDN)
- PDF.js (PDF 페이지 렌더링)
- SheetJS (엑셀 생성)
- Google Gemini API (Vision)
