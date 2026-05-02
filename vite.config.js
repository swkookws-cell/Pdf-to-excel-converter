import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// GitHub Pages에 배포할 때는 base를 저장소 이름으로 설정해야 합니다.
// 예: https://username.github.io/pdf-converter/  →  base: '/pdf-converter/'
// Vercel/Netlify 등 루트 도메인에 배포할 때는 base: '/' 로 두세요.
export default defineConfig({
  plugins: [react()],
  base: './',  // 상대 경로 사용 (어느 환경에서든 동작)
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
})
