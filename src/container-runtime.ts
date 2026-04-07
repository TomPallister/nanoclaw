/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';

import { logger } from './logger.js';

/**
 * The container runtime binary name.
 * Honours $CONTAINER_RUNTIME env var, otherwise prefers `docker`, falls back to `podman`.
 * Detection happens at module load time so callers can use it as a constant.
 */
function detectRuntimeBin(): string {
  if (process.env.CONTAINER_RUNTIME) return process.env.CONTAINER_RUNTIME;
  // Check PATH for docker first, then podman
  for (const bin of ['docker', 'podman']) {
    try {
      execFileSync('which', [bin], { stdio: 'pipe' });
      return bin;
    } catch {
      /* not in path */
    }
  }
  // Also check common absolute paths
  for (const p of ['/opt/podman/bin/podman', '/usr/local/bin/podman']) {
    if (fs.existsSync(p)) return p;
  }
  // Default — caller will get a clear error from ensureContainerRuntimeRunning
  return 'docker';
}

export const CONTAINER_RUNTIME_BIN = detectRuntimeBin();

/** Hostname containers use to reach the host machine. */
export const CONTAINER_HOST_GATEWAY = 'host.docker.internal';

/**
 * Address the credential proxy binds to.
 * Docker Desktop (macOS): 127.0.0.1 — the VM routes host.docker.internal to loopback.
 * Docker (Linux): bind to the docker0 bridge IP so only containers can reach it,
 *   falling back to 0.0.0.0 if the interface isn't found.
 */
export const PROXY_BIND_HOST =
  process.env.CREDENTIAL_PROXY_HOST || detectProxyBindHost();

function detectProxyBindHost(): string {
  if (os.platform() === 'darwin') return '127.0.0.1';

  // WSL uses Docker Desktop (same VM routing as macOS) — loopback is correct.
  // Check /proc filesystem, not env vars — WSL_DISTRO_NAME isn't set under systemd.
  if (fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')) return '127.0.0.1';

  // Bare-metal Linux: bind to the docker0 bridge IP instead of 0.0.0.0
  const ifaces = os.networkInterfaces();
  const docker0 = ifaces['docker0'];
  if (docker0) {
    const ipv4 = docker0.find((a) => a.family === 'IPv4');
    if (ipv4) return ipv4.address;
  }
  throw new Error(
    'Cannot detect docker0 bridge IP on Linux. Set CREDENTIAL_PROXY_HOST env var explicitly.',
  );
}

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // On Linux, host.docker.internal isn't built-in — add it explicitly
  // Use the explicit proxy bind IP instead of host-gateway for reliable connectivity
  if (os.platform() === 'linux') {
    return [`--add-host=host.docker.internal:${PROXY_BIND_HOST}`];
  }
  return [];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Returns the bin and args to stop a container by name. */
export function stopContainer(name: string): { bin: string; args: string[] } {
  return { bin: CONTAINER_RUNTIME_BIN, args: ['stop', '-t', '1', name] };
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execFileSync(CONTAINER_RUNTIME_BIN, ['info'], {
      stdio: 'pipe',
      timeout: 10000,
    });
    logger.debug('Container runtime already running');
  } catch (err) {
    logger.error({ err }, 'Failed to reach container runtime');
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: Container runtime failed to start                      ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Agents cannot run without a container runtime. To fix:        ║',
    );
    console.error(
      '║  1. Ensure Docker is installed and running                     ║',
    );
    console.error(
      '║  2. Run: docker info                                           ║',
    );
    console.error(
      '║  3. Restart NanoClaw                                           ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('Container runtime is required but failed to start', {
      cause: err,
    });
  }
}

/** Kill and remove orphaned NanoClaw containers from previous runs.
 *  Finds both running AND exited containers (docker ps -a) to prevent
 *  dead containers from accumulating across restarts. */
export function cleanupOrphans(): void {
  try {
    // -a includes exited containers, not just running ones
    const output = execFileSync(
      CONTAINER_RUNTIME_BIN,
      ['ps', '-a', '--filter', 'name=nanoclaw-', '--format', '{{.Names}}'],
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try {
        // rm -f handles both running (force-kills) and exited containers
        execFileSync(CONTAINER_RUNTIME_BIN, ['rm', '-f', name], {
          stdio: 'pipe',
        });
      } catch {
        /* already removed */
      }
    }
    if (orphans.length > 0) {
      logger.info(
        { count: orphans.length, names: orphans },
        'Removed orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}
