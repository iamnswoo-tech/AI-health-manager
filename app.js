// ════════════════════════════════════════════════════════════════════
// 건강 측정 v11.0 — 얼굴 rPPG 메인 앱
// 알고리즘: POS (Wang et al. 2017, IEEE TBME) + 다중 ROI
// ════════════════════════════════════════════════════════════════════

// === 화면 콘솔 (스마트폰 진단용) ===
const Console = {
  buffers: { face: [], body: [] },
  origLog: console.log.bind(console),
  origWarn: console.warn.bind(console),
  origError: console.error.bind(console),
  init() {
    console.log = (...args) => { this.origLog(...args); this._append('face', 'log', args); };
    console.warn = (...args) => { this.origWarn(...args); this._append('face', 'warn', args); };
    console.error = (...args) => { this.origError(...args); this._append('face', 'error', args); };
    console.log('[Console] v11.0 화면 콘솔 활성화');
    console.log('[Console] UA:', navigator.userAgent.substring(0, 60));
  },
  _append(target, type, args) {
    const time = new Date().toTimeString().substring(0, 8);
    const text = args.map(a => {
      try {
        if (typeof a === 'object') return JSON.stringify(a);
        return String(a);
      } catch (e) { return '<obj>'; }
    }).join(' ');
    const buf = this.buffers[target] || this.buffers.face;
    buf.push({ time, type, text });
    if (buf.length > 200) buf.shift();
    this._render(target);
  },
  _render(target) {
    const el = document.getElementById(target + '-console');
    if (!el) return;
    const buf = this.buffers[target] || [];
    el.innerHTML = buf.map(item => {
      const color = item.type === 'warn' ? '#fbbf24' : item.type === 'error' ? '#ef4444' : '#86efac';
      return `<div style="color:${color}"><span style="color:#64748b">${item.time}</span> ${this._escape(item.text)}</div>`;
    }).join('');
    el.scrollTop = el.scrollHeight;
  },
  _escape(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
  clear(target) {
    if (this.buffers[target]) this.buffers[target].length = 0;
    this._render(target);
  }
};

// ════════════════════════════════════════════════════════════════════
// App — 메인 앱 객체
// ════════════════════════════════════════════════════════════════════
const App = {
  state: {
    page: 'home',
    face: {
      running: false,
      stream: null,
      track: null,
      cameraReady: false,
      measureStartMs: 0,
      timerInterval: null,
      rafId: null,
      samples: [],   // {r,g,b,t} from face ROI
      fps: 0, fpsCounter: 0, fpsLastT: 0,
      autoFinalized: false,
      lastHR: null,
      faceDetected: false,
    }
  },

  config: {
    face: {
      durationSec: 30,
      targetSR: 30,
      bufferSec: 35,
      minWarmupSec: 5,
      waveWindowSec: 8,
    }
  },

  // ─── 초기화 ───
  init() {
    Console.init();
    console.log('[App v11.0] 초기화');
    this._setupCanvas();
    this._bindFaceButton();
    this._bindVisibilityHandler();
    window.addEventListener('beforeunload', () => this._cleanupAll());
  },

  // ─── 페이지 전환 ───
  goPage(page) {
    // 측정 중에는 페이지 이동 시 정지
    if (this.state.face.running && page !== 'face') {
      console.log('[App] 페이지 이동 — 얼굴 측정 정지');
      this.faceStop();
    }
    document.querySelectorAll('.page').forEach(p => p.classList.remove('on'));
    document.getElementById('page-' + page).classList.add('on');
    document.querySelectorAll('.nav-btn').forEach(n => n.classList.remove('on'));
    document.getElementById('nav-' + page)?.classList.add('on');
    this.state.page = page;
    window.scrollTo(0, 0);
  },

  clearConsole(target) { Console.clear(target); },

  // ════════════════════════════════════════════════════════════════
  // 얼굴 측정 (POS 알고리즘)
  // ════════════════════════════════════════════════════════════════

  _bindFaceButton() {
    const btn = document.getElementById('face-btn');
    if (btn) {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        if (this.state.face.running) this.faceStop();
        else this.faceStart();
      });
    }
  },

  async faceStart() {
    console.log('[Face] 측정 시작');
    try {
      // 1. 얼굴 카메라 (전면) 획득
      await this._faceAcquireCamera();

      // 2. 상태 초기화
      const f = this.state.face;
      f.running = true;
      f.measureStartMs = performance.now();
      f.samples = [];
      f.fpsCounter = 0;
      f.fpsLastT = performance.now();
      f.autoFinalized = false;
      f.lastHR = null;
      f.faceDetected = false;

      // 3. UI 변경
      document.getElementById('face-btn').classList.add('stop');
      document.getElementById('face-btn-text').textContent = '측정 중지';
      document.getElementById('face-chip-fps').querySelector('.chip-dot').classList.add('live');
      document.getElementById('face-chip-fps').querySelector('.chip-dot').classList.remove('off');
      document.getElementById('face-chip-roi').style.display = 'flex';
      document.getElementById('face-cam-msg').textContent = '얼굴 검출 중...';
      document.getElementById('face-cam-sub').textContent = '얼굴을 화면 가운데에 맞춰주세요';
      document.getElementById('face-result-panel').classList.remove('show');

      // 4. 타이머 + 프레임 루프
      this._faceStartTimer();
      this._faceProcessFrame();

      console.log('[Face] 시작 완료');
    } catch (err) {
      console.error('[Face] 시작 실패:', err);
      alert('측정 시작 실패: ' + (err.message || err));
      await this.faceStop();
    }
  },

  async faceStop() {
    console.log('[Face] 측정 중지');
    const f = this.state.face;
    f.running = false;

    if (f.timerInterval) { clearInterval(f.timerInterval); f.timerInterval = null; }
    if (f.rafId) { cancelAnimationFrame(f.rafId); f.rafId = null; }

    // 카메라 정리 (얼굴 모드는 페이지 떠날 때만 완전 정리, 측정 끝은 유지)
    try {
      if (f.stream) {
        f.stream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} });
        f.stream = null;
      }
    } catch (e) {}
    f.track = null;
    try { document.getElementById('face-video').srcObject = null; } catch (e) {}

    // UI 복원
    document.getElementById('face-btn').classList.remove('stop');
    document.getElementById('face-btn-text').textContent = '▶ 측정 시작';
    document.getElementById('face-chip-fps').querySelector('.chip-dot').classList.remove('live');
    document.getElementById('face-chip-fps').querySelector('.chip-dot').classList.add('off');
    document.getElementById('face-chip-fps-text').textContent = '대기';
    document.getElementById('face-chip-timer').style.display = 'none';
    document.getElementById('face-chip-roi').style.display = 'none';
    document.getElementById('face-progress-fill').style.width = '0%';
    document.getElementById('face-sqi-fill').style.width = '0%';
    document.getElementById('face-sqi-pct').textContent = '0%';
    document.getElementById('face-sqi-msg').textContent = '측정 중지됨';
    document.getElementById('face-cam-msg').textContent = '측정 시작 버튼을 눌러주세요';
    document.getElementById('face-cam-sub').textContent = '얼굴을 화면 가운데에 맞춰주세요';
  },

  async _faceAcquireCamera() {
    const attempts = [
      { video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } } },
      { video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } } },
      { video: { facingMode: 'user' } },
      { video: true },
    ];
    let lastErr = null;
    for (const c of attempts) {
      try {
        console.log('[Face Camera] 시도:', JSON.stringify(c.video));
        const stream = await navigator.mediaDevices.getUserMedia(c);
        const track = stream.getVideoTracks()[0];
        const settings = track.getSettings ? track.getSettings() : {};
        console.log('[Face Camera] 획득:', settings.width + 'x' + settings.height,
                    'facingMode:', settings.facingMode || 'unknown');

        this.state.face.stream = stream;
        this.state.face.track = track;
        const video = document.getElementById('face-video');
        video.srcObject = stream;
        video.classList.add('cam-front');
        await new Promise((res, rej) => {
          video.onloadedmetadata = () => res();
          setTimeout(() => rej(new Error('타임아웃')), 5000);
        });
        await video.play();
        await new Promise(r => setTimeout(r, 300)); // 안정화
        console.log('[Face Camera] ✅ 획득 성공');
        return;
      } catch (err) {
        console.warn('[Face Camera] 시도 실패:', err.message);
        lastErr = err;
      }
    }
    throw lastErr || new Error('카메라 사용 불가');
  },

  // ─── 타이머 ───
  _faceStartTimer() {
    document.getElementById('face-chip-timer').style.display = 'flex';
    this._faceTickTimer();
    if (this.state.face.timerInterval) clearInterval(this.state.face.timerInterval);
    this.state.face.timerInterval = setInterval(() => this._faceTickTimer(), 250);
  },

  _faceTickTimer() {
    const f = this.state.face;
    if (!f.running) return;
    const elapsed = (performance.now() - f.measureStartMs) / 1000;
    const total = this.config.face.durationSec;
    const remain = Math.max(0, total - elapsed);

    const pct = Math.min(100, (elapsed / total) * 100);
    document.getElementById('face-progress-fill').style.width = pct + '%';

    const chip = document.getElementById('face-chip-timer');
    const text = document.getElementById('face-chip-timer-text');
    chip.classList.remove('urgent', 'done');
    if (remain > 0) {
      text.textContent = Math.ceil(remain) + '초 남음';
      if (remain <= 10) chip.classList.add('urgent');
    } else {
      text.textContent = '✅ 측정 완료';
      chip.classList.add('done');
      if (!f.autoFinalized) {
        f.autoFinalized = true;
        console.log('[Face] 30초 도달 — 자동 완료');
        this._faceFinalize();
      }
    }
  },

  // ─── 프레임 루프 ───
  _faceProcessFrame() {
    const f = this.state.face;
    if (!f.running) return;

    const video = document.getElementById('face-video');
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) {
      f.rafId = requestAnimationFrame(() => this._faceProcessFrame());
      return;
    }

    // FPS 측정
    f.fpsCounter++;
    const now = performance.now();
    if (now - f.fpsLastT >= 1000) {
      f.fps = f.fpsCounter;
      f.fpsCounter = 0;
      f.fpsLastT = now;
      document.getElementById('face-chip-fps-text').textContent = f.fps + ' fps';
    }

    this._faceExtractROI(video, vw, vh);

    f.rafId = requestAnimationFrame(() => this._faceProcessFrame());
  },

  // ─── 다중 ROI 추출 (Anura 스타일) ───
  _faceExtractROI(video, vw, vh) {
    const cv = this._cv;
    cv.width = vw; cv.height = vh;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, vw, vh);

    // 단순 얼굴 영역 추정 (화면 중앙)
    const faceCx = vw / 2;
    const faceCy = vh * 0.45; // 얼굴은 화면 중앙보다 살짝 위
    const faceW = vw * 0.5;
    const faceH = vh * 0.55;

    // 3개 ROI: 이마, 좌볼, 우볼
    const rois = [
      { name: 'forehead', x: faceCx - faceW*0.18, y: faceCy - faceH*0.35, w: faceW*0.35, h: faceH*0.15, weight: 0.5 },
      { name: 'left_cheek', x: faceCx - faceW*0.35, y: faceCy + faceH*0.05, w: faceW*0.20, h: faceH*0.18, weight: 0.25 },
      { name: 'right_cheek', x: faceCx + faceW*0.15, y: faceCy + faceH*0.05, w: faceW*0.20, h: faceH*0.18, weight: 0.25 },
    ];

    let totalR = 0, totalG = 0, totalB = 0, totalW = 0;
    let validROIs = 0;
    let skinPixelCount = 0;
    let totalPixelCount = 0;

    for (const roi of rois) {
      const x = Math.max(0, Math.floor(roi.x));
      const y = Math.max(0, Math.floor(roi.y));
      const w = Math.min(vw - x, Math.floor(roi.w));
      const h = Math.min(vh - y, Math.floor(roi.h));
      if (w < 10 || h < 10) continue;

      const data = ctx.getImageData(x, y, w, h).data;
      let r = 0, g = 0, b = 0, n = 0;
      // 피부색 마스킹: R > G > B and R > 60 (밝은 피부)
      for (let i = 0; i < data.length; i += 4) {
        const cr = data[i], cg = data[i+1], cb = data[i+2];
        totalPixelCount++;
        // 단순 피부색 판정
        if (cr > 60 && cr > cg && cg > cb && cr - cb > 15 && cr < 250) {
          r += cr; g += cg; b += cb; n++;
          skinPixelCount++;
        }
      }
      if (n > w * h * 0.2) { // ROI의 20% 이상이 피부색이어야 유효
        r /= n; g /= n; b /= n;
        totalR += r * roi.weight;
        totalG += g * roi.weight;
        totalB += b * roi.weight;
        totalW += roi.weight;
        validROIs++;
      }
    }

    const skinRatio = totalPixelCount > 0 ? skinPixelCount / totalPixelCount : 0;

    if (validROIs >= 2 && totalW > 0) {
      // 가중 평균
      const r = totalR / totalW;
      const g = totalG / totalW;
      const b = totalB / totalW;
      const t = performance.now();
      this.state.face.samples.push({ r, g, b, t });

      const maxS = this.config.face.bufferSec * this.config.face.targetSR * 2;
      if (this.state.face.samples.length > maxS) {
        this.state.face.samples.splice(0, this.state.face.samples.length - maxS);
      }

      this.state.face.faceDetected = true;
      document.getElementById('face-chip-roi-text').textContent = `ROI ${validROIs}/3`;
      this._faceUpdateStatus(skinRatio, true);
      this._faceDrawWaveform();
      // 일정 시간 데이터 모이면 실시간 HR 추정
      const elapsed = (performance.now() - this.state.face.measureStartMs) / 1000;
      if (elapsed > this.config.face.minWarmupSec) {
        this._faceEstimateHR();
      }
    } else {
      this.state.face.faceDetected = false;
      document.getElementById('face-chip-roi-text').textContent = `ROI ${validROIs}/3`;
      this._faceUpdateStatus(skinRatio, false);
    }
  },

  _faceUpdateStatus(skinRatio, faceFound) {
    if (!faceFound) {
      this._faceSetSqi(0, 'var(--danger)', '🚫 얼굴이 감지되지 않습니다');
      document.getElementById('face-cam-msg').textContent = '얼굴이 감지되지 않습니다';
      document.getElementById('face-cam-sub').textContent = '얼굴을 화면 가운데에 맞추고 가만히 유지';
      return;
    }
    // skinRatio: 화면 전체 중 피부색 비율
    if (skinRatio < 0.05) {
      this._faceSetSqi(20, 'var(--warn)', '⚠️ 얼굴이 너무 멀거나 작습니다');
      document.getElementById('face-cam-msg').textContent = '얼굴을 더 가까이 해주세요';
      return;
    }
    const sqi = Math.min(95, Math.round(40 + skinRatio * 200));
    this._faceSetSqi(sqi, 'var(--green)', `✅ 측정 중 (${sqi}%)`);
    document.getElementById('face-cam-msg').textContent = '✅ 얼굴 검출됨';
    document.getElementById('face-cam-sub').textContent = `움직이지 마세요 · 신뢰도 ${sqi}%`;
  },

  _faceSetSqi(val, color, msg) {
    document.getElementById('face-sqi-fill').style.width = val + '%';
    document.getElementById('face-sqi-fill').style.background = color;
    document.getElementById('face-sqi-pct').textContent = val + '%';
    document.getElementById('face-sqi-msg').textContent = msg;
  },

  // ─── 실시간 HR 추정 ───
  _faceEstimateHR() {
    const f = this.state.face;
    const sr = this.config.face.targetSR;
    if (f.samples.length < sr * this.config.face.minWarmupSec) return;

    // 최근 12초 윈도우
    const win = Math.min(sr * 12, f.samples.length);
    const recent = f.samples.slice(-win);

    // POS 신호 생성
    const reds = recent.map(s => s.r);
    const greens = recent.map(s => s.g);
    const blues = recent.map(s => s.b);
    const pos = this._posAlgorithm(reds, greens, blues);

    // BPF + Goertzel
    const detrended = this._detrend(pos);
    const filtered = this._bandpass(detrended, sr, 0.7, 3.0);
    const stdF = this._stdDev(filtered);
    if (stdF < 0.001) return;

    const { freq: hrHz, snr } = this._goertzelPeak(filtered, sr, 45/60, 180/60);
    if (!hrHz || snr < 2.5) return;

    const hr = Math.round(hrHz * 60);
    if (hr < 45 || hr > 180 || hr === 45 || hr === 180) return;

    f.lastHR = hr;
    document.getElementById('fr-hr-val').textContent = hr;
  },

  // ─── POS 알고리즘 (Wang et al. 2017) ───
  // s = X · proj_matrix, X = [R; G; B] (normalized by mean)
  _posAlgorithm(R, G, B) {
    const N = R.length;
    if (N < 10) return new Array(N).fill(0);

    // 평균 정규화
    const meanR = R.reduce((a,b)=>a+b,0) / N;
    const meanG = G.reduce((a,b)=>a+b,0) / N;
    const meanB = B.reduce((a,b)=>a+b,0) / N;
    if (meanR < 1 || meanG < 1 || meanB < 1) return new Array(N).fill(0);

    const normR = R.map(v => v / meanR - 1);
    const normG = G.map(v => v / meanG - 1);
    const normB = B.map(v => v / meanB - 1);

    // POS 투영: X1 = G - B, X2 = G + B - 2R (Wang et al. 2017)
    const X1 = new Array(N), X2 = new Array(N);
    for (let i = 0; i < N; i++) {
      X1[i] = normG[i] - normB[i];
      X2[i] = normG[i] + normB[i] - 2 * normR[i];
    }

    // alpha = std(X1) / std(X2)
    const stdX1 = this._stdDev(X1);
    const stdX2 = this._stdDev(X2);
    const alpha = stdX2 > 1e-9 ? stdX1 / stdX2 : 0;

    // s = X1 + alpha * X2
    const s = new Array(N);
    for (let i = 0; i < N; i++) {
      s[i] = X1[i] + alpha * X2[i];
    }
    return s;
  },

  // ─── 측정 완료 ───
  _faceFinalize() {
    console.log('[Face] _faceFinalize()');
    const result = this._faceComputeMetrics();
    console.log('[Face] 결과:', result);

    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);

    if (result.hr) {
      this._faceDisplayResults(result);
      document.getElementById('face-cam-msg').textContent = '✅ 측정 완료';
      document.getElementById('face-cam-sub').textContent = '결과 패널을 확인하세요';
    } else {
      const reasons = {
        'no_face': '얼굴이 충분히 검출되지 않았습니다.\n조명을 밝게 하고 얼굴을 카메라에 가깝게 해주세요.',
        'low_snr': 'rPPG 신호 품질이 낮습니다.\n움직이지 말고 다시 측정해주세요.',
        'boundary_artifact': '심박수가 범위 경계에 박혀있습니다 (가짜 결과).',
        'out_of_range': '심박수가 정상 범위를 벗어났습니다.',
        'insufficient_data': '데이터가 부족합니다.',
      };
      const msg = reasons[result.reason] || '측정에 실패했습니다.';
      document.getElementById('face-cam-msg').textContent = '⚠️ 측정 실패';
      document.getElementById('face-cam-sub').textContent = '아래 안내 확인';
      setTimeout(() => alert('측정 실패\n\n' + msg), 800);
    }

    setTimeout(() => this.faceStop(), 2000);
  },

  _faceComputeMetrics() {
    const f = this.state.face;
    const sr = this.config.face.targetSR;
    const samples = f.samples;
    if (samples.length < sr * 10) return { hr: null, reason: 'insufficient_data' };

    // 데이터 품질
    if (!f.faceDetected || samples.length < sr * 15) {
      return { hr: null, reason: 'no_face' };
    }

    // 마지막 25초만 사용
    const winN = Math.min(sr * 25, samples.length);
    const recent = samples.slice(-winN);
    const reds = recent.map(s => s.r);
    const greens = recent.map(s => s.g);
    const blues = recent.map(s => s.b);

    // POS 알고리즘
    const pos = this._posAlgorithm(reds, greens, blues);
    console.log('[Face] POS std:', this._stdDev(pos).toFixed(4));

    const detrended = this._detrend(pos);
    const filtered = this._bandpass(detrended, sr, 0.7, 3.0);
    const sigStd = this._stdDev(filtered);
    console.log('[Face] filtered std:', sigStd.toFixed(4));

    const { freq: hrHz, snr } = this._goertzelPeak(filtered, sr, 45/60, 180/60);
    console.log('[Face] Goertzel:', hrHz.toFixed(2), 'Hz =', Math.round(hrHz*60), 'bpm, SNR:', snr.toFixed(2));

    if (!hrHz || snr < 2.5) {
      return { hr: null, reason: 'low_snr' };
    }
    const hr = Math.round(hrHz * 60);
    if (hr === 45 || hr === 180) return { hr: null, reason: 'boundary_artifact' };
    if (hr < 45 || hr > 180) return { hr: null, reason: 'out_of_range' };

    // === 호흡수 (PPG envelope 또는 직접 BPF) ===
    let respRate = null;
    if (samples.length >= sr * 20) {
      const respFiltered = this._bandpass(pos, sr, 0.16, 0.5);
      const respStd = this._stdDev(respFiltered);
      console.log('[Face] resp std:', respStd.toFixed(4));
      if (respStd > 0.001) {
        const rp = this._goertzelPeak(respFiltered, sr, 11/60, 25/60);
        console.log('[Face] resp Goertzel:', rp.freq.toFixed(3), 'Hz, SNR:', rp.snr.toFixed(2));
        if (rp.snr >= 1.8 && rp.freq > 0) {
          const rpm = Math.round(rp.freq * 60);
          if (rpm > 11 && rpm < 25) respRate = rpm;
        }
      }
    }
    // HR 기반 폴백
    if (!respRate && hr) {
      const est = Math.round(hr / 4);
      if (est >= 12 && est <= 22) respRate = est;
    }

    // === 피크 검출 + HRV ===
    const expectedRRms = 60000 / hr;
    const expectedPeaks = Math.round((winN / sr) * hrHz);
    console.log('[Face] expected peaks:', expectedPeaks, ', RR:', expectedRRms.toFixed(0), 'ms');

    const hrLoHz = Math.max(0.7, hrHz - 0.4);
    const hrHiHz = Math.min(4.0, hrHz + 0.6);
    const narrowFiltered = this._bandpass(detrended, sr, hrLoHz, hrHiHz);
    let peaks = this._detectPeaks(narrowFiltered, sr, hrHz);
    console.log('[Face] narrow band peaks:', peaks.length);

    if (peaks.length < expectedPeaks * 0.7) {
      const p2 = this._detectPeaks(filtered, sr, hrHz);
      if (p2.length > peaks.length) peaks = p2;
    }
    if (peaks.length < expectedPeaks * 0.6) {
      const p3 = this._detectPeaks(detrended, sr, hrHz);
      if (p3.length > peaks.length) peaks = p3;
    }
    console.log('[Face] 최종 피크:', peaks.length, '/', expectedPeaks,
                '=', Math.round(peaks.length / expectedPeaks * 100) + '%');

    // RR 간격 + 보간
    const rrIntervals = [];
    let directCount = 0, interpolatedCount = 0;
    for (let i = 1; i < peaks.length; i++) {
      const ms = (peaks[i] - peaks[i-1]) / sr * 1000;
      const minRR = expectedRRms * 0.5;
      const maxRR = expectedRRms * 1.5;
      if (ms >= minRR && ms <= maxRR) {
        rrIntervals.push(ms);
        directCount++;
      } else if (ms > maxRR && ms < maxRR * 2.5) {
        const numMissed = Math.round(ms / expectedRRms);
        if (numMissed >= 2 && numMissed <= 4) {
          const interp = ms / numMissed;
          for (let k = 0; k < numMissed; k++) {
            rrIntervals.push(interp);
            interpolatedCount++;
          }
        }
      }
    }
    const totalRR = directCount + interpolatedCount;
    const interpRatio = totalRR > 0 ? interpolatedCount / totalRR : 0;
    console.log('[Face] RR: 직접', directCount, '+ 보간', interpolatedCount,
                '(보간율:', (interpRatio*100).toFixed(0) + '%)');

    // RMSSD
    let rmssd = null;
    if (interpRatio > 0.7) {
      console.warn('[Face] 보간율 너무 높음 — RMSSD 무효');
    } else if (rrIntervals.length >= 4) {
      const mean = rrIntervals.reduce((a,b)=>a+b,0) / rrIntervals.length;
      const cleanRR = rrIntervals.filter(rr => Math.abs(rr - mean) < mean * 0.5);
      let sumSq = 0, n = 0;
      for (let i = 1; i < cleanRR.length; i++) {
        const diff = cleanRR[i] - cleanRR[i-1];
        if (Math.abs(diff) > 1) { sumSq += diff * diff; n++; }
      }
      rmssd = n >= 3 ? Math.round(Math.sqrt(sumSq / n)) : null;
      console.log('[Face] RMSSD:', rmssd, 'ms');
      if (rmssd != null && (rmssd < 5 || rmssd > 200)) rmssd = null;
    }

    // SDNN 폴백 데이터
    let sdnn = null;
    if (rrIntervals.length >= 4) {
      const meanRR = rrIntervals.reduce((a,b)=>a+b,0) / rrIntervals.length;
      const sdSum = rrIntervals.reduce((s,v) => s + (v-meanRR)**2, 0);
      sdnn = Math.round(Math.sqrt(sdSum / rrIntervals.length));
    }

    // 스트레스 (Shaffer 2017)
    let stressIdx = null;
    if (rmssd && rmssd > 0) {
      if (rmssd < 15)       stressIdx = 85;
      else if (rmssd < 25)  stressIdx = 70;
      else if (rmssd < 40)  stressIdx = 50;
      else if (rmssd < 60)  stressIdx = 30;
      else                  stressIdx = 20;
    } else if (sdnn) {
      if (sdnn < 20)       stressIdx = 75;
      else if (sdnn < 35)  stressIdx = 55;
      else if (sdnn < 60)  stressIdx = 35;
      else                 stressIdx = 25;
    } else if (hr) {
      if (hr <= 65) stressIdx = 25;
      else if (hr <= 80) stressIdx = 45;
      else if (hr <= 95) stressIdx = 60;
      else stressIdx = 75;
    }

    const sqi = Math.min(100, Math.round((snr - 1) * 30));
    return { hr, rmssd, respRate, stressIdx, sqi, snr, peakCount: peaks.length };
  },

  _faceDisplayResults(r) {
    const panel = document.getElementById('face-result-panel');
    panel.classList.add('show');

    const setArc = (id, val, min, max) => {
      const arc = document.getElementById(id);
      if (!arc || val == null) return;
      let pct = (val - min) / (max - min);
      pct = Math.max(0, Math.min(1, pct));
      arc.style.strokeDashoffset = String(283 - pct * 283);
    };
    const setBadge = (id, label, cls) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.textContent = label;
      el.className = 'rg-badge ' + cls;
    };

    if (r.hr) {
      document.getElementById('fr-hr-val').textContent = r.hr;
      setArc('fr-hr-arc', r.hr, 40, 180);
      const cls = r.hr<60?'low':r.hr<=100?'normal':r.hr<=120?'high':'bad';
      const lbl = r.hr<60?'서맥':r.hr<=100?'정상':r.hr<=120?'약간높음':'높음';
      setBadge('fr-hr-badge', lbl, cls);
    }
    if (r.respRate) {
      document.getElementById('fr-rr-val').textContent = r.respRate;
      setArc('fr-rr-arc', r.respRate, 8, 30);
      const cls = r.respRate<10?'low':r.respRate<=22?'normal':'high';
      const lbl = r.respRate<10?'느림':r.respRate<=12?'안정':r.respRate<=20?'정상':'빠름';
      setBadge('fr-rr-badge', lbl, cls);
    } else {
      document.getElementById('fr-rr-val').textContent = '--';
      setBadge('fr-rr-badge', '데이터 부족', 'wait');
    }
    if (r.rmssd) {
      document.getElementById('fr-hv-val').textContent = r.rmssd;
      setArc('fr-hv-arc', r.rmssd, 15, 60);
      const cls = r.rmssd<20?'bad':r.rmssd<35?'high':'normal';
      const lbl = r.rmssd<20?'스트레스':r.rmssd<35?'보통':'이완';
      setBadge('fr-hv-badge', lbl, cls);
    } else {
      document.getElementById('fr-hv-val').textContent = '--';
      setBadge('fr-hv-badge', '피크 부족', 'wait');
    }
    if (r.stressIdx != null) {
      document.getElementById('fr-st-val').textContent = r.stressIdx;
      setArc('fr-st-arc', r.stressIdx, 0, 100);
      const cls = r.stressIdx<35?'normal':r.stressIdx<60?'high':'bad';
      const lbl = r.stressIdx<35?'이완':r.stressIdx<60?'보통':'스트레스';
      setBadge('fr-st-badge', lbl, cls);
    } else {
      document.getElementById('fr-st-val').textContent = '--';
      setBadge('fr-st-badge', '데이터 부족', 'wait');
    }

    let score = 100;
    if (r.hr) {
      if (r.hr<50||r.hr>120) score -= 20;
      else if (r.hr<60||r.hr>100) score -= 8;
    }
    if (r.rmssd && r.rmssd<20) score -= 18;
    if (r.stressIdx && r.stressIdx>70) score -= 15;
    score = Math.max(0, Math.min(100, score));
    const grade = score>=85?'A':score>=70?'B':score>=50?'C':'D';
    const gEl = document.getElementById('face-result-grade');
    gEl.textContent = `${grade} · ${score}점`;
    gEl.className = 'result-grade ' + grade;
  },

  faceTab(tab) {
    document.querySelectorAll('#page-face .r-tab').forEach(t => {
      t.classList.toggle('on', t.textContent.toLowerCase().includes(tab) || t.textContent.includes(tab.toUpperCase()));
    });
    document.querySelectorAll('#page-face .r-panel').forEach(p => {
      p.classList.toggle('on', p.dataset.fp === tab);
    });
  },

  // ─── 파형 그리기 ───
  _faceDrawWaveform() {
    const cv = document.getElementById('face-wave');
    const ctx = this._waveCtx || cv.getContext('2d');
    if (!this._waveCtx) this._waveCtx = ctx;
    const W = cv.width, H = cv.height;
    ctx.fillStyle = '#050810';
    ctx.fillRect(0, 0, W, H);

    const samples = this.state.face.samples;
    if (samples.length < 30) return;

    const winSamples = this.config.face.targetSR * this.config.face.waveWindowSec;
    const slice = samples.slice(-winSamples);
    if (slice.length < 30) return;

    const reds = slice.map(s => s.r);
    const greens = slice.map(s => s.g);
    const blues = slice.map(s => s.b);
    const pos = this._posAlgorithm(reds, greens, blues);
    const filtered = this._bandpass(pos, this.config.face.targetSR, 0.7, 3.0);

    const minV = Math.min(...filtered);
    const maxV = Math.max(...filtered);
    const range = Math.max(maxV - minV, 0.0001);

    ctx.strokeStyle = 'rgba(167,139,250,.08)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const y = H * i / 4;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }

    ctx.strokeStyle = '#a78bfa';
    ctx.lineWidth = 1.8;
    ctx.shadowBlur = 4;
    ctx.shadowColor = '#a78bfa';
    ctx.beginPath();
    filtered.forEach((v, i) => {
      const x = i / (filtered.length - 1) * W;
      const y = H - ((v - minV) / range) * (H - 10) - 5;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.shadowBlur = 0;
  },

  // ════════════════════════════════════════════════════════════════
  // 헬퍼 함수
  // ════════════════════════════════════════════════════════════════

  _stdDev(arr) {
    if (!arr || arr.length === 0) return 0;
    const m = arr.reduce((a,b) => a+b, 0) / arr.length;
    return Math.sqrt(arr.reduce((s,v) => s + (v-m)**2, 0) / arr.length);
  },

  _detrend(arr) {
    const N = arr.length;
    const mean = arr.reduce((a,b)=>a+b,0) / N;
    let sumXY = 0, sumXX = 0;
    for (let i = 0; i < N; i++) {
      sumXY += (i - N/2) * (arr[i] - mean);
      sumXX += (i - N/2) ** 2;
    }
    const slope = sumXX > 0 ? sumXY / sumXX : 0;
    return arr.map((v, i) => v - mean - slope * (i - N/2));
  },

  _bandpass(sig, sr, loHz, hiHz) {
    const w1 = Math.max(2, Math.round(sr / hiHz));
    const w2 = Math.max(w1+1, Math.round(sr / loHz));
    const movAvg = (x, win) => {
      const out = new Array(x.length).fill(0);
      let sum = 0; const buf = new Array(win).fill(0); let idx = 0;
      for (let i = 0; i < x.length; i++) {
        const v = isFinite(x[i]) ? x[i] : 0;
        sum += v - buf[idx]; buf[idx] = v; idx = (idx + 1) % win;
        out[i] = sum / win;
      }
      return out;
    };
    const ma1 = movAvg(sig, w1);
    const ma2 = movAvg(sig, w2);
    return ma1.map((v, i) => v - ma2[i]);
  },

  _goertzelPeak(sig, sr, loHz, hiHz) {
    const goertzel = (x, sr, freq) => {
      const k = freq * x.length / sr;
      const w = 2 * Math.PI * k / x.length;
      const cosw = Math.cos(w), coeff = 2 * cosw;
      let q1 = 0, q2 = 0, q0;
      for (let i = 0; i < x.length; i++) {
        q0 = coeff * q1 - q2 + x[i];
        q2 = q1; q1 = q0;
      }
      return q1*q1 + q2*q2 - q1*q2*coeff;
    };
    let bestF = 0, bestP = 0, total = 0, count = 0;
    const startBPM = Math.round(loHz * 60);
    const endBPM = Math.round(hiHz * 60);
    for (let bpm = startBPM; bpm <= endBPM; bpm += 1) {
      const f = bpm / 60;
      const p = goertzel(sig, sr, f);
      total += p; count++;
      if (p > bestP) { bestP = p; bestF = f; }
    }
    const avg = total / count;
    return { freq: bestF, snr: bestP / Math.max(avg, 1e-9), power: bestP };
  },

  _detectPeaks(sig, sr, hrHz) {
    const N = sig.length;
    if (N < 10) return [];
    let sumS = 0;
    for (let i = 0; i < N; i++) sumS += sig[i];
    const meanS = sumS / N;
    let sumSq = 0;
    for (let i = 0; i < N; i++) sumSq += (sig[i] - meanS) ** 2;
    const std = Math.sqrt(sumSq / N);
    const centered = new Array(N);
    for (let i = 0; i < N; i++) centered[i] = sig[i] - meanS;

    let expectedRR = hrHz && hrHz > 0 ? sr / hrHz : sr * 0.85;
    const minDist = Math.max(8, Math.round(expectedRR * 0.55));
    const winHalf = Math.max(2, Math.round(expectedRR / 6));
    const thr = std * 0.02;

    const peaks = [];
    let lastIdx = -minDist;
    for (let i = winHalf; i < N - winHalf; i++) {
      const v = centered[i];
      if (v < thr) continue;
      let isMax = true;
      for (let j = 1; j <= winHalf; j++) {
        if (centered[i - j] > v || centered[i + j] > v) { isMax = false; break; }
      }
      if (!isMax) continue;
      if (i - lastIdx >= minDist) {
        peaks.push(i);
        lastIdx = i;
      } else if (peaks.length > 0 && centered[peaks[peaks.length - 1]] < v) {
        peaks[peaks.length - 1] = i;
        lastIdx = i;
      }
    }
    return peaks;
  },

  // ─── 공통 ───
  _setupCanvas() {
    this._cv = document.createElement('canvas');
  },

  _bindVisibilityHandler() {
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.state.face.running) {
        this._faceTickTimer();
      }
    });
  },

  _cleanupAll() {
    if (this.state.face.stream) {
      this.state.face.stream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} });
    }
  }
};

window.addEventListener('DOMContentLoaded', () => App.init());
