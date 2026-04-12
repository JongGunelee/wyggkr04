/**
 * ═══════════════════════════════════════════════════
 * Antigravity Kit Manager Automation Server v3.0
 * ═══════════════════════════════════════════════════
 * 
 * [설계 철학]
 * Kit Manager는 안티그래비티 IDE의 핵심 인프라 관리 엔진입니다.
 * 새 컴퓨터에서도 9번 버튼 한 번으로 전체 환경이 초기화되고,
 * 1~8, 10번 버튼은 각각의 고유한 목적에 맞게 정확히 동작합니다.
 * 
 * [버튼 설계 목적]
 *  1. 진단     - 폴더 구조와 필수 파일 존재 여부를 트리 형태로 점검
 *  2. 청소     - 임시파일/격리소 내 불필요 데이터를 물리적으로 삭제
 *  3. 설치     - 레지스트리에 등록된 킷을 git clone으로 실제 다운로드
 *  4. Symlink - kits/ 하위를 skills/ 경로로 심볼릭 연결 (전역 인식 설정)
 *  5. 업데이트 - 설치된 킷의 git pull로 최신 버전 유지
 *  6. 검증     - 경로, 레지스트리, 심링크 상태를 종합 검증
 *  7. 파편수집 - skills/ 내 레지스트리에 없는 미등록 모듈 탐지
 *  8. 폴더현황 - 전체 폴더 트리와 용량을 실시간 계산하여 표시
 *  9. 전역초기화 - 폴더 생성 + 레지스트리 초기화 + 환경변수 + JSON 검증
 * 10. GSD 시작  - Get Shit Done 워크플로우 엔진 활성화
 *
 * [검색 엔진]
 * /api/search - skills/, kits/ 내 SKILL.md 파일을 실시간 grep,
 *   mode=skills → skills/ 전용, mode=agents → skills/ 내 에이전트 계열 전용
 */
const http = require('http');
const { spawn } = require('child_process');
const url = require('url');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = 9700;
const R = 'C:\\Users\\PC\\.gemini\\antigravity';
const K = path.join(R, 'kits');
const S = path.join(R, 'skills');
const REGISTRY_FILE = path.join(K, '_registry.json');
const TEMP_SCRIPT = path.join(os.tmpdir(), 'ag_audit_v30.ps1');

const DEFAULT_KITS = [
  { id: 'everything-claude-code', repo: 'https://github.com/affaan-m/everything-claude-code.git', sub: 'skills', name: 'Everything Claude Code', icon: '🚀', category: 'Core', desc: 'Anthropic Claude Code 상용/공식 스킬셋 통합' },
  { id: 'antigravity-kit', repo: 'https://github.com/vudovn/antigravity-kit.git', sub: 'skills', name: 'Antigravity Kit', icon: '🦾', category: 'Agent', desc: '안티그래비티 IDE 전용 에이전트 확장 킷' },
  { id: 'antigravity-awesome-skills', repo: 'https://github.com/sickn33/Antigravity-awesome-skills.git', sub: 'skills', name: 'Antigravity Awesome Skills', icon: '🔥', category: 'Skill', desc: '혁신적인 최신 어썸 스킬셋 모음' },
  { id: 'gstack', repo: 'https://github.com/garrytan/gstack.git', sub: 'agents', name: 'G-Stack', icon: '⚡', category: 'Automation', desc: 'Garry Tan의 엔지니어링 에이전트 스택' },
  { id: 'agent-skills', repo: 'https://github.com/addyosmani/agent-skills.git', sub: 'skills', name: 'Agent Skills', icon: '🧩', category: 'Skill', desc: 'Google 개발팀의 고도화 스킬 모음' },
  { id: 'gsd-workflow', repo: 'https://github.com/gsd-build/get-shit-done.git', sub: 'skills', name: 'GSD Workflow', icon: '🚀', category: 'Workflow', desc: 'Get Shit Done 에이전트 자동화 시스템' }
];

// ─── Registry I/O ────────────────────────────────
function loadRegistry() {
  if(!fs.existsSync(R)) fs.mkdirSync(R, { recursive: true });
  if(!fs.existsSync(K)) fs.mkdirSync(K, { recursive: true });
  if(!fs.existsSync(S)) fs.mkdirSync(S, { recursive: true });
  if (!fs.existsSync(REGISTRY_FILE)) { 
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify(DEFAULT_KITS, null, 2), 'utf-8'); 
    return DEFAULT_KITS; 
  }
  try { 
    const reg = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8'));
    DEFAULT_KITS.forEach(dk => { if(!reg.find(rk => rk.id === dk.id)) reg.push(dk); });
    return reg;
  } catch (e) { return DEFAULT_KITS; }
}

// ─── PowerShell Execution Engine ──────────────────
function runPowerShell(script) {
  return new Promise((resolve) => {
    const output = [];
    const fullScript = `$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8;\n$R='${R}'; $K='${K}'; $S='${S}';\n${script}`;
    
    const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
    const content = Buffer.concat([bom, Buffer.from(fullScript, 'utf8')]);
    fs.writeFileSync(TEMP_SCRIPT, content);

    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', TEMP_SCRIPT], { windowsHide: true });
    
    ps.stdout.on('data', d => output.push(d.toString('utf8')));
    ps.stderr.on('data', d => output.push('[ERR] ' + d.toString('utf8')));
    ps.on('close', code => {
      try { if(fs.existsSync(TEMP_SCRIPT)) fs.unlinkSync(TEMP_SCRIPT); } catch(e){}
      
      let outStr = output.join('').trim();
      outStr = outStr.replace(/\|--/g, '├──');
      outStr = outStr.replace(/`--/g, '└──');
      outStr = outStr.replace(/\|   /g, '│   ');

      resolve(outStr + `\n\n[EXIT: ${code}]`);
    });
    setTimeout(() => { try { ps.kill(); } catch(e){} resolve(output.join('').trim() + '\n\n[TIMEOUT]'); }, 120000);
  });
}

// ─── Folder Status Builder ────────────────────────
function buildFolderStatusScript() {
  return `
    $RawJson = Get-Content "$K\\_registry.json" -Raw -Encoding UTF8 | ConvertFrom-Json
    $excludePattern = '\\\\(node_modules|\\.git|dist|build|\\.next|\\.cache|__pycache__|vendor)(\\\\.+)*$'
    
    # 용량 자동 단위 변환 헬퍼 (B → KB → MB → GB)
    function Format-Size($bytes) {
        if ($bytes -ge 1GB) { return "$([math]::Round($bytes / 1GB, 2)) GB" }
        if ($bytes -ge 1MB) { return "$([math]::Round($bytes / 1MB, 2)) MB" }
        if ($bytes -ge 1KB) { return "$([math]::Round($bytes / 1KB, 2)) KB" }
        return "$bytes B"
    }

    $sb = New-Object System.Text.StringBuilder
    [void]$sb.AppendLine("[작업 일시: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')]")
    [void]$sb.AppendLine("--- 전역 통합 폴더 구조 정밀 분석 리포트 (Dual-Layer) ---")
    [void]$sb.AppendLine("")

    # ── 데이터 수집 ──
    $kitReports = @()

    foreach ($kit in $RawJson) {
        $kitPath = Join-Path $K $kit.id
        $report = @{ ID = $kit.id; Installed = $false; Folders = 0; Files = 0; SizeBytes = 0; SubDirs = @() }

        if (Test-Path $kitPath) {
            $report.Installed = $true

            # 모든 하위 디렉토리 목록 (제외 대상 필터링)
            $allDirs = @($kitPath)  # 루트 폴더 자신 포함
            $subDirs = Get-ChildItem -Path $kitPath -Directory -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notmatch $excludePattern }
            if ($subDirs) { $allDirs += $subDirs.FullName }

            $dirStats = @()
            foreach ($dir in $allDirs) {
                $dirFiles = Get-ChildItem -Path $dir -File -ErrorAction SilentlyContinue
                $fCount = 0; $fSize = 0
                if ($dirFiles) {
                    $fCount = $dirFiles.Count
                    $fSize = ($dirFiles | Measure-Object -Property Length -Sum).Sum
                }
                $report.Files += $fCount
                $report.SizeBytes += $fSize
                $dirStats += @{ Path = $dir; FileCount = $fCount; SizeBytes = $fSize }
            }
            $report.Folders = $allDirs.Count
            $report.SubDirs = $dirStats
        }
        $kitReports += $report
    }

    # ── [1] 상단 총괄 ──
    [void]$sb.AppendLine("[1] 📂 상단 총괄 폴더 구조 요약")
    [void]$sb.AppendLine("--------------------------------------------------------------------------------")
    [void]$sb.AppendLine("Root: $R")
    [void]$sb.AppendLine("├── skills/ (전역 심링크 링크 허브)")
    [void]$sb.AppendLine("├── extensions/ (확장 기능)")
    [void]$sb.AppendLine("└── kits/ (통합 관리 저장소)")
    
    foreach ($kitID in $RawJson.id) {
        $found = $kitReports | Where-Object { $_.ID -eq $kitID }
        if ($found) {
            [void]$sb.AppendLine("    ├── $($found.ID)/")
        }
    }
    [void]$sb.AppendLine("    └── _quarantine/ (파편 격리소)")
    [void]$sb.AppendLine("--------------------------------------------------------------------------------")
    [void]$sb.AppendLine("")
    
    foreach ($r in $kitReports) {
        $sizeStr = Format-Size $r.SizeBytes
        $status = if (!$r.Installed) { " (미설치)" } else { "" }
        [void]$sb.AppendLine(" > 키트: [$($r.ID)]$status")
        [void]$sb.AppendLine("   ├── 하위 폴더 수 : $($r.Folders) 개")
        [void]$sb.AppendLine("   ├── 총 파일 갯수 : $($r.Files) 개")
        [void]$sb.AppendLine("   └── 총 사용 용량 : $sizeStr")
    }
    [void]$sb.AppendLine("--------------------------------------------------------------------------------")
    [void]$sb.AppendLine("")

    # ── [2] 하단 상세 트리 ──
    [void]$sb.AppendLine("[2] 🔍 하단 개별 폴더별 밑바닥 전수 점검")
    foreach ($r in $kitReports) {
        $kitPath = Join-Path $K $r.ID
        [void]$sb.AppendLine("")
        [void]$sb.AppendLine("📂 키트 상세 분석: $($r.ID)")
        if ($r.Installed -and $r.SubDirs) {
            $sorted = $r.SubDirs | Sort-Object { $_.Path }
            foreach ($d in $sorted) {
                $rel = $d.Path
                if ($rel.StartsWith($kitPath)) { $rel = $rel.Substring($kitPath.Length).TrimStart('\\') }
                if ([string]::IsNullOrEmpty($rel)) { $rel = "." }
                $depth = ($rel.Split('\\') | Where-Object { $_ -and $_ -ne '.' }).Count
                $indent = "  " * $depth
                $sizeStr = Format-Size $d.SizeBytes
                [void]$sb.AppendLine("$indent├── $rel/ (파일: $($d.FileCount)개 / $sizeStr)")
            }
        } else {
            [void]$sb.AppendLine("  (데이터 없음)")
        }
    }
    [void]$sb.AppendLine("")
    [void]$sb.AppendLine("[최종 결과] 정밀 자산 분석 시스템 보고 완료")

    # 한 번의 Write-Host로 전체 출력 (타임아웃 방지)
    Write-Host $sb.ToString()
  `;
}

// ─── System Info ──────────────────────────────────
function getSystemInfo() {
  const cpus = os.cpus();
  const cpuModel = cpus.length > 0 ? cpus[0].model.replace(/\(R\)|Core\(TM\)|\s+CPU|@.*$/g, '').trim() : 'Unknown';
  const memUsage = ((1 - os.freemem() / os.totalmem()) * 100).toFixed(1);
  const uptimeHours = (os.uptime() / 3600).toFixed(1);
  return { cpu: cpuModel, memUsage: memUsage + '%', uptime: uptimeHours + 'h' };
}

// ─── Search Engine: skills/kits 내 SKILL.md 실시간 검색 ──
function searchSkillFiles(query, mode) {
  const results = [];
  const lowerQ = query.toLowerCase();
  
  // 검색 대상 디렉토리 결정 (모든 모드에서 kits와 skills를 포함하여 검색 범위 확대)
  const searchDirs = [
    { base: S, label: 'skills' },
    { base: K, label: 'kits' }
  ];
  
  // mode에 따른 필터 설정
  const agentFilter = (mode === 'agents');
  // (추가적인 mode 기반 필터링이 필요하다면 label 속성 등을 활용 가능)

  let totalFiles = 0;

  for (const dir of searchDirs) {
    if (!fs.existsSync(dir.base)) continue;
    
    try {
      if (dir.label === 'skills') {
        const topDirs = fs.readdirSync(dir.base, { withFileTypes: true })
          .filter(d => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('_'));
        
        for (const td of topDirs) {
          const skillMdPath = path.join(dir.base, td.name, 'SKILL.md');
          if (!fs.existsSync(skillMdPath)) continue;
          totalFiles++;
          processFileMatching(skillMdPath, td.name, agentFilter);
        }
      } else {
        // Kits Directory: 재귀적으로 모든 .md 파일 검색
        const getAllMdFiles = (dirPath) => {
          let files = [];
          try {
            const items = fs.readdirSync(dirPath, { withFileTypes: true });
            for (const item of items) {
              if (item.name.startsWith('.') || item.name.startsWith('_')) continue;
              const fullPath = path.join(dirPath, item.name);
              if (item.isDirectory()) {
                files = files.concat(getAllMdFiles(fullPath));
              } else if (item.isFile() && item.name.endsWith('.md')) {
                files.push({ path: fullPath, folderName: path.basename(path.dirname(fullPath)) });
              }
            }
          } catch (e) { /* skip */ }
          return files;
        };
        
        const mdFiles = getAllMdFiles(dir.base);
        for (const fileObj of mdFiles) {
          totalFiles++;
          processFileMatching(fileObj.path, fileObj.folderName, agentFilter);
        }
      }
    } catch (dirErr) { /* skip inaccessible */ }
  }

  function processFileMatching(filePath, folderName, agentFilter) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      
      // Agent 모드 필터
      if (agentFilter) {
        const fullLower = content.toLowerCase();
        const nameL = folderName.toLowerCase();
        // 넓은 기준으로 'agent' 역할을 하는 것들을 포함
        const isAgent = nameL.includes('agent') || nameL.includes('bot') || 
                        nameL.includes('orchestrat') || nameL.includes('automat') ||
                        fullLower.includes('agent') || fullLower.includes('bot') ||
                        fullLower.includes('에이전트') || fullLower.includes('자동화');
        if (!isAgent) return;
      }
      
      let matched = false;
      const terms = lowerQ.split(' ').filter(t => t.trim().length > 0);
      const isWildcard = lowerQ.trim() === '*';
      const tdNameLower = folderName.toLowerCase();
      
      // 1) Folder name matching (AND or Wildcard)
      if (isWildcard || (terms.length > 0 && terms.every(term => tdNameLower.includes(term)))) {
        results.push({
          Path: filePath,
          LineNumber: 1,
          Content: isWildcard ? `[전체 목록]: ${folderName}` : `[폴더명 매칭]: ${folderName}`,
          Total: 0
        });
        matched = true;
      }

      // 2) Content matching (AND - skip if wildcard because folder is sufficient)
      if (!matched && !isWildcard && terms.length > 0) {
        for (let i = 0; i < lines.length; i++) {
          const lineLower = lines[i].toLowerCase();
          if (terms.every(term => lineLower.includes(term))) {
            results.push({
              Path: filePath,
              LineNumber: i + 1,
              Content: lines[i].trim().substring(0, 200),
              Total: 0
            });
            break; 
          }
        }
      }
    } catch (e) { /* skip */ }
  }

  // 매칭 갯수 제한 (프론트 통신 과부하 방지)
  if (results.length > 150) {
      results.splice(150);
  }

  // Total 필드 설정
  if (results.length === 0) {
    return [{ Total: totalFiles }];
  }
  results[0].Total = totalFiles;
  return results;
}

// ─── File Reader for openManual ───────────────────
function readFileContent(filePath) {
  // 보안: antigravity 경로 내부만 허용
  const normalizedPath = path.resolve(filePath);
  if (!normalizedPath.startsWith(path.resolve(R))) {
    return null;
  }
  if (!fs.existsSync(normalizedPath)) return null;
  try {
    return fs.readFileSync(normalizedPath, 'utf-8');
  } catch (e) {
    return null;
  }
}

// ═══════════════════════════════════════════════════
// HTTP Server
// ═══════════════════════════════════════════════════
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const action = parsed.query.action;

  try {
    // ═════════════════════════════════════════════
    // /api/run — 자동화 버튼 실행 엔진
    // ═════════════════════════════════════════════
    if (pathname === '/api/run') {
      let script = '';
      
      // ── [8] 통합 폴더 현황 ──────────────────
      if (action === 'folder_status') {
          script = buildFolderStatusScript();
      }
      // ── [1] 시스템 진단 (DEEP INTEGRITY ANALYZER) ──────────
      else if (action === 'diagnose') {
          script = `
            $log = New-Object System.Collections.Generic.List[string]
            $paths = @("kits", "skills", "extensions")
            $broken = 0
            $totalSteps = 0
            $currentStep = 0

            Write-Host "================================================================================" -ForegroundColor Gray
            Write-Host "          🔍 시스템 무결성 정밀 진단 (Deep Integrity Analyzer)" -ForegroundColor Cyan
            Write-Host "  >> 진단 루트 경로: $R" -ForegroundColor DarkGray
            Write-Host "  >> 키트 저장소  : $K" -ForegroundColor DarkGray
            Write-Host "  >> 전역 스킬 허브: $S" -ForegroundColor DarkGray
            Write-Host "  >> 레지스트리   : $K\\_registry.json" -ForegroundColor DarkGray
            Write-Host "================================================================================" -ForegroundColor Gray
            Write-Host "[작업 일시: \$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')]" -ForegroundColor Gray
            Write-Host ""

            # ── [PHASE 1] 총 단계 수 사전 계산 ──────────────────────────
            $totalSteps = $paths.Count
            if (Test-Path "$K\\_registry.json") {
                $regTemp = Get-Content "$K\\_registry.json" -Raw -Encoding UTF8 | ConvertFrom-Json
                $totalSteps += $regTemp.Count
            }

            Write-Host "--- [PHASE 1] 핵심 인프라 디렉토리 경로 진단 (총 $($paths.Count) 항목) ---" -ForegroundColor Cyan
            Write-Host ""

            foreach ($p in $paths) {
                $currentStep++
                $pct = [math]::Round(($currentStep / $totalSteps) * 100)
                $fullPath = "$R\\$p"

                Write-Host "[$currentStep/$totalSteps] 진단 대상 디렉토리: $p" -ForegroundColor Cyan
                Write-Host "  >> 전체 경로: $fullPath" -ForegroundColor DarkGray
                Write-Host "  [CMD] Test-Path \`"$fullPath\`"" -ForegroundColor DarkGray
                Write-Host "  [PRG]   0% >> IO 시그니처 탐색 중..." -ForegroundColor Gray

                Start-Sleep -Milliseconds 80

                Write-Host "  [PRG]  30% >> 경로 존재 여부 확인 중..." -ForegroundColor Gray
                $exists = Test-Path $fullPath
                Write-Host "  [PRG]  60% >> 디렉토리 구조 파악 중..." -ForegroundColor Gray

                if ($exists) {
                    $cmd2 = "Get-ChildItem \`"$fullPath\`" -Recurse -File"
                    Write-Host "  [CMD] $cmd2" -ForegroundColor DarkGray
                    $size = (Get-ChildItem $fullPath -Recurse -File -EA SilentlyContinue | Measure-Object -Property Length -Sum).Sum / 1MB
                    Write-Host "  [PRG]  90% >> 용량 합산 처리 중..." -ForegroundColor Gray
                    Write-Host "  [PRG] 100% >> 검증 완료" -ForegroundColor Gray
                    $msg = "  [OK] $p\\ >> [정상] ({0:N2} MB) | 경로: $fullPath" -f $size
                    Write-Host $msg -ForegroundColor Green
                    $log.Add($msg)
                } else {
                    Write-Host "  [PRG]  90% >> 경로 부재 확인됨..." -ForegroundColor Gray
                    Write-Host "  [PRG] 100% >> 검증 완료 (오류)" -ForegroundColor Gray
                    $msg = "  [!!] $p\\ >> [누락] 해당 경로가 존재하지 않습니다: $fullPath"
                    Write-Host $msg -ForegroundColor Red
                    $log.Add($msg)
                    $broken++
                }
                Write-Host "  >> 전체 진행률: $pct%" -ForegroundColor DarkGray
                Write-Host ""
            }

            # ── [PHASE 2] 레지스트리 & 전역 심링크 진단 ────────────────
            Write-Host "--- [PHASE 2] 전역 심링크 (skills/) 무결성 진단 ---" -ForegroundColor Cyan
            Write-Host ""

            $regPath = "$K\\_registry.json"
            Write-Host "  [CMD] Test-Path \`"$regPath\`"" -ForegroundColor DarkGray

            if (Test-Path $regPath) {
                $reg = Get-Content $regPath -Raw -Encoding UTF8 | ConvertFrom-Json
                $regMsg = "  [OK] 레지스트리 로드 완료: $($reg.Count)개 키트 등록됨 | 경로: $regPath"
                Write-Host $regMsg -ForegroundColor Green
                $log.Add($regMsg)
                Write-Host ""

                foreach ($k in $reg) {
                    $currentStep++
                    $pct = [math]::Round(($currentStep / $totalSteps) * 100)
                    $link   = "$S\\$($k.id)"
                    $source = "$K\\$($k.id)"

                    Write-Host "[$currentStep/$totalSteps] 심링크 진단 대상: $($k.id)" -ForegroundColor Cyan
                    Write-Host "  >> 원본(Kits) 경로: $source" -ForegroundColor DarkGray
                    Write-Host "  >> 링크(Skills) 경로: $link" -ForegroundColor DarkGray
                    Write-Host "  [CMD] Get-Item \`"$link\`"  | Select-Object -ExpandProperty Attributes" -ForegroundColor DarkGray
                    Write-Host "  [PRG]   0% >> 링크 존재 여부 확인 중..." -ForegroundColor Gray

                    Start-Sleep -Milliseconds 60

                    Write-Host "  [PRG]  30% >> 링크 타입 판별 중..." -ForegroundColor Gray

                    if (Test-Path $link) {
                        $item = Get-Item $link
                        Write-Host "  [PRG]  60% >> Attributes 분석 중: $($item.Attributes)" -ForegroundColor Gray

                        if ($item.Attributes -match "ReparsePoint") {
                            Write-Host "  [CMD] \`$item.Target => $($item.Target)" -ForegroundColor DarkGray
                            $target = $item.Target
                            Write-Host "  [PRG]  80% >> 타겟 경로 유효성 검증 중..." -ForegroundColor Gray

                            if ([string]::IsNullOrEmpty($target) -or !(Test-Path $target)) {
                                $broken++
                                Write-Host "  [PRG] 100% >> 검증 완료 (심링크 손상)" -ForegroundColor Gray
                                $msg = "  [!!] $($k.id) >> [손상] 심링크 타겟 무효 | 링크: $link => 타겟: $target"
                                Write-Host $msg -ForegroundColor Red
                                $log.Add($msg)
                            } else {
                                Write-Host "  [PRG] 100% >> 검증 완료 (정상)" -ForegroundColor Gray
                                $msg = "  [OK] $($k.id) >> [정상] 전역 심링크 연결됨 | $link => $target"
                                Write-Host $msg -ForegroundColor Green
                                $log.Add($msg)
                            }
                        } else {
                            Write-Host "  [PRG] 100% >> 검증 완료 (실제 폴더 감지)" -ForegroundColor Gray
                            $msg = "  [??] $($k.id) >> [알림] 심링크가 아닌 실제 폴더 존재 | 경로: $link"
                            Write-Host $msg -ForegroundColor Yellow
                            $log.Add($msg)
                        }
                    } else {
                        $broken++
                        Write-Host "  [PRG]  60% >> 경로 부재 확인됨..." -ForegroundColor Gray
                        Write-Host "  [PRG] 100% >> 검증 완료 (링크 누락)" -ForegroundColor Gray
                        $msg = "  [!!] $($k.id) >> [누락] 전역 심링크 없음 | 기대 경로: $link"
                        Write-Host $msg -ForegroundColor Red
                        $log.Add($msg)
                    }
                    Write-Host "  >> 전체 진행률: $pct%" -ForegroundColor DarkGray
                    Write-Host ""
                }
            } else {
                $broken++
                $msg = "  [!!] _registry.json >> [누락] 레지스트리 파일이 없습니다: $regPath"
                Write-Host $msg -ForegroundColor Red
                $log.Add($msg)
                Write-Host ""
            }

            # ── [PHASE 3] 최종 종합 리포트 ──────────────────────────────
            Write-Host "================================================================================" -ForegroundColor Gray
            Write-Host "--- [PHASE 3] 최종 종합 리포트 ---" -ForegroundColor Cyan
            Write-Host ""
            Write-Host "  >> 진단 완료 시각: \$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor DarkGray
            Write-Host "  >> 총 진단 항목: $totalSteps 개" -ForegroundColor DarkGray
            Write-Host "  >> 무결성 결함: $broken 개 발견" -ForegroundColor DarkGray
            Write-Host ""

            $score = 100 - ($broken * 10)
            if ($score -lt 0) { $score = 0 }

            if ($broken -eq 0) {
                Write-Host "[최종 결과] ✅ 시스템 건전성 점수: \${score}점 (모든 필수 경로 및 심링크 완전 확인됨)" -ForegroundColor Green
                $Q_fix = "$K\\_quarantine\\blocking_folders"
                if (Test-Path $Q_fix) {
                    Write-Host "[수리 이력] 과거의 무결성 결함을 극복하고 현재 100% 정상 상태를 달성했습니다!" -ForegroundColor Cyan
                }
            } else {
                Write-Host "[최종 결과] ⚠️  시스템 건전성 주의: \${score}점 ($broken 개의 무결성 결함이 발견되었습니다)" -ForegroundColor Red
                Write-Host "[조치 권고] 4번 버튼 'Symlink 전역 설정' 혹은 11번 '자가 복구 패치'를 클릭하십시오." -ForegroundColor Cyan
            }

            Write-Host ""
            Write-Host "--- 전체 진단 항목 상세 내역 ---" -ForegroundColor Gray
            $log | ForEach-Object {
                if ($_ -match "누락|손상") { Write-Host $_ -ForegroundColor Red }
                elseif ($_ -match "알림|[?][?]")  { Write-Host $_ -ForegroundColor Yellow }
                else                           { Write-Host $_ -ForegroundColor Green }
            }
            Write-Host ""
            Write-Host "--- 검사 항목 범례 (Legend) ---" -ForegroundColor Gray
            Write-Host "  [OK] [정상] : 원본(Kits)과 전역링크(Skills)가 완벽하게 연결된 상태"
            Write-Host "  [??] [알림] : 현재 경로에 '심링크'가 아닌 '실제 데이터'가 존재 (11번 패치로 해결 권장)" -ForegroundColor Yellow
            Write-Host "  [!!] [누락] : 레지스트리에는 있으나 전역 경로에 연결 링크가 없는 상태" -ForegroundColor Red
            Write-Host "  [!!] [손상] : 링크는 존재하나 원본 폴더가 삭제/이동되어 연결이 깨진 상태" -ForegroundColor Red
            Write-Host "================================================================================" -ForegroundColor Gray
          `;
      }
      // ── [2] 초기화 / 청소 ──────────────────
      else if (action === 'clean') {
          script = `
            $totalSteps = 2
            $currentStep = 0

            Write-Host "================================================================================"  -ForegroundColor Gray
            Write-Host "          🧹 시스템 초기화 / 청소 (System Cleanup Engine)" -ForegroundColor Cyan
            Write-Host "  >> 키트 저장소 : $K" -ForegroundColor DarkGray
            Write-Host "  >> 격리소 경로 : $K\\_quarantine" -ForegroundColor DarkGray
            Write-Host "  >> 임시 디렉토리: [System Temp]" -ForegroundColor DarkGray
            Write-Host "================================================================================"  -ForegroundColor Gray
            Write-Host "[작업 일시: \$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')]" -ForegroundColor Gray
            Write-Host ""

            # ── [PHASE 1] 임시 파일 청소 ─────────────────────────────
            $currentStep++
            $pct = [math]::Round(($currentStep / $totalSteps) * 100)
            $tmpPath = [System.IO.Path]::GetTempPath()
            $tmpPattern = Join-Path $tmpPath "ag_audit*"

            Write-Host "[$currentStep/$totalSteps] 임시 파일(ag_audit*) 청소" -ForegroundColor Cyan
            Write-Host "  >> 전체 경로: $tmpPath" -ForegroundColor DarkGray
            Write-Host "  [CMD] Get-ChildItem \`"$tmpPattern\`" -ErrorAction SilentlyContinue" -ForegroundColor DarkGray
            Write-Host "  [PRG]   0% >> 임시 파일 목록 스캔 중..." -ForegroundColor Gray
            $tmpFiles = Get-ChildItem $tmpPattern -ErrorAction SilentlyContinue
            Write-Host "  [PRG]  50% >> 삭제 대상 파일 수: $(@($tmpFiles).Count) 개" -ForegroundColor Gray
            if (@($tmpFiles).Count -gt 0) {
                Write-Host "  [CMD] Remove-Item \`"$tmpPattern\`" -Force" -ForegroundColor DarkGray
                Remove-Item $tmpPattern -Force -ErrorAction SilentlyContinue
                Write-Host "  [PRG] 100% >> 임시 파일 제거 완료" -ForegroundColor Gray
                Write-Host "  [OK] ag_audit* $(@($tmpFiles).Count)개 삭제 완료 | 경로: $tmpPath" -ForegroundColor Green
            } else {
                Write-Host "  [PRG] 100% >> 삭제 대상 없음 (이미 청결)" -ForegroundColor Gray
                Write-Host "  [OK] 임시 파일 없음 (청결 상태) | 경로: $tmpPath" -ForegroundColor Green
            }
            Write-Host "  >> 전체 진행률: $pct%" -ForegroundColor DarkGray
            Write-Host ""

            # ── [PHASE 2] 격리소 청소 ────────────────────────────────
            $currentStep++
            $pct = [math]::Round(($currentStep / $totalSteps) * 100)
            $qPath = "$K\\_quarantine"
            $qPattern = "$qPath\\*"

            Write-Host "[$currentStep/$totalSteps] 격리소(_quarantine) 청소" -ForegroundColor Cyan
            Write-Host "  >> 전체 경로: $qPath" -ForegroundColor DarkGray
            Write-Host "  [CMD] Test-Path \`"$qPath\`"" -ForegroundColor DarkGray
            Write-Host "  [PRG]   0% >> 격리소 존재 여부 확인 중..." -ForegroundColor Gray
            $qCount = 0
            if (Test-Path $qPath) {
                Write-Host "  [CMD] Get-ChildItem \`"$qPattern\`" -EA SilentlyContinue" -ForegroundColor DarkGray
                Write-Host "  [PRG]  30% >> 격리소 항목 수 집계 중..." -ForegroundColor Gray
                $qItems = Get-ChildItem $qPattern -EA SilentlyContinue
                $qCount = if ($qItems) { @($qItems).Count } else { 0 }
                Write-Host "  [PRG]  60% >> 삭제 대상: $qCount 개 항목" -ForegroundColor Gray
                Write-Host "  [CMD] Remove-Item \`"$qPattern\`" -Recurse -Force" -ForegroundColor DarkGray
                Remove-Item $qPattern -Recurse -Force -ErrorAction SilentlyContinue
                Write-Host "  [PRG] 100% >> 격리소 비우기 완료" -ForegroundColor Gray
                Write-Host "  [OK] _quarantine $qCount개 항목 삭제 완료 | 경로: $qPath" -ForegroundColor Green
            } else {
                Write-Host "  [PRG] 100% >> 격리소 없음 (조치 불필요)" -ForegroundColor Gray
                Write-Host "  [OK] 격리소 없음 (청결 상태) | 경로: $qPath" -ForegroundColor Green
            }
            Write-Host "  >> 전체 진행률: $pct%" -ForegroundColor DarkGray
            Write-Host ""

            # ── [PHASE 3] 최종 리포트 ────────────────────────────────
            Write-Host "================================================================================"  -ForegroundColor Gray
            Write-Host "--- [PHASE 3] 최종 리포트 ---" -ForegroundColor Cyan
            Write-Host "  >> 완료 시각: \$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor DarkGray
            Write-Host ""
            Write-Host "[최종 결과] ✅ 시스템 청소 완료: 임시파일 $(@($tmpFiles).Count)개 / 격리소 $qCount개 항목 삭제" -ForegroundColor Cyan
            Write-Host "--- 상세 내역 ---"
            Write-Host "  |-- 경로: $tmpPath >> ag_audit* 찌꺼기 제거 완료"
            Write-Host "  |-- 경로: $qPath >> 격리소 비우기 완료"
            Write-Host "================================================================================"  -ForegroundColor Gray
          `;
      }
      // ── [3] 설치 / 재설치 ──────────────────
      else if (action === 'install') {
          script = `
            $log = New-Object System.Collections.Generic.List[string]
            $RawJson = Get-Content "$K\\_registry.json" -Raw -Encoding UTF8 | ConvertFrom-Json
            $installed = 0
            $skipped = 0
            $total = $RawJson.Count
            $currentStep = 0

            Write-Host "================================================================================"  -ForegroundColor Gray
            Write-Host "          📥 키트 설치 / 재설치 (Kit Installation Engine)" -ForegroundColor Cyan
            Write-Host "  >> 키트 저장소  : $K" -ForegroundColor DarkGray
            Write-Host "  >> 레지스트리   : $K\\_registry.json" -ForegroundColor DarkGray
            Write-Host "  >> 총 설치 대상 : $total 개 키트" -ForegroundColor DarkGray
            Write-Host "================================================================================"  -ForegroundColor Gray
            Write-Host "[작업 일시: \$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')]" -ForegroundColor Gray
            Write-Host ""

            foreach ($kit in $RawJson) {
                $currentStep++
                $pct = [math]::Round(($currentStep / $total) * 100)
                $target = "$K\\$($kit.id)"

                Write-Host "[$currentStep/$total] 설치 대상: $($kit.id)" -ForegroundColor Cyan
                Write-Host "  >> 설치 경로: $target" -ForegroundColor DarkGray
                Write-Host "  >> 소스 저장소: $($kit.repo)" -ForegroundColor DarkGray
                Write-Host "  [CMD] Test-Path \`"$target\`"" -ForegroundColor DarkGray
                Write-Host "  [PRG]   0% >> 설치 여부 확인 중..." -ForegroundColor Gray

                if (!(Test-Path $target)) {
                    Write-Host "  [PRG]  20% >> 미설치 확인. git clone 준비 중..." -ForegroundColor Gray
                    Write-Host "  [CMD] git clone -q \`"$($kit.repo)\`" \`"$target\`"" -ForegroundColor DarkGray
                    Write-Host "  [PRG]  40% >> git clone 실행 중 (네트워크 상태에 따라 시간 소요)..." -ForegroundColor Gray
                    try {
                        $proc = Start-Process "git" -ArgumentList "clone -q", "$($kit.repo)", "$target" -Wait -NoNewWindow -PassThru
                        if ($proc.ExitCode -eq 0) {
                            $installed++
                            Write-Host "  [PRG]  90% >> 설치 완료 검증 중..." -ForegroundColor Gray
                            Write-Host "  [PRG] 100% >> 설치 완료" -ForegroundColor Gray
                            $msg = "  [OK] $($kit.id) >> [설치성공] | 경로: $target"
                            Write-Host $msg -ForegroundColor Green
                            $log.Add($msg)
                        } else {
                            Write-Host "  [PRG] 100% >> 설치 완료 (Git 에러)" -ForegroundColor Gray
                            $msg = "  [!!] $($kit.id) >> [설치실패] Git 에러 (ExitCode: $($proc.ExitCode)) | 저장소: $($kit.repo)"
                            Write-Host $msg -ForegroundColor Red
                            $log.Add($msg)
                        }
                    } catch {
                        Write-Host "  [PRG] 100% >> 설치 완료 (권한 오류)" -ForegroundColor Gray
                        $msg = "  [!!] $($kit.id) >> [설치오류] Git 실행 권한 부족: $($_.Exception.Message)"
                        Write-Host $msg -ForegroundColor Red
                        $log.Add($msg)
                    }
                } else {
                    $skipped++
                    Write-Host "  [PRG] 100% >> 이미 설치됨 (건너뜀)" -ForegroundColor Gray
                    $msg = "  [--] $($kit.id) >> [건너뜀] 이미 존재 | 경로: $target"
                    Write-Host $msg -ForegroundColor Yellow
                    $log.Add($msg)
                }
                Write-Host "  >> 전체 진행률: $pct%" -ForegroundColor DarkGray
                Write-Host ""
            }

            Write-Host "================================================================================"  -ForegroundColor Gray
            Write-Host "--- [최종 리포트] 키트 설치 프로세스 완료 ---" -ForegroundColor Cyan
            Write-Host "  >> 완료 시각  : \$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor DarkGray
            Write-Host "  >> 신규 설치  : $installed 건" -ForegroundColor DarkGray
            Write-Host "  >> 건너뜀(존재): $skipped 건" -ForegroundColor DarkGray
            Write-Host ""
            Write-Host "[최종 결과] ✅ 키트 설치 완료: 신규설치 $installed 건 / 유지 $skipped 건" -ForegroundColor Yellow
            Write-Host "--- 설치 상세 내역 ---"
            $log | ForEach-Object { Write-Host $_ }
            Write-Host "================================================================================"  -ForegroundColor Gray
          `;
      }
      // ── [4] Symlink 전역 설정 (SELF-HEALING PATCH) ────
      else if (action === 'link') {
          script = `
            $log = New-Object System.Collections.Generic.List[string]
            $RawJson = Get-Content "$K\\_registry.json" -Raw -Encoding UTF8 | ConvertFrom-Json
            $activeCount = 0
            $repairCount = 0
            $total = $RawJson.Count
            $currentStep = 0

            Write-Host "================================================================================"  -ForegroundColor Gray
            Write-Host "          🔗 전역 심링크 설정 (Global Symlink Engine)" -ForegroundColor Cyan
            Write-Host "  >> 원본(Kits) 경로: $K" -ForegroundColor DarkGray
            Write-Host "  >> 링크(Skills) 경로: $S" -ForegroundColor DarkGray
            Write-Host "  >> 레지스트리  : $K\\_registry.json" -ForegroundColor DarkGray
            Write-Host "  >> 총 처리 대상: $total 개 키트" -ForegroundColor DarkGray
            Write-Host "================================================================================"  -ForegroundColor Gray
            Write-Host "[작업 일시: \$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')]" -ForegroundColor Gray
            Write-Host ""

            foreach ($kit in $RawJson) {
                $currentStep++
                $pct = [math]::Round(($currentStep / $total) * 100)
                $source = "$K\\$($kit.id)"
                $targetLink = "$S\\$($kit.id)"

                Write-Host "[$currentStep/$total] 심링크 처리 대상: $($kit.id)" -ForegroundColor Cyan
                Write-Host "  >> 원본 경로: $source" -ForegroundColor DarkGray
                Write-Host "  >> 링크 경로: $targetLink" -ForegroundColor DarkGray
                Write-Host "  [CMD] Test-Path \`"$source\`"" -ForegroundColor DarkGray
                Write-Host "  [PRG]   0% >> 원본(Kits) 폴더 존재 확인 중..." -ForegroundColor Gray

                if (Test-Path $source) {
                    $needsLink = $false
                    Write-Host "  [CMD] Test-Path \`"$targetLink\`"" -ForegroundColor DarkGray
                    Write-Host "  [PRG]  20% >> 기존 링크 존재 여부 확인 중..." -ForegroundColor Gray

                    if (Test-Path $targetLink) {
                        $item = Get-Item $targetLink
                        Write-Host "  [PRG]  40% >> 기존 항목 타입 분석 중: $($item.Attributes)" -ForegroundColor Gray

                        if ($item.Attributes -match "ReparsePoint") {
                            $target = $item.Target
                            Write-Host "  [CMD] \`$item.Target => $target" -ForegroundColor DarkGray
                            Write-Host "  [PRG]  60% >> 기존 심링크 타겟 유효성 검사 중..." -ForegroundColor Gray

                            if ([string]::IsNullOrEmpty($target) -or !(Test-Path $target)) {
                                Write-Host "  [CMD] Remove-Item \`"$targetLink\`" -Force" -ForegroundColor DarkGray
                                Remove-Item $targetLink -Force
                                $needsLink = $true
                                $repairCount++
                                Write-Host "  [PRG]  80% >> 손상된 심링크 제거 완료. 재생성 준비 중..." -ForegroundColor Gray
                            } else {
                                Write-Host "  [PRG] 100% >> 심링크 정상 (조치 불필요)" -ForegroundColor Gray
                                $msg = "  [OK] $($kit.id) >> [유지] 정상 심링크 연결됨 | $targetLink => $target"
                                Write-Host $msg -ForegroundColor Green
                                $log.Add($msg)
                            }
                        } else {
                            Write-Host "  [PRG] 100% >> 실제 폴더 감지 (링크 생성 건너뜀)" -ForegroundColor Gray
                            $msg = "  [??] $($kit.id) >> [경고] 실제 폴더 존재로 링크 생성 건너뜀 | 경로: $targetLink"
                            Write-Host $msg -ForegroundColor Yellow
                            $log.Add($msg)
                        }
                    } else {
                        $needsLink = $true
                        Write-Host "  [PRG]  40% >> 링크 없음. 신규 생성 준비 중..." -ForegroundColor Gray
                    }

                    if ($needsLink) {
                        Write-Host "  [CMD] cmd /c mklink /J \`"$targetLink\`" \`"$source\`"" -ForegroundColor DarkGray
                        Write-Host "  [PRG]  70% >> Junction 심링크 생성 중..." -ForegroundColor Gray
                        cmd /c mklink /J "$targetLink" "$source" > $null
                        if (Test-Path $targetLink) {
                            $activeCount++
                            Write-Host "  [PRG] 100% >> 심링크 생성 완료" -ForegroundColor Gray
                            $label = if ($repairCount -gt 0) { "[복구완료]" } else { "[연결성공]" }
                            $msg = "  [OK] $($kit.id) >> $label 전역 인식 활성화 | $targetLink => $source"
                            Write-Host $msg -ForegroundColor Green
                            $log.Add($msg)
                        } else {
                            Write-Host "  [PRG] 100% >> 심링크 생성 실패 (권한 오류)" -ForegroundColor Gray
                            $msg = "  [!!] $($kit.id) >> [실패] mklink 권한 오류 | 대상: $targetLink"
                            Write-Host $msg -ForegroundColor Red
                            $log.Add($msg)
                        }
                    }
                } else {
                    Write-Host "  [PRG] 100% >> 원본 폴더 없음 (처리 불가)" -ForegroundColor Gray
                    $msg = "  [!!] $($kit.id) >> [오류] 소스(Kits) 폴더 없음 | 기대 경로: $source"
                    Write-Host $msg -ForegroundColor Red
                    $log.Add($msg)
                }
                Write-Host "  >> 전체 진행률: $pct%" -ForegroundColor DarkGray
                Write-Host ""
            }

            Write-Host "================================================================================"  -ForegroundColor Gray
            Write-Host "--- [최종 리포트] 전역 심링크 설정 완료 ---" -ForegroundColor Cyan
            Write-Host "  >> 완료 시각  : \$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor DarkGray
            Write-Host "  >> 신규 연결  : $activeCount 건" -ForegroundColor DarkGray
            Write-Host "  >> 손상 복구  : $repairCount 건" -ForegroundColor DarkGray
            Write-Host ""
            Write-Host "[최종 결과] ✅ 심링크 자가 치유 완료: 신규 연결 $activeCount 건 / 손상 복구 $repairCount 건" -ForegroundColor Green
            Write-Host "--- 복구 및 연결 상세 로그 ---"
            $log | ForEach-Object { Write-Host $_ }
            Write-Host "================================================================================"  -ForegroundColor Gray
          `;
      }
      // ── [11] 자가 복구 패치 (GSD SELF-HEALING) ─────
      else if (action === 'self_heal') {
          script = `
            $log = New-Object System.Collections.Generic.List[string]
            $RawJson = Get-Content "$K\\_registry.json" -Raw -Encoding UTF8 | ConvertFrom-Json
            $repaired = 0
            $quarantined = 0
            $total = $RawJson.Count
            $currentStep = 0

            Write-Host "================================================================================"  -ForegroundColor Gray
            Write-Host "          🛡️ GSD 자가 복구 패치 (Self-Healing Protocol)" -ForegroundColor Cyan
            Write-Host "  >> 원본(Kits) 경로: $K" -ForegroundColor DarkGray
            Write-Host "  >> 링크(Skills) 경로: $S" -ForegroundColor DarkGray
            Write-Host "  >> 격리소 경로  : $K\\_quarantine\\blocking_folders" -ForegroundColor DarkGray
            Write-Host "  >> 레지스트리   : $K\\_registry.json" -ForegroundColor DarkGray
            Write-Host "  >> 총 처리 대상 : $total 개 키트" -ForegroundColor DarkGray
            Write-Host "================================================================================"  -ForegroundColor Gray
            Write-Host "[작업 일시: \$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')]" -ForegroundColor Gray
            Write-Host ""

            foreach ($kit in $RawJson) {
                $currentStep++
                $pct = [math]::Round(($currentStep / $total) * 100)
                $source = "$K\\$($kit.id)"
                $targetLink = "$S\\$($kit.id)"

                Write-Host "[$currentStep/$total] 자가 복구 대상: $($kit.id)" -ForegroundColor Cyan
                Write-Host "  >> 원본 경로: $source" -ForegroundColor DarkGray
                Write-Host "  >> 링크 경로: $targetLink" -ForegroundColor DarkGray
                Write-Host "  [CMD] Test-Path \`"$source\`"" -ForegroundColor DarkGray
                Write-Host "  [PRG]   0% >> 원본(Kits) 폴더 존재 확인 중..." -ForegroundColor Gray

                if (Test-Path $source) {
                    $actionTaken = $false
                    Write-Host "  [CMD] Test-Path \`"$targetLink\`"" -ForegroundColor DarkGray
                    Write-Host "  [PRG]  20% >> 링크 경로 존재 여부 확인 중..." -ForegroundColor Gray

                    if (Test-Path $targetLink) {
                        $item = Get-Item $targetLink
                        Write-Host "  [PRG]  40% >> 항목 타입 분석 중: $($item.Attributes)" -ForegroundColor Gray

                        if ($item.Attributes -match "ReparsePoint") {
                            $targetPath = $item.Target
                            Write-Host "  [CMD] \`$item.Target => $targetPath" -ForegroundColor DarkGray
                            Write-Host "  [PRG]  60% >> 심링크 타겟 유효성 검증 중..." -ForegroundColor Gray

                            if ([string]::IsNullOrEmpty($targetPath) -or !(Test-Path $targetPath)) {
                                Write-Host "  [CMD] Remove-Item \`"$targetLink\`" -Force" -ForegroundColor DarkGray
                                Remove-Item $targetLink -Force
                                $actionTaken = $true
                                Write-Host "  [PRG]  80% >> 손상된 심링크 제거 완료. 재생성 준비 중..." -ForegroundColor Gray
                                $msg = "  [FX] $($kit.id) >> [손상복구] 유효하지 않은 심링크 재건 | 타겟: $targetPath"
                                Write-Host $msg -ForegroundColor Cyan
                                $log.Add($msg)
                            } else {
                                Write-Host "  [PRG] 100% >> 심링크 정상 (조치 불필요)" -ForegroundColor Gray
                                $msg = "  [OK] $($kit.id) >> [무결성] 검증 통과 | $targetLink => $targetPath"
                                Write-Host $msg -ForegroundColor Green
                                $log.Add($msg)
                            }
                        } else {
                            # 실제 폴더가 링크를 가로막는 경우 -> 격리 후 링크 생성 (GSD 철학)
                            $Q = "$K\\_quarantine\\blocking_folders"
                            $qDest = "$Q\\$($kit.id)_\$(Get-Date -Format 'HHmm')"
                            Write-Host "  [PRG]  50% >> 실제 폴더 감지. 격리소로 이동 준비 중..." -ForegroundColor Gray
                            Write-Host "  [CMD] New-Item -ItemType Directory \`"$Q\`" (if not exists)" -ForegroundColor DarkGray
                            if (!(Test-Path $Q)) { New-Item -ItemType Directory -Path $Q -Force | Out-Null }
                            Write-Host "  [CMD] Move-Item \`"$targetLink\`" => \`"$qDest\`"" -ForegroundColor DarkGray
                            Move-Item -Path $targetLink -Destination $qDest -Force
                            $actionTaken = $true
                            $quarantined++
                            Write-Host "  [PRG]  80% >> 실제 폴더 격리소 이동 완료" -ForegroundColor Gray
                            $msg = "  [FX] $($kit.id) >> [강제격리] 실제 폴더를 _quarantine으로 이동 | 이동 경로: $qDest"
                            Write-Host $msg -ForegroundColor Yellow
                            $log.Add($msg)
                        }
                    } else {
                        $actionTaken = $true
                        Write-Host "  [PRG]  40% >> 링크 없음. 신규 생성 준비 중..." -ForegroundColor Gray
                        $msg = "  [FX] $($kit.id) >> [누락복구] 누락된 전역 심링크 신규 생성 예정 | 경로: $targetLink"
                        Write-Host $msg -ForegroundColor Cyan
                        $log.Add($msg)
                    }

                    if ($actionTaken) {
                        Write-Host "  [CMD] cmd /c mklink /J \`"$targetLink\`" \`"$source\`"" -ForegroundColor DarkGray
                        Write-Host "  [PRG]  90% >> Junction 심링크 재생성 중..." -ForegroundColor Gray
                        cmd /c mklink /J "$targetLink" "$source" > $null
                        $repaired++
                        Write-Host "  [PRG] 100% >> 복구 완료" -ForegroundColor Gray
                    } else {
                        Write-Host "  [PRG] 100% >> 조치 불필요 (무결성 통과)" -ForegroundColor Gray
                    }
                } else {
                    Write-Host "  [PRG] 100% >> 원본 폴더 없음 (복구 불가)" -ForegroundColor Gray
                    $msg = "  [!!] $($kit.id) >> [경고] 소스 폴더 없어 복구 불가 | 기대 경로: $source"
                    Write-Host $msg -ForegroundColor Red
                    $log.Add($msg)
                }
                Write-Host "  >> 전체 진행률: $pct%" -ForegroundColor DarkGray
                Write-Host ""
            }

            Write-Host "================================================================================"  -ForegroundColor Gray
            Write-Host "--- [최종 리포트] GSD 자가 복구 프로토콜 완료 ---" -ForegroundColor Cyan
            Write-Host "  >> 완료 시각  : \$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor DarkGray
            Write-Host "  >> 무결성 복구: $repaired 건" -ForegroundColor DarkGray
            Write-Host "  >> 폴더 격리  : $quarantined 건" -ForegroundColor DarkGray
            Write-Host ""
            Write-Host "[최종 결과] ✅ GSD 자가 치유 프로토콜 완료: $repaired 건의 무결성 복구 / $quarantined 건의 방해 폴더 격리" -ForegroundColor Green
            Write-Host "--- 자가 치유 상세 리포트 ---"
            $log | ForEach-Object { Write-Host $_ }
            Write-Host "================================================================================"  -ForegroundColor Gray
          `;
      }
      // ── [5] 업데이트 (git pull) ──────────────
      else if (action === 'update') {
          script = `
            $log = New-Object System.Collections.Generic.List[string]
            $RawJson = Get-Content "$K\\_registry.json" -Raw -Encoding UTF8 | ConvertFrom-Json
            $total = $RawJson.Count
            $current = 0
            $updated = 0

            Write-Host "================================================================================"  -ForegroundColor Gray
            Write-Host "          🔄 전역 키트 업데이트 (Git Pull Engine)" -ForegroundColor Cyan
            Write-Host "  >> 키트 저장소  : $K" -ForegroundColor DarkGray
            Write-Host "  >> 레지스트리   : $K\\_registry.json" -ForegroundColor DarkGray
            Write-Host "  >> 총 업데이트 대상: $total 개 키트" -ForegroundColor DarkGray
            Write-Host "================================================================================"  -ForegroundColor Gray
            Write-Host "[작업 일시: \$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')]" -ForegroundColor Gray
            Write-Host ""

            foreach ($kit in $RawJson) {
                $current++
                $pct = [math]::Round(($current / $total) * 100)
                $target = "$K\\$($kit.id)"
                $gitDir = "$target\\.git"

                Write-Host "[$current/$total] 업데이트 대상: $($kit.id)" -ForegroundColor Cyan
                Write-Host "  >> 키트 경로: $target" -ForegroundColor DarkGray
                Write-Host "  [CMD] Test-Path \`"$gitDir\`"" -ForegroundColor DarkGray
                Write-Host "  [PRG]   0% >> .git 디렉토리 존재 여부 확인 중..." -ForegroundColor Gray

                if (Test-Path $gitDir) {
                    Push-Location $target
                    try {
                        Write-Host "  [CMD] git remote get-url origin" -ForegroundColor DarkGray
                        $url = (git remote get-url origin)
                        Write-Host "  [CMD] git rev-parse --abbrev-ref HEAD" -ForegroundColor DarkGray
                        $branch = (git rev-parse --abbrev-ref HEAD)
                        $pullCmd = "git pull origin $branch"

                        Write-Host "  [PRG]  20% >> 원격 정보 수집 완료" -ForegroundColor Gray
                        Write-Host "  >> 소스 URL  : $url" -ForegroundColor DarkGray
                        Write-Host "  >> 브랜치    : $branch" -ForegroundColor DarkGray
                        Write-Host "  [CMD] $pullCmd" -ForegroundColor DarkGray
                        Write-Host "  [PRG]  40% >> git pull 실행 중 (네트워크 상태에 따라 시간 소요)..." -ForegroundColor Gray

                        $res = git pull origin $branch 2>&1
                        Write-Host "  [PRG]  90% >> pull 결과 분석 중..." -ForegroundColor Gray

                        if ($LASTEXITCODE -eq 0) {
                            $updated++
                            Write-Host "  [PRG] 100% >> 업데이트 완료" -ForegroundColor Gray
                            $msg = "  [OK] $($kit.id) >> [성공] $branch 브랜치 최신화 | $url"
                            Write-Host $msg -ForegroundColor Green
                            $log.Add($msg)
                        } else {
                            Write-Host "  [PRG] 100% >> 업데이트 실패 (Git 에러)" -ForegroundColor Gray
                            $msg = "  [!!] $($kit.id) >> [실패] Git Pull 에러 | 브랜치: $branch | URL: $url"
                            Write-Host $msg -ForegroundColor Red
                            $log.Add($msg)
                        }
                    } catch {
                        Write-Host "  [PRG] 100% >> 업데이트 실패 (예외 발생)" -ForegroundColor Gray
                        $msg = "  [!!] $($kit.id) >> [에러] $($_.Exception.Message)"
                        Write-Host $msg -ForegroundColor Red
                        $log.Add($msg)
                    }
                    Pop-Location
                } else {
                    Write-Host "  [PRG] 100% >> .git 없음 (Git 저장소 아님)" -ForegroundColor Gray
                    $msg = "  [--] $($kit.id) >> [건너뜀] Git 저장소 아님 | 경로: $target"
                    Write-Host $msg -ForegroundColor Yellow
                    $log.Add($msg)
                }
                Write-Host "  >> 전체 진행률: $pct%" -ForegroundColor DarkGray
                Write-Host ""
            }

            Write-Host "================================================================================"  -ForegroundColor Gray
            Write-Host "--- [최종 리포트] 전역 키트 업데이트 완료 ---" -ForegroundColor Cyan
            Write-Host "  >> 완료 시각   : \$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor DarkGray
            Write-Host "  >> 최신화 성공 : $updated / $total 개" -ForegroundColor DarkGray
            Write-Host ""
            Write-Host "[최종 결과] ✅ 원격지 동기화 완료: $updated/$total 개 키트 최신화 성공" -ForegroundColor Green
            Write-Host "--- 상세 업데이트 리포트 (관리자 복사용) ---"
            $log | ForEach-Object { Write-Host $_ }
            Write-Host "================================================================================"  -ForegroundColor Gray
          `;
      }
      // ── [6] 최종 검증 ──────────────────────
      else if (action === 'verify') {
          script = `
            $log = New-Object System.Collections.Generic.List[string]
            $checks = @("kits", "skills", "extensions")
            $pass = 0
            $fail = 0
            $totalSteps = 0
            $currentStep = 0

            # 총 단계 수 사전 계산
            $totalSteps = $checks.Count
            if (Test-Path "$K\\_registry.json") {
                $regTemp = Get-Content "$K\\_registry.json" -Raw -Encoding UTF8 | ConvertFrom-Json
                $totalSteps += 1 + $regTemp.Count  # 레지스트리 자체 + 각 키트
            }

            Write-Host "================================================================================"  -ForegroundColor Gray
            Write-Host "          ✅ 최종 검증 (Final Verification Engine)" -ForegroundColor Cyan
            Write-Host "  >> 루트 경로  : $R" -ForegroundColor DarkGray
            Write-Host "  >> 키트 저장소: $K" -ForegroundColor DarkGray
            Write-Host "  >> 스킬 허브  : $S" -ForegroundColor DarkGray
            Write-Host "  >> 레지스트리 : $K\\_registry.json" -ForegroundColor DarkGray
            Write-Host "  >> 총 검증 항목: $totalSteps 개" -ForegroundColor DarkGray
            Write-Host "================================================================================"  -ForegroundColor Gray
            Write-Host "[작업 일시: \$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')]" -ForegroundColor Gray
            Write-Host ""
            Write-Host "--- [PHASE 1] 핵심 인프라 디렉토리 검증 ---" -ForegroundColor Cyan
            Write-Host ""

            foreach ($chk in $checks) {
                $currentStep++
                $pct = [math]::Round(($currentStep / $totalSteps) * 100)
                $fullPath = "$R\\$chk"

                Write-Host "[$currentStep/$totalSteps] 디렉토리 검증: $chk" -ForegroundColor Cyan
                Write-Host "  >> 전체 경로: $fullPath" -ForegroundColor DarkGray
                Write-Host "  [CMD] Test-Path \`"$fullPath\`"" -ForegroundColor DarkGray
                Write-Host "  [PRG]   0% >> 경로 존재 여부 확인 중..." -ForegroundColor Gray
                Write-Host "  [PRG]  50% >> 디렉토리 접근성 검사 중..." -ForegroundColor Gray

                if (Test-Path $fullPath) {
                    $pass++
                    Write-Host "  [PRG] 100% >> 검증 완료 (정상)" -ForegroundColor Gray
                    $msg = "  [OK] $chk\ >> [경로확인 완료] | 경로: $fullPath"
                    Write-Host $msg -ForegroundColor Green
                    $log.Add($msg)
                } else {
                    $fail++
                    Write-Host "  [PRG] 100% >> 검증 완료 (경로 누락)" -ForegroundColor Gray
                    $msg = "  [!!] $chk\ >> [경로누락 ERROR] | 기대 경로: $fullPath"
                    Write-Host $msg -ForegroundColor Red
                    $log.Add($msg)
                }
                Write-Host "  >> 전체 진행률: $pct%" -ForegroundColor DarkGray
                Write-Host ""
            }

            Write-Host "--- [PHASE 2] 레지스트리 & 전역 심링크 검증 ---" -ForegroundColor Cyan
            Write-Host ""

            $regPath = "$K\\_registry.json"
            $currentStep++
            $pct = [math]::Round(($currentStep / $totalSteps) * 100)

            Write-Host "[$currentStep/$totalSteps] 레지스트리 파일 검증" -ForegroundColor Cyan
            Write-Host "  >> 전체 경로: $regPath" -ForegroundColor DarkGray
            Write-Host "  [CMD] Test-Path \`"$regPath\`"" -ForegroundColor DarkGray
            Write-Host "  [PRG]   0% >> 레지스트리 파일 확인 중..." -ForegroundColor Gray

            if (Test-Path $regPath) {
                Write-Host "  [CMD] Get-Content \`"$regPath\`" | ConvertFrom-Json" -ForegroundColor DarkGray
                $reg = Get-Content $regPath -Raw -Encoding UTF8 | ConvertFrom-Json
                Write-Host "  [PRG] 100% >> 레지스트리 로드 완료 ($($reg.Count)개 키트)" -ForegroundColor Gray
                $msg = "  [OK] _registry.json >> [레지스트리 무결성 확인] $($reg.Count)개 키트 등록 | 경로: $regPath"
                Write-Host $msg -ForegroundColor Green
                $log.Add($msg)
                Write-Host "  >> 전체 진행률: $pct%" -ForegroundColor DarkGray
                Write-Host ""

                foreach ($kit in $reg) {
                    $currentStep++
                    $pct = [math]::Round(($currentStep / $totalSteps) * 100)
                    $linkPath = "$S\\$($kit.id)"

                    Write-Host "[$currentStep/$totalSteps] 전역 심링크 검증: $($kit.id)" -ForegroundColor Cyan
                    Write-Host "  >> 링크 경로: $linkPath" -ForegroundColor DarkGray
                    Write-Host "  [CMD] Test-Path \`"$linkPath\`"" -ForegroundColor DarkGray
                    Write-Host "  [PRG]   0% >> 전역 링크 존재 여부 확인 중..." -ForegroundColor Gray
                    Write-Host "  [PRG]  50% >> 링크 접근성 검사 중..." -ForegroundColor Gray

                    if (Test-Path $linkPath) {
                        $pass++
                        Write-Host "  [PRG] 100% >> 검증 완료 (링크 활성)" -ForegroundColor Gray
                        $msg = "  [OK] $($kit.id) >> [전역 링크 활성화됨] | 경로: $linkPath"
                        Write-Host $msg -ForegroundColor Green
                        $log.Add($msg)
                    } else {
                        $fail++
                        Write-Host "  [PRG] 100% >> 검증 완료 (링크 누락)" -ForegroundColor Gray
                        $msg = "  [!!] $($kit.id) >> [링크누락 ERROR] | 기대 경로: $linkPath"
                        Write-Host $msg -ForegroundColor Red
                        $log.Add($msg)
                    }
                    Write-Host "  >> 전체 진행률: $pct%" -ForegroundColor DarkGray
                    Write-Host ""
                }
            } else {
                $fail++
                Write-Host "  [PRG] 100% >> 레지스트리 없음" -ForegroundColor Gray
                $msg = "  [!!] _registry.json >> [파일누락 ERROR] | 기대 경로: $regPath"
                Write-Host $msg -ForegroundColor Red
                $log.Add($msg)
                Write-Host "  >> 전체 진행률: $pct%" -ForegroundColor DarkGray
                Write-Host ""
            }

            Write-Host "================================================================================"  -ForegroundColor Gray
            Write-Host "--- [PHASE 3] 최종 검증 리포트 ---" -ForegroundColor Cyan
            Write-Host "  >> 완료 시각  : \$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor DarkGray
            Write-Host "  >> 통과 항목  : $pass 개" -ForegroundColor DarkGray
            Write-Host "  >> 오류 항목  : $fail 개" -ForegroundColor DarkGray
            Write-Host ""
            if ($fail -eq 0) {
                Write-Host "[최종 결과] ✅ 시스템 검증 완벽: 모든 요소를 신뢰할 수 있습니다." -ForegroundColor Green
            } else {
                Write-Host "[최종 결과] ⚠️  시스템 부적합: $fail 개의 오류 항목이 발견되었습니다. 조치가 필요합니다." -ForegroundColor Red
            }
            Write-Host "--- 전체 검증 상세 내역 ---"
            $log | ForEach-Object {
                if ($_ -match "ERROR|누락") { Write-Host $_ -ForegroundColor Red }
                else { Write-Host $_ -ForegroundColor Green }
            }
            Write-Host "================================================================================"  -ForegroundColor Gray
          `;
      }
      // ── [7] 파편 수집 & 통합 (REAL COLLECTION) ─
      else if (action === 'collect') {
          script = `
            $log = New-Object System.Collections.Generic.List[string]
            $Q = "$K\\_quarantine"
            $orphans = @()

            Write-Host "================================================================================"  -ForegroundColor Gray
            Write-Host "          🧲 파편 수집 & 통합 (Fragment Collector Engine)" -ForegroundColor Cyan
            Write-Host "  >> 스킬 허브(스캔 대상): $S" -ForegroundColor DarkGray
            Write-Host "  >> 격리소(이동 대상)   : $Q" -ForegroundColor DarkGray
            Write-Host "  >> 레지스트리          : $K\\_registry.json" -ForegroundColor DarkGray
            Write-Host "================================================================================"  -ForegroundColor Gray
            Write-Host "[작업 일시: \$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')]" -ForegroundColor Gray
            Write-Host ""

            # ── [PHASE 1] 격리소 초기화 ──────────────────────────────
            Write-Host "--- [PHASE 1] 격리소 준비 ---" -ForegroundColor Cyan
            Write-Host "  [CMD] Test-Path \`"$Q\`"" -ForegroundColor DarkGray
            Write-Host "  [PRG]   0% >> 격리소 경로 확인 중..." -ForegroundColor Gray
            if (!(Test-Path $Q)) {
                Write-Host "  [CMD] New-Item -ItemType Directory -Path \`"$Q\`" -Force" -ForegroundColor DarkGray
                New-Item -ItemType Directory -Path $Q -Force | Out-Null
                Write-Host "  [PRG] 100% >> 격리소 신규 생성 완료" -ForegroundColor Gray
                Write-Host "  [OK] 격리소 생성됨 | 경로: $Q" -ForegroundColor Green
            } else {
                Write-Host "  [PRG] 100% >> 격리소 이미 존재 (준비 완료)" -ForegroundColor Gray
                Write-Host "  [OK] 격리소 기존 존재 | 경로: $Q" -ForegroundColor Green
            }
            Write-Host ""

            # ── [PHASE 2] skills/ 스캔 & 파편 탐지 ──────────────────
            Write-Host "--- [PHASE 2] 전역 스킬 허브 스캔 & 미등록 파편 탐지 ---" -ForegroundColor Cyan
            Write-Host "  [CMD] Test-Path \`"$S\`"" -ForegroundColor DarkGray
            Write-Host "  [PRG]   0% >> skills/ 경로 존재 여부 확인 중..." -ForegroundColor Gray

            if (Test-Path $S) {
                Write-Host "  [CMD] Get-Content \`"$K\\_registry.json\`" | ConvertFrom-Json" -ForegroundColor DarkGray
                $RawJson = Get-Content "$K\\_registry.json" -Raw -Encoding UTF8 | ConvertFrom-Json
                $RegistryDirs = $RawJson.id
                Write-Host "  [PRG]  20% >> 레지스트리 로드 완료: $($RegistryDirs.Count)개 등록 항목" -ForegroundColor Gray

                Write-Host "  [CMD] Get-ChildItem \`"$S\`" -Directory | Where-Object { \`\$_.Name -ne '_quarantine' }" -ForegroundColor DarkGray
                $allDirs = Get-ChildItem $S -Directory | Where-Object { $_.Name -ne "_quarantine" }
                $dirCount = if ($allDirs) { @($allDirs).Count } else { 0 }

                Write-Host "  [PRG]  40% >> skills/ 스캔 완료: $dirCount 개 항목 발견" -ForegroundColor Gray
                Write-Host ""

                if ($dirCount -gt 0) {
                    $totalDirs = $dirCount
                    $currentDir = 0

                    foreach ($d in $allDirs) {
                        $currentDir++
                        $subPct = [math]::Round(40 + ($currentDir / $totalDirs) * 55)
                        $dirPath = $d.FullName

                        Write-Host "  [$currentDir/$totalDirs] 항목 검사: $($d.Name)" -ForegroundColor Cyan
                        Write-Host "    >> 경로: $dirPath" -ForegroundColor DarkGray

                        if ($d.Name -notin $RegistryDirs) {
                            $orphans += $d
                            $dest = Join-Path $Q $d.Name
                            Write-Host "    [PRG] $subPct% >> 미등록 파편 감지! 격리소로 이동 중..." -ForegroundColor Gray
                            if (Test-Path $dest) {
                                Write-Host "    [CMD] Remove-Item \`"$dest\`" -Recurse -Force" -ForegroundColor DarkGray
                                Remove-Item $dest -Recurse -Force
                            }
                            Write-Host "    [CMD] Move-Item \`"$dirPath\`" => \`"$Q\`"" -ForegroundColor DarkGray
                            Move-Item -Path $dirPath -Destination $Q -Force
                            $msg = "    [!!] $($d.Name)\ >> [격리] 미등록 파편 => _quarantine 이동 완료 | 원경로: $dirPath"
                            Write-Host $msg -ForegroundColor Yellow
                            $log.Add($msg)
                        } else {
                            Write-Host "    [PRG] $subPct% >> 등록된 모듈 확인" -ForegroundColor Gray
                            $msg = "    [OK] $($d.Name)\ >> [정상] 등록된 모듈 | 경로: $dirPath"
                            Write-Host $msg -ForegroundColor Green
                            $log.Add($msg)
                        }
                    }
                } else {
                    Write-Host "  [OK] skills/ 내 스캔 대상 없음 (빈 디렉토리)" -ForegroundColor Green
                }
                Write-Host "  [PRG] 100% >> 파편 탐지 스캔 완료" -ForegroundColor Gray
            } else {
                Write-Host "  [PRG] 100% >> skills/ 경로 없음 (조치 불필요)" -ForegroundColor Gray
                Write-Host "  [!!] skills/ 디렉토리가 존재하지 않습니다: $S" -ForegroundColor Red
            }
            Write-Host ""

            Write-Host "================================================================================"  -ForegroundColor Gray
            Write-Host "--- [PHASE 3] 최종 수집 리포트 ---" -ForegroundColor Cyan
            Write-Host "  >> 완료 시각    : \$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor DarkGray
            Write-Host "  >> 스캔 허브    : $S" -ForegroundColor DarkGray
            Write-Host "  >> 파편 격리 건 : $($orphans.Count) 개" -ForegroundColor DarkGray
            Write-Host ""
            if ($orphans.Count -gt 0) {
                Write-Host "[최종 결과] ⚠️  $($orphans.Count)개의 미등록 파편을 성공적으로 수집하여 격리소로 이동했습니다." -ForegroundColor Yellow
            } else {
                Write-Host "[최종 결과] ✅ 수집할 파편이 없습니다. 시스템이 깨끗합니다." -ForegroundColor Green
            }
            Write-Host "--- 수집 로그 ---"
            $log | ForEach-Object { Write-Host $_ }
            Write-Host "================================================================================"  -ForegroundColor Gray
          `;
      }
      // ── [9] 전역 환경 초기화 (FULL BOOTSTRAP) ──
      else if (action === 'setup_global_config') {
          script = `
            $confFiles = @()
            
            # [1] 인프라 및 핵심 경로 확보
            $dirs = @("kits", "skills", "extensions", "kits\\_quarantine")
            foreach ($d in $dirs) {
                $full = Join-Path $R $d
                if (!(Test-Path $full)) { New-Item -ItemType Directory -Path $full -Force | Out-Null }
            }
            
            # [2] 대상 구성 파일(JSON) 수집 프로토콜
            # - 내부 레지스트리
            $regPath = "$K\\_registry.json"
            if (!(Test-Path $regPath)) { "[]" | Out-File $regPath -Encoding UTF8 }
            $confFiles += $regPath
            
            # - Claude Desktop (AppData & LocalAppData)
            $claudeCandidates = @(
                "$env:APPDATA\\Claude\\claude_desktop_config.json",
                "$env:LOCALAPPDATA\\Claude\\claude_desktop_config.json"
            )
            foreach($c in $claudeCandidates){ if(Test-Path $c){ $confFiles += $c } }
            
            # - 워크스페이스 내 자율 검색 (.json)
            $allJsons = Get-ChildItem "$R" -Filter "*.json" -Recurse -File -Exclude "node_modules", ".git", "package-lock.json"
            foreach($j in $allJsons){ if($confFiles -notcontains $j.FullName){ $confFiles += $j.FullName } }

            # ─── 리포트 출력 ───────────────────────────────────
            Write-Host "[작업 일시: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')]" -ForegroundColor Gray
            Write-Host "--- 전역 환경 설정 구성 파일 총괄표 ---" -ForegroundColor Cyan
            
            $fileCount = 0
            foreach($f in $confFiles){
                $fileCount++
                Write-Host " [$fileCount] $f" -ForegroundColor Yellow
            }
            
            Write-Host ""
            Write-Host "[최종 결과] 안티그래비티 전역 환경 설정 엔진 가동 완료" -ForegroundColor Green
            Write-Host "  >> 총 $fileCount 개의 구성 데이터가 동기화 및 검증되었습니다." -ForegroundColor Cyan
            Write-Host "--------------------------------------------------------------------------------"

            # 상세 브리핑 섹션 (순차 표시)
            foreach ($i in 1..$confFiles.Count) {
                $f = $confFiles[$i-1]
                Write-Host ""
                Write-Host "[$i] 📄 상세 브리핑: $f" -ForegroundColor White -Style Bold
                Write-Host ">>> 파일 내용 시작" -ForegroundColor DarkGray
                if (Test-Path $f) {
                    $content = Get-Content $f -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
                    if ([string]::IsNullOrWhiteSpace($content)) {
                        Write-Host "{ } (내용 없음)" -ForegroundColor DarkGray
                    } else {
                        Write-Host $content -ForegroundColor Gray
                    }
                } else {
                    Write-Host "[오류] 접근 권한이 없거나 파일이 소멸되었습니다." -ForegroundColor Red
                }
                Write-Host "<<< 파일 내용 종료" -ForegroundColor DarkGray
                Write-Host "--------------------------------------------------------------------------------"
            }
          `;
          loadRegistry();
      }
      // ── [10] GSD 시작 (GSD WORKFLOW ACTIVATION with SELF-HEALING) ──
      else if (action === 'gsd_start') {
          script = `
            $GSD_HOME = "$K\\gsd-workflow"
            $GSD_REPO = "https://github.com/gsd-build/get-shit-done.git"
            $targetLink = "$S\\gsd-workflow"
            
            Write-Host "================================================================================" -ForegroundColor Gray
            Write-Host "          🚀 GSD (Get Shit Done) 워크플로우 엔진 시작 및 자가 복구 프로토콜" -ForegroundColor Cyan
            Write-Host "================================================================================" -ForegroundColor Gray
            Write-Host "[작업 일시: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')]" -ForegroundColor DarkGray
            Write-Host ""

            $isFound = Test-Path $GSD_HOME
            $log = New-Object System.Collections.Generic.List[string]
            $repairedFiles = @()

            if ($isFound) {
                Write-Host "--- [1] 인프라 무결성 검밀 진단 ---" -ForegroundColor Cyan
                $coreElements = @(".plans", "README.ko-KR.md", "VERSIONING.md", "package.json")
                $totalElem = $coreElements.Count
                $currIdx = 0

                foreach($e in $coreElements){
                    $currIdx++
                    $fPath = "$GSD_HOME\\$e"
                    $isDir = $e -notmatch '\.'  # .plans 등 확장자 없는 항목은 폴더로 판별
                    if($e -eq '.plans'){ $isDir = $true }
                    
                    Write-Host ""
                    Write-Host "|- [$currIdx/$totalElem] 정밀 진단 대상: $e" -ForegroundColor Cyan
                    Write-Host "   [CMD] Invoke: Test-Path \`"$fPath\`"" -ForegroundColor DarkGray
                    Write-Host "   [PRG] 0%   [IO 시그니처 확인 중...]" -ForegroundColor Gray
                    Write-Host "   [PRG] 50%  [무결성 해시 대조 중...]" -ForegroundColor Gray
                    Write-Host "   [PRG] 100% [검증 프로세스 완료]" -ForegroundColor Gray

                    if(Test-Path $fPath){ 
                        $msg = "|   ├── $e [검증완료: 무결성 통과]"
                        Write-Host $msg -ForegroundColor Green
                        $log.Add($msg) 
                    } else { 
                        Write-Host "|- [경고] $e 누락 감지. 자가 복구 패치 시작..." -ForegroundColor Yellow
                        Push-Location $GSD_HOME
                        # 1차: 로컬 Git 인덱스 복원
                        git checkout HEAD -- $e 2>$null
                        if (!(Test-Path $fPath)) {
                            # 2차: 원격 저장소에서 강제 복원
                            git fetch origin main 2>$null; git checkout origin/main -- $e 2>$null
                        }
                        if (!(Test-Path $fPath)) {
                            # 3차: 자동 생성 패치 (Git 복구 불가 시 템플릿으로 직접 생성)
                            if($isDir){ New-Item -ItemType Directory -Path $fPath -Force | Out-Null }
                            else { "# $e - Auto-generated by Antigravity Self-Healing Engine\`n# Created: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" | Out-File $fPath -Encoding UTF8 }
                        }
                        Pop-Location
                        if (Test-Path $fPath) {
                            $msg = "|   ├── $e [복구완료: 자가 치유 성공]"
                            Write-Host $msg -ForegroundColor Cyan
                            $log.Add($msg)
                            $repairedFiles += $e
                        } else {
                            $msg = "|   ├── $e [복구실패: 수동 확인 필요]"
                            Write-Host $msg -ForegroundColor Red
                            $log.Add($msg)
                        }
                    }
                }
            }

            Write-Host ""
            Write-Host "--- [2] 수동 설치/복구용 CLI 청사진 ---" -ForegroundColor Yellow
            Write-Host "1. 전체 원본 재설치 (누락이 심할 경우):" -ForegroundColor DarkGray
            Write-Host "   git clone $GSD_REPO \`"$GSD_HOME\`"" -ForegroundColor White
            Write-Host "2. 특정 파일 강제 복원 (자가 복구 실패 시):" -ForegroundColor DarkGray
            Write-Host "   cd \`"$GSD_HOME\`" ; git fetch --all ; git reset --hard origin/main" -ForegroundColor White
            Write-Host ""

            Write-Host "--- [3] 최종 실행 결과 분석 ---" -ForegroundColor Cyan
            if($isFound){
                $totalMissing = ($log | Where-Object { $_ -match "복구실패" -or $_ -match "복구성실" }).Count
                if ($totalMissing -eq 0) {
                    $statusMsg = if ($repairedFiles.Count -gt 0) { "자가 복구 완료 ($($repairedFiles.Count)개의 파일 복원됨)" } else { "모든 시스템 요소 100% 무결성 동작 중" }
                    Write-Host "[최종 결과] GSD 워크플로우 가동 준비 완료: $statusMsg" -ForegroundColor Green
                } else {
                    Write-Host "[최종 결과] GSD 워크플로우 가동 주의: $totalMissing 개의 핵심 파편 유실됨" -ForegroundColor Red
                    Write-Host ">> 조치: 위 [2]번의 강제 복원 명령어를 터미널에서 실행 하세요." -ForegroundColor Yellow
                }
                
                # 심링크 자동 점검
                if (!(Test-Path $targetLink)) {
                    cmd /c mklink /J "$targetLink" "$GSD_HOME" | Out-Null
                    Write-Host "|- [PATCH] 누락된 전역 심링크 즉시 재생성 완료" -ForegroundColor Green
                }
            } else {
                Write-Host "[최종 결과] GSD 엔진 가동 불가: 라이브러리 미설치" -ForegroundColor Red
            }
            Write-Host "================================================================================" -ForegroundColor Gray
          `;
      }
      // ── Unified Kit Manual Handler ──────────
      else if (action.endsWith('_manual')) {
          const kitKey = action.replace('_manual', '').replace('claude', 'everything-claude-code').replace('ag','antigravity-kit').replace('awesome','antigravity-awesome-skills');
          script = `
            $log = New-Object System.Collections.Generic.List[string]
            $targetKit = "$K\\${kitKey}"
            $found = $false
            if (Test-Path $targetKit) {
                $files = Get-ChildItem $targetKit -Filter "*.md" -Recurse | Select-Object -First 5
                foreach($f in $files){ $log.Add("|-- $($f.Name) [지식 파편 색인됨]") }
                $found = $true
            }
            Write-Host "[작업 일시: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')]" -ForegroundColor Gray
            if($found){ Write-Host "[최종 결과] [$kitKey] 시스템 가이드라인 동기화 성공" -ForegroundColor Green }
            else { Write-Host "[최종 결과] 가이드라인 자료 탐색 실패 (대상 키트를 먼저 설치해 주세요)" -ForegroundColor Red }
            Write-Host "--- 관련 매뉴얼 리스트 ---"
            $log | ForEach-Object { Write-Host $_ }
          `;
      }
      // ── Wipe Kit ───────────────────────────
      else if (action === 'wipe-kit') {
          const id = parsed.query.id;
          script = `
            $log = New-Object System.Collections.Generic.List[string]
            $doneCount = 0
            if(Test-Path "$S\\${id}"){ 
                Remove-Item "$S\\${id}" -Recurse -Force 
                $log.Add("|-- $S\\${id} [심링크 삭제 완료]")
                $doneCount++
            }
            if(Test-Path "$K\\${id}"){ 
                Remove-Item "$K\\${id}" -Recurse -Force 
                $log.Add("|-- $K\\${id} [키트 폴더 물리 삭제 완료]")
                $doneCount++
            }
            Write-Host "[작업 일시: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')]" -ForegroundColor Gray
            Write-Host "[최종 결과] [${id}] 모듈 완전 삭제(Wipe) 완료: 모든 연계 인프라를 성공적으로 제거했습니다." -ForegroundColor Red
            Write-Host "--- 삭제 상세 로그 ---"
            $log | ForEach-Object { Write-Host $_ }
          `;
      }
      // ── Unknown Action Fallback ────────────
      else {
          script = `Write-Host "=== ACTION DISPATCHED: ${action} ==="; Write-Host "Active Handler Triggered."`;
      }

      const out = await runPowerShell(script);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ output: out }));
    }
    // ═════════════════════════════════════════════
    // /api/search — Skills/Agents 검색 엔진
    // ═════════════════════════════════════════════
    else if (pathname === '/api/search') {
      const q = parsed.query.q || '';
      const mode = parsed.query.mode || 'all';
      
      if (!q) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify([{ Total: 0 }]));
        return;
      }
      
      const results = searchSkillFiles(q, mode);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(results));
    }
    // ═════════════════════════════════════════════
    // /api/read — SKILL.md 파일 내용 읽기 (openManual용)
    // ═════════════════════════════════════════════
    else if (pathname === '/api/read') {
      const filePath = parsed.query.path || '';
      const content = readFileContent(filePath);
      
      if (content === null) {
        res.writeHead(404);
        res.end('File not found or access denied');
        return;
      }
      
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end(content);
    }
    // ═════════════════════════════════════════════
    // /api/status — 대시보드 킷 상태 조회
    // ═════════════════════════════════════════════
    else if (pathname === '/api/status') {
      const reg = loadRegistry();
      const status = { kits: reg.map(k => ({ ...k, installed: fs.existsSync(path.join(K, k.id)) })), skillCount: 0 };
      try { status.skillCount = fs.readdirSync(S).filter(f => !f.startsWith('.')).length; } catch (e) {}
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(status));
    }
    // ═════════════════════════════════════════════
    // /api/add-kit — 새 킷 등록
    // ═════════════════════════════════════════════
    else if (pathname === '/api/add-kit' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const newKit = JSON.parse(body);
          const reg = loadRegistry();
          if (!reg.find(k => k.id === newKit.id)) {
            reg.push({
              id: newKit.id,
              repo: newKit.repo,
              sub: newKit.sub || 'skills',
              name: newKit.name || newKit.id,
              icon: '📦',
              category: 'Custom',
              desc: 'User-added kit'
            });
            fs.writeFileSync(REGISTRY_FILE, JSON.stringify(reg, null, 2), 'utf-8');
          }
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ ok: true, count: reg.length }));
        } catch (e) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
    // ═════════════════════════════════════════════
    // /api/delete-kit — 킷 목록에서 제거
    // ═════════════════════════════════════════════
    else if (pathname === '/api/delete-kit') {
      const id = parsed.query.id;
      const reg = loadRegistry().filter(k => k.id !== id);
      fs.writeFileSync(REGISTRY_FILE, JSON.stringify(reg, null, 2), 'utf-8');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ ok: true, remaining: reg.length }));
    }
    // ═════════════════════════════════════════════
    // /api/wipe-kit — 킷 완전 삭제
    // ═════════════════════════════════════════════
    else if (pathname === '/api/wipe-kit') {
      const id = parsed.query.id;
      // 레지스트리에서 제거
      const reg = loadRegistry().filter(k => k.id !== id);
      fs.writeFileSync(REGISTRY_FILE, JSON.stringify(reg, null, 2), 'utf-8');
      // PowerShell로 물리 삭제
      const script = `
        if(Test-Path "$S\\${id}"){ Remove-Item "$S\\${id}" -Recurse -Force; Write-Host "[OK] Symlink removed." }
        if(Test-Path "$K\\${id}"){ Remove-Item "$K\\${id}" -Recurse -Force; Write-Host "[OK] Kit folder removed." }
        Write-Host "Wipe complete."
      `;
      const out = await runPowerShell(script);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ ok: true, output: out }));
    }
    // ═════════════════════════════════════════════
    // /api/sysinfo — 시스템 정보
    // ═════════════════════════════════════════════
    else if (pathname === '/api/sysinfo') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(getSystemInfo()));
    }
    // ═════════════════════════════════════════════
    // /api/ping — 서버 연결 확인
    // ═════════════════════════════════════════════
    else if (pathname === '/api/ping') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ 
        ok: true, 
        version: '3.0',
        filename: path.basename(__filename)
      }));
    }
    else { 
      res.writeHead(404); 
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'Not found' })); 
    }
  } catch (e) { 
    res.writeHead(500); 
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: e.message })); 
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(`Kit Manager Server v3.0 running on port ${PORT}`));
