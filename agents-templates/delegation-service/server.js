const http = require('http');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 3847;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MAX_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

let activeJobs = 0;

function runOpenClaude(task, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = Math.min(timeoutMs || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const args = [
      '-p', task,
      '--output-format', 'text',
      '--permission-mode', 'dontAsk',
      '--model', 'sonnet',
      '--verbose'
    ];

    const proc = spawn('openclaude', args, {
      cwd: cwd || '/root',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HOME: '/root' }
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGTERM');
      setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch (_) {}
      }, 5000);
    }, timeout);

    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (killed) {
        resolve({ success: false, result: stdout || '', error: `Timeout after ${timeout / 1000}s` });
      } else if (code === 0 || stdout.length > 0) {
        resolve({ success: true, result: stdout, error: null });
      } else {
        resolve({ success: false, result: '', error: stderr || `Exit code ${code}` });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ success: false, result: '', error: err.message });
    });

    // Close stdin immediately - we pass task via -p flag
    proc.stdin.end();
  });
}

const server = http.createServer(async (req, res) => {
  // CORS + headers
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok', active_jobs: activeJobs }));
    return;
  }

  if (req.method === 'POST' && req.url === '/delegate') {
    let body = '';
    req.on('data', (chunk) => { body += chunk.toString(); });
    req.on('end', async () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON' }));
        return;
      }

      const { task, context, cwd, timeout_ms } = parsed;
      if (!task) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Missing "task" field' }));
        return;
      }

      // Build full prompt with optional context
      let fullTask = task;
      if (context) {
        fullTask = `Context from the requesting agent:\n${context}\n\nTask to execute:\n${task}`;
      }

      console.log(`[Delegation] New task (${activeJobs + 1} active): ${task.substring(0, 100)}...`);
      activeJobs++;

      try {
        const result = await runOpenClaude(fullTask, cwd, timeout_ms);
        console.log(`[Delegation] Task completed (success: ${result.success}, ${result.result.length} chars)`);
        res.writeHead(200);
        res.end(JSON.stringify(result));
      } catch (err) {
        console.error(`[Delegation] Task error: ${err.message}`);
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: err.message }));
      } finally {
        activeJobs--;
      }
    });
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Delegation Service] Running on port ${PORT}`);
});
