#!/usr/bin/env node
/**
 * supabase-auto-setup.js - One-click Supabase setup
 *
 * 1. Starts local HTTP server (port 19726)
 * 2. Opens setup page in user's existing Chrome (logged-in session)
 * 3. User pastes access token in the page OR token is auto-captured
 * 4. Server uses Management API to create project + get keys
 * 5. Saves config and optionally starts relay
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { exec, execSync } = require('child_process');

const HOME = process.env.HOME || process.env.USERPROFILE;
const CONFIG_FILE = path.join(HOME, '.claude', '.supabase-config.json');
const PORT = 19726;
const API = 'https://api.supabase.com';

function log(msg) { console.log(`\x1b[36m[SETUP]\x1b[0m ${msg}`); }
function ok(msg) { console.log(`\x1b[32m[ OK  ]\x1b[0m ${msg}`); }
function err(msg) { console.log(`\x1b[31m[ERR  ]\x1b[0m ${msg}`); }

function httpJson(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search,
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...opts.headers },
    }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, data: body }); }
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(JSON.stringify(opts.body));
    req.end();
  });
}

// ── Setup via Management API ──
async function setupWithToken(token) {
  const auth = { Authorization: `Bearer ${token}` };

  // Validate token
  log('토큰 검증 중...');
  const { status: pS, data: projects } = await httpJson(`${API}/v1/projects`, { headers: auth });
  if (pS !== 200) throw new Error(`인증 실패 (HTTP ${pS}). 올바른 Access Token인지 확인하세요.`);
  ok(`인증 성공! 기존 프로젝트: ${projects.length}개`);

  // Find or create project
  let project = projects.find(p => p.status === 'ACTIVE_HEALTHY');

  if (!project) {
    log('새 프로젝트 생성 중...');
    const { data: orgs } = await httpJson(`${API}/v1/organizations`, { headers: auth });
    if (!orgs?.length) throw new Error('조직이 없습니다. Supabase에서 먼저 조직을 만드세요.');

    const dbPass = require('crypto').randomBytes(16).toString('hex');
    const { status: cS, data: np } = await httpJson(`${API}/v1/projects`, {
      method: 'POST', headers: auth,
      body: {
        organization_id: orgs[0].id,
        name: `claude-relay-${Date.now().toString(36)}`,
        db_pass: dbPass,
        region: 'ap-northeast-1',
        plan: 'free',
      },
    });
    if (cS !== 201 && cS !== 200) throw new Error(`프로젝트 생성 실패: ${JSON.stringify(np)}`);
    project = np;
    ok(`프로젝트 생성됨: ${project.name}`);

    // Wait for project to be ready
    log('프로젝트 초기화 대기 중...');
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const { data: chk } = await httpJson(`${API}/v1/projects/${project.id}`, { headers: auth });
      if (chk?.status === 'ACTIVE_HEALTHY') { project = chk; break; }
    }
  }

  ok(`프로젝트: ${project.name} (${project.region})`);

  // Get API keys
  log('API 키 가져오는 중...');
  const { data: keys } = await httpJson(`${API}/v1/projects/${project.id}/api-keys`, { headers: auth });
  const anonKey = keys?.find(k => k.name === 'anon');
  if (!anonKey) throw new Error('anon key를 찾을 수 없습니다.');

  // Save config
  const config = {
    url: `https://${project.id}.supabase.co`,
    anonKey: anonKey.api_key,
    sessionId: `agent-${Date.now().toString(36)}`,
    projectName: project.name,
    region: project.region,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');
  ok(`Config 저장 완료: ${CONFIG_FILE}`);

  return config;
}

// ── Setup Page HTML ──
const SETUP_HTML = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Claude Relay Setup</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0D1117;color:#C9D1D9;
  display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{background:#161B22;border:1px solid #30363D;border-radius:12px;padding:32px;max-width:480px;width:100%}
h1{color:#58A6FF;font-size:20px;margin-bottom:8px}
p{font-size:13px;color:#8B949E;margin-bottom:16px}
.step{background:#0D1117;border:1px solid #30363D;border-radius:8px;padding:12px;margin-bottom:12px;font-size:13px}
.step b{color:#58A6FF}
.step a{color:#58A6FF;text-decoration:none}
.step a:hover{text-decoration:underline}
input{width:100%;padding:12px;background:#0D1117;color:#C9D1D9;border:1px solid #30363D;border-radius:8px;
  font-family:monospace;font-size:13px;margin:12px 0}
input:focus{outline:none;border-color:#58A6FF}
button{width:100%;padding:12px;background:#238636;color:#fff;border:none;border-radius:8px;
  font-size:14px;font-weight:bold;cursor:pointer}
button:hover{background:#2ea043}
button:disabled{opacity:.5;cursor:wait}
.status{margin-top:16px;padding:12px;border-radius:8px;font-size:12px;display:none}
.status.ok{display:block;background:#0d2818;border:1px solid #238636;color:#3FB950}
.status.err{display:block;background:#2d1115;border:1px solid #F85149;color:#F85149}
.status.loading{display:block;background:#1a1e24;border:1px solid #30363D;color:#8B949E}
.auto-section{margin-top:16px;padding:12px;background:#1a1e24;border:1px solid #30363D;border-radius:8px;text-align:center}
.auto-section a{display:inline-block;padding:8px 16px;background:#58A6FF;color:#fff;border-radius:6px;text-decoration:none;font-size:13px;font-weight:bold;margin-top:8px}
.auto-section a:hover{opacity:.9}
</style></head><body>
<div class="card">
<h1>Claude Relay Setup</h1>
<p>Supabase Access Token 하나만 있으면 나머지는 자동입니다.</p>
<div class="step"><b>Step 1.</b> <a href="https://supabase.com/dashboard/account/tokens" target="_blank">Supabase Token 페이지 열기 ↗</a></div>
<div class="step"><b>Step 2.</b> "Generate new token" → 이름: claude-relay → 생성</div>
<div class="step"><b>Step 3.</b> 토큰 복사 후 아래에 붙여넣기</div>
<input id="token" placeholder="sbp_xxxxxxxxxxxx..." autofocus>
<button id="btn" onclick="submit()">Setup 시작</button>
<div id="status" class="status"></div>
</div>
<script>
async function submit(){
  const token=document.getElementById('token').value.trim();
  if(!token){alert('토큰을 입력하세요');return}
  const btn=document.getElementById('btn');
  const st=document.getElementById('status');
  btn.disabled=true;btn.textContent='설정 중...';
  st.className='status loading';st.textContent='Supabase API에 연결 중...';
  try{
    const r=await fetch('/api/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})});
    const d=await r.json();
    if(d.ok){
      st.className='status ok';
      st.innerHTML='Setup 완료!<br>URL: '+d.config.url+'<br>Session: '+d.config.sessionId+'<br><br>이 창을 닫아도 됩니다.';
      btn.textContent='완료!';
    }else{
      st.className='status err';st.textContent='Error: '+d.error;
      btn.disabled=false;btn.textContent='다시 시도';
    }
  }catch(e){
    st.className='status err';st.textContent='연결 실패: '+e.message;
    btn.disabled=false;btn.textContent='다시 시도';
  }
}
</script></body></html>`;

// ── HTTP Server ──
function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(SETUP_HTML);
        return;
      }

      if (req.method === 'POST' && req.url === '/api/setup') {
        let body = '';
        req.on('data', d => body += d);
        req.on('end', async () => {
          try {
            const { token } = JSON.parse(body);
            const config = await setupWithToken(token);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, config }));

            // Auto-close server after success
            ok('설정 완료! 서버 종료 중...');
            setTimeout(() => {
              server.close();
              resolve(config);
            }, 1000);
          } catch (e) {
            err(e.message);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: e.message }));
          }
        });
        return;
      }

      res.writeHead(404);
      res.end('Not Found');
    });

    server.listen(PORT, () => {
      ok(`Setup 서버 시작: http://localhost:${PORT}`);
    });
  });
}

// ── Main ──
async function main() {
  console.log('\n\x1b[36m=== Supabase Auto Setup ===\x1b[0m\n');

  // Check if already configured
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const existing = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (existing.url && !existing.url.includes('YOUR_') && existing.anonKey && !existing.anonKey.includes('YOUR_')) {
        ok(`이미 설정됨: ${existing.url}`);
        log('재설정하려면 .supabase-config.json을 삭제하세요.');
        process.exit(0);
      }
    } catch {}
  }

  // Start server and open browser
  const configPromise = startServer();

  const url = `http://localhost:${PORT}`;
  log(`브라우저에서 열기: ${url}`);

  // Open in existing Chrome
  const openCmd = process.platform === 'win32' ? `start "" "${url}"` :
                  process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(openCmd);

  // Wait for setup to complete
  const config = await configPromise;

  console.log('\n\x1b[32m=== 모든 설정 완료! ===\x1b[0m');
  console.log(`  URL:     ${config.url}`);
  console.log(`  Session: ${config.sessionId}`);
  console.log(`  Region:  ${config.region}`);
  console.log(`\n  Relay 시작: node ~/.claude/hooks/relay-supabase.js\n`);
}

main().catch(e => {
  err(`Fatal: ${e.message}`);
  process.exit(1);
});
