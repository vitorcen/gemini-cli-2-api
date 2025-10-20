#!/usr/bin/env node

import { exec, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readFileSync, writeFileSync, unlinkSync, openSync, closeSync } from 'fs';
import { tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, '..', 'packages', 'a2a-server', 'dist', 'src', 'http', 'server.js');
const pidFile = join(tmpdir(), 'gemini-cli-2-api.pid');
const logFile = join(tmpdir(), 'gemini-cli-2-api.log');

// Read version from package.json
const packageJsonPath = join(__dirname, '..', 'package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
const version = packageJson.version;

// Version message
if (process.argv.includes('-v') || process.argv.includes('--version')) {
  console.log(`gemini-cli-2-api v${version}`);
  process.exit(0);
}

// Help message
if (process.argv.includes('-h') || process.argv.includes('--help')) {
  console.log(`
Gemini CLI 2 API - Claude/OpenAI to Gemini API Proxy Server

Usage:
  gemini-cli-2-api          Start the proxy server (foreground)
  gemini-cli-2-api start    Start the proxy server as background service
  gemini-cli-2-api stop     Stop the background service
  gemini-cli-2-api status   Check server status
  gemini-cli-2-api -v       Show version number
  gemini-cli-2-api -h       Show this help message

Server Configuration:
  Port: 41242
  Environment: USE_CCPA=1
  PID File: ${pidFile}
  Log File: ${logFile}

Process:
  1. Kill existing process on port 41242 (if any)
  2. Wait 3 seconds
  3. Login to CCPA (~30 seconds)
  4. Start proxy server

Total estimated time: ~30-35 seconds
`);
  process.exit(0);
}

// Stop command
if (process.argv.includes('stop')) {
  console.log('🛑 Stopping Gemini CLI 2 API Proxy Server...\n');

  exec('lsof -ti:41242', (error, stdout) => {
    if (error || !stdout.trim()) {
      console.log('❌ Server is not running on port 41242');
      if (existsSync(pidFile)) {
        unlinkSync(pidFile);
        console.log('   Cleaned up stale PID file');
      }
      process.exit(1);
    }

    const pid = stdout.trim();
    exec(`kill -9 ${pid}`, (killErr) => {
      if (killErr) {
        console.log(`❌ Failed to stop server (PID: ${pid})`);
        process.exit(1);
      }

      console.log(`✅ Server stopped (PID: ${pid})`);

      if (existsSync(pidFile)) {
        unlinkSync(pidFile);
        console.log('   Cleaned up PID file');
      }

      console.log('');
      process.exit(0);
    });
  });
} else if (process.argv.includes('start')) {
  // Start as background service
  console.log('🚀 Starting Gemini CLI 2 API Proxy Server as background service...\n');

  // Check if already running
  exec('lsof -ti:41242', (checkErr, checkStdout) => {
    if (!checkErr && checkStdout.trim()) {
      console.log('⚠️  Server is already running on port 41242');
      console.log(`   PID: ${checkStdout.trim()}`);
      console.log('   Run `gemini-cli-2-api stop` to stop it first');
      process.exit(1);
    }

    console.log('[1/3] Checking for existing process on port 41242...');
    console.log('      ✓ Port is available');

    console.log('\n[2/3] Waiting 3 seconds for port cleanup...');
    setTimeout(() => {
      console.log('      ✓ Port cleanup complete');

      console.log('\n[3/3] Starting proxy server in background (CCPA login ~30s)...');

      // Open log file for writing
      const logFd = openSync(logFile, 'a');

      // Start server as detached background process
      const child = spawn('node', [serverPath], {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: {
          ...process.env,
          USE_CCPA: '1',
          CODER_AGENT_PORT: '41242'
        }
      });

      // Save PID to file
      writeFileSync(pidFile, child.pid.toString());

      // Close log file descriptor in parent process
      closeSync(logFd);

      child.unref();

      console.log(`      ✓ Server started in background`);
      console.log(`      PID: ${child.pid}`);
      console.log(`      Log: ${logFile}`);
      console.log('\n✨ Background service started!\n');
      console.log('   Use `gemini-cli-2-api status` to check server status');
      console.log('   Use `gemini-cli-2-api stop` to stop the server');
      console.log('');

      // Wait a bit then exit
      setTimeout(() => {
        process.exit(0);
      }, 1000);
    }, 3000);
  });
} else if (process.argv.includes('status')) {
  console.log('🔍 Checking Gemini CLI 2 API Proxy Server status...\n');

  exec('lsof -ti:41242', (error, stdout) => {
    if (error || !stdout.trim()) {
      console.log('❌ Server is NOT running on port 41242\n');
      console.log('   Run `gemini-cli-2-api start` to start as background service');
      console.log('   Run `gemini-cli-2-api` to start in foreground');
      process.exit(1);
    }

    const pid = stdout.trim();
    console.log('✅ Server is running\n');
    console.log(`   Port: 41242`);
    console.log(`   PID: ${pid}`);

    // Check if PID file exists
    if (existsSync(pidFile)) {
      const savedPid = readFileSync(pidFile, 'utf-8').trim();
      if (savedPid === pid) {
        console.log(`   Mode: Background service`);
        console.log(`   Log: ${logFile}`);
      }
    } else {
      console.log(`   Mode: Foreground`);
    }

    // Get process details
    exec(`ps -p ${pid} -o pid,comm,%cpu,%mem,etime`, (err, psOut) => {
      if (!err) {
        const lines = psOut.trim().split('\n');
        if (lines.length > 1) {
          console.log(`   Details: ${lines[1].trim()}`);
        }
      }

      // Test server health
      console.log('\n🔗 Testing server health...');
      exec('curl -s -o /dev/null -w "%{http_code}" http://localhost:41242/health 2>/dev/null', (curlErr, httpCode) => {
        if (curlErr || httpCode.trim() === '000') {
          console.log('   ⚠️  Server process exists but not responding');
        } else if (httpCode.trim() === '200' || httpCode.trim() === '404') {
          console.log('   ✓ Server is responding');
        } else {
          console.log(`   ⚠️  Server returned HTTP ${httpCode.trim()}`);
        }
        console.log('');
        process.exit(0);
      });
    });
  });
} else {
  // Start server (default behavior)
  console.log('🚀 Starting Gemini CLI 2 API Proxy Server...\n');

  // Step 1: Kill process on port 41242
  console.log('[1/3] Checking for existing process on port 41242...');
  exec('lsof -ti:41242 | xargs kill -9 2>/dev/null', (error) => {
    if (error && error.code !== 1) {
      console.log('      ✓ No existing process found');
    } else {
      console.log('      ✓ Killed existing process');
    }

    // Step 2: Wait 3 seconds
    console.log('\n[2/3] Waiting 3 seconds for port cleanup...');
    let countdown = 3;
    const countdownInterval = setInterval(() => {
      process.stdout.write(`\r      ${countdown}s remaining...`);
      countdown--;
      if (countdown < 0) {
        clearInterval(countdownInterval);
        process.stdout.write('\r      ✓ Port cleanup complete\n');

        // Step 3: Start server
        console.log('\n[3/3] Starting proxy server (CCPA login ~30s)...');

        // Start server in foreground (inherit stdio)
        const child = spawn('node', [serverPath], {
          stdio: 'inherit',
          env: {
            ...process.env,
            USE_CCPA: '1',
            CODER_AGENT_PORT: '41242'
          }
        });

        // Handle signals to gracefully shut down
        process.on('SIGINT', () => {
          child.kill('SIGINT');
          process.exit(0);
        });

        process.on('SIGTERM', () => {
          child.kill('SIGTERM');
          process.exit(0);
        });

        child.on('exit', (code) => {
          process.exit(code);
        });
      }
    }, 1000);
  });
}
