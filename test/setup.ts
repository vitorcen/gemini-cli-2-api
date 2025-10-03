import { spawn, type ChildProcess } from 'child_process';
import { once } from 'events';

let serverProcess: ChildProcess | null = null;
export const BASE_URL = 'http://localhost:41242';

export async function setup() {
  console.log('🚀 Starting a2a-server...');

  // 启动 a2a-server - 使用 npm start 脚本
  const projectRoot = process.cwd().includes('/test')
    ? process.cwd() + '/..'
    : process.cwd();

  const env = {
    ...process.env,
    CODER_AGENT_PORT: '41242',
    USE_CCPA: '1'  // 使用 OAuth 认证（已登录的凭证）
  };
  // 明确移除 NODE_ENV，否则 server.js 不会启动
  delete env.NODE_ENV;

  serverProcess = spawn('npm', ['start', '2>&1'], {
    cwd: `${projectRoot}/packages/a2a-server`,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
    shell: true,
    env
  });

  // 监听输出
  serverProcess.stdout?.on('data', (data) => {
    const message = data.toString();
    console.log('[Server STDOUT]', message.trim());
  });

  serverProcess.stderr?.on('data', (data) => {
    const message = data.toString();
    console.error('[Server STDERR]', message.trim());
  });

  serverProcess.on('error', (error) => {
    console.error('[Server ERROR]', error);
  });

  serverProcess.on('exit', (code, signal) => {
    console.log(`[Server EXIT] Code: ${code}, Signal: ${signal}`);
  });

  // 等待服务器启动
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // 验证服务器可用
  try {
    const healthResponse = await fetch(BASE_URL);
    if (healthResponse.ok) {
      console.log('✅ a2a-server started successfully on', BASE_URL);
    } else {
      console.log('⚠️  Server started but health check failed');
    }
  } catch (error) {
    console.error('❌ Failed to connect to server:', (error as Error).message);
    throw error;
  }
}

export async function teardown() {
  console.log('🛑 Stopping a2a-server...');

  if (serverProcess) {
    serverProcess.kill('SIGTERM');

    // 等待进程结束
    try {
      await Promise.race([
        once(serverProcess, 'exit'),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Timeout')), 5000)
        )
      ]);
      console.log('✅ Server stopped');
    } catch {
      serverProcess.kill('SIGKILL');
      console.log('⚠️  Server force killed');
    }

    serverProcess = null;
  }
}
