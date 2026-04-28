'use strict';

const http = require('http');
const { execFile } = require('child_process');
const { execSync } = require('child_process');

const DEFAULT_NGROK_API_URL = 'http://127.0.0.1:4040/api';

function localTunnelTarget(host, port) {
  let localHost = (host || '127.0.0.1').trim();
  if (localHost === '0.0.0.0' || localHost === '::') {
    localHost = '127.0.0.1';
  }
  if (localHost.includes(':') && !localHost.startsWith('[')) {
    localHost = `[${localHost}]`;
  }
  return `http://${localHost}:${port}`;
}

function parseNgrokPublicUrl(payload) {
  let records = payload.endpoints;
  if (!Array.isArray(records)) records = payload.tunnels;
  if (!Array.isArray(records)) return null;

  const publicUrls = [];
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    if (record.url) publicUrls.push(record.url);
    if (record.public_url) publicUrls.push(record.public_url);
  }
  const https = publicUrls.find(u => u.startsWith('https://'));
  if (https) return https;
  const http_ = publicUrls.find(u => u.startsWith('http://'));
  return http_ || null;
}

function ngrokAgentUrls(apiUrl) {
  const normalized = apiUrl.replace(/\/$/, '');
  if (normalized.endsWith('/endpoints') || normalized.endsWith('/tunnels')) {
    return [normalized];
  }
  return [`${normalized}/endpoints`, `${normalized}/tunnels`];
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 1000 }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('request timeout'));
    });
  });
}

/**
 * Check whether a binary is available on PATH (synchronously).
 */
function commandExists(cmd) {
  try {
    execSync(
      process.platform === 'win32' ? `where ${cmd}` : `which ${cmd}`,
      { stdio: 'ignore' },
    );
    return true;
  } catch (_e) {
    return false;
  }
}

class NgrokTunnel {
  /**
   * @param {string} targetUrl
   * @param {object} [options]
   * @param {string} [options.command]
   * @param {string} [options.apiUrl]
   * @param {number} [options.startupTimeout]
   */
  constructor(targetUrl, { command = 'ngrok', apiUrl = DEFAULT_NGROK_API_URL, startupTimeout = 15000 } = {}) {
    this.targetUrl = targetUrl;
    this.command = command;
    this.apiUrl = apiUrl;
    this.startupTimeout = startupTimeout;
    this._process = null;
  }

  /**
   * Start the ngrok tunnel.
   * @returns {Promise<string>} The public HTTPS URL.
   */
  async start() {
    if (!commandExists(this.command)) {
      throw new Error(
        'ngrok is not installed or is not on PATH. Install it, then run ' +
        '`ngrok config add-authtoken <token>` once.',
      );
    }

    this._process = execFile(
      this.command,
      ['http', this.targetUrl],
      { stdio: 'ignore' },
    );

    try {
      return await this._waitForPublicUrl();
    } catch (err) {
      this.stop();
      throw err;
    }
  }

  async _waitForPublicUrl() {
    const deadline = Date.now() + this.startupTimeout;
    let lastError = 'ngrok did not report a public URL';

    while (Date.now() < deadline) {
      if (this._process && this._process.exitCode !== null) {
        throw new Error('ngrok exited before creating a tunnel');
      }
      for (const apiUrl of ngrokAgentUrls(this.apiUrl)) {
        try {
          const body = await httpGet(apiUrl);
          const payload = JSON.parse(body);
          const publicUrl = parseNgrokPublicUrl(payload);
          if (publicUrl) return publicUrl;
        } catch (err) {
          lastError = err.message;
        }
      }
      await sleep(250);
    }
    throw new Error(`Timed out waiting for ngrok tunnel: ${lastError}`);
  }

  stop() {
    if (!this._process) return;
    try {
      this._process.kill('SIGTERM');
    } catch (_e) {
      // ignore
    }
    this._process = null;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { NgrokTunnel, localTunnelTarget };
