const connectionPill = document.querySelector('#connection-pill');
const connectionText = document.querySelector('#connection-text');
const runtimeState = document.querySelector('#runtime-state');
const runtimeCaption = document.querySelector('#runtime-caption');
const runtimePort = document.querySelector('#runtime-port');
const lastChecked = document.querySelector('#last-checked');
const liveRegion = document.querySelector('#live-region');

function setConnectionState(state, text) {
  connectionPill.className = `status-pill ${state}`;
  connectionText.textContent = text;
}

function formatUptime(seconds) {
  if (seconds < 60) return `${seconds}s uptime`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m uptime`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m uptime`;
}

async function refreshRuntime() {
  try {
    const response = await fetch('/api/v1/runtime', { headers: { accept: 'application/json' }, cache: 'no-store' });
    if (!response.ok) throw new Error(`Runtime returned HTTP ${response.status}`);
    const runtime = await response.json();
    runtimeState.textContent = runtime.state === 'ready' ? 'Online' : 'Not ready';
    runtimeCaption.textContent = `Process ${runtime.pid} · ${formatUptime(runtime.uptimeSeconds)}`;
    runtimePort.textContent = String(runtime.port);
    setConnectionState('online', 'Runtime connected');
    lastChecked.textContent = `Last checked ${new Date().toLocaleTimeString()}`;
    liveRegion.textContent = 'Sparkiee runtime connected.';
  } catch {
    runtimeState.textContent = 'Offline';
    runtimeCaption.textContent = 'Start it with “sparkiee start”';
    setConnectionState('offline', 'Runtime unreachable');
    lastChecked.textContent = `Could not reach runtime · ${new Date().toLocaleTimeString()}`;
    liveRegion.textContent = 'Sparkiee runtime is not reachable.';
  }
}

refreshRuntime();
window.setInterval(refreshRuntime, 5000);
