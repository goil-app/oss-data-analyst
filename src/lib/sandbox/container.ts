import Docker from "dockerode";
import path from "path";
import type { SandboxConfig, ExecResult } from "./types";
import { SandboxTimeoutError } from "./types";

/**
 * Pull image if not already present locally.
 */
export async function ensureImage(docker: Docker, image: string): Promise<void> {
  try {
    await docker.getImage(image).inspect();
  } catch {
    console.log(`[Sandbox] Pulling ${image}...`);
    await new Promise<void>((resolve, reject) => {
      docker.pull(image, (err: Error, stream: NodeJS.ReadableStream) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream, (err2) => (err2 ? reject(err2) : resolve()), () => {});
      });
    });
  }
}

/**
 * Create a container with resource limits and security options.
 */
export async function createContainer(
  docker: Docker,
  config: SandboxConfig,
  id: string,
): Promise<Docker.Container> {
  const semanticPath = path.resolve(process.cwd(), "src/semantic");

  return docker.createContainer({
    name: `sandbox-${id}`,
    Image: config.image,
    Cmd: ["sleep", "infinity"],
    AttachStdout: true,
    AttachStderr: true,
    Env: [],
    WorkingDir: "/app",
    HostConfig: {
      Binds: [`${semanticPath}:/app/semantic:ro`],
      Memory: config.resourceLimits.memoryBytes,
      NanoCpus: config.resourceLimits.nanoCpus,
      PidsLimit: config.resourceLimits.pidsLimit,
      SecurityOpt: ["no-new-privileges"],
      Tmpfs: { "/tmp": "rw,noexec,nosuid,size=64m" },
    },
  });
}

/**
 * Start a container.
 */
export async function startContainer(container: Docker.Container): Promise<void> {
  await container.start();
}

/**
 * Stop a container with a grace period.
 */
export async function stopContainer(container: Docker.Container, timeoutSec = 10): Promise<void> {
  try {
    await container.stop({ t: timeoutSec });
  } catch (err: any) {
    // 304 = already stopped
    if (err.statusCode !== 304) throw err;
  }
}

/**
 * Remove a container forcefully.
 */
export async function removeContainer(container: Docker.Container): Promise<void> {
  try {
    await container.remove({ force: true });
  } catch (err: any) {
    // 404 = already removed
    if (err.statusCode !== 404) throw err;
  }
}

/**
 * Execute a command inside a container with timeout support.
 * Parses Docker's multiplexed stdout/stderr stream format.
 */
export async function execInContainer(
  container: Docker.Container,
  cmd: string,
  timeoutMs?: number,
): Promise<ExecResult> {
  const exec = await container.exec({
    Cmd: ["/bin/bash", "-lc", cmd],
    AttachStdout: true,
    AttachStderr: true,
  });

  const stream = await exec.start({});

  return new Promise<ExecResult>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;

    const timer = timeoutMs
      ? setTimeout(() => {
          if (!settled) {
            settled = true;
            stream.destroy();
            reject(new SandboxTimeoutError("exec", timeoutMs));
          }
        }, timeoutMs)
      : null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
    };

    stream.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });

    stream.on("end", async () => {
      if (settled) return;
      settled = true;
      cleanup();

      try {
        const buffer = Buffer.concat(chunks);
        let stdout = "";
        let stderr = "";

        // Docker multiplexes stdout/stderr with 8-byte headers
        let offset = 0;
        while (offset < buffer.length) {
          if (offset + 8 > buffer.length) break;
          const streamType = buffer.readUInt8(offset);
          const length = buffer.readUInt32BE(offset + 4);
          offset += 8;
          if (offset + length > buffer.length) break;
          const content = buffer.toString("utf8", offset, offset + length);
          if (streamType === 1) stdout += content;
          else if (streamType === 2) stderr += content;
          offset += length;
        }

        const info = await exec.inspect();
        resolve({
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          exitCode: info.ExitCode ?? 0,
        });
      } catch (err) {
        reject(err);
      }
    });

    stream.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });
  });
}

function assertSafeFilePath(filePath: string): void {
  if (!/^[a-zA-Z0-9/_.\-]+$/.test(filePath)) {
    throw new Error(`Unsafe file path: ${filePath}`);
  }
}

/**
 * Write a file into the container via exec + base64.
 */
export async function writeToContainer(
  container: Docker.Container,
  filePath: string,
  content: Buffer,
): Promise<void> {
  assertSafeFilePath(filePath);
  const b64 = content.toString("base64");
  await execInContainer(container, `echo '${b64}' | base64 -d > ${filePath}`);
}

/**
 * Check if a container is currently running.
 */
export async function isContainerRunning(container: Docker.Container): Promise<boolean> {
  try {
    const info = await container.inspect();
    return info.State.Running === true;
  } catch {
    return false;
  }
}

/**
 * Install Python packages in a container (first-time setup).
 */
export async function initContainerPython(container: Docker.Container, timeoutMs?: number): Promise<void> {
  console.log("[Sandbox] Installing Python packages...");
  const { exitCode, stderr } = await execInContainer(
    container,
    "apt-get update -qq && apt-get install -y -q python3-pip python3-dev && pip3 install -q pandas numpy scipy",
    timeoutMs,
  );
  if (exitCode !== 0) {
    console.error("[Sandbox] Python setup failed:", stderr);
    throw new Error(`Python setup failed: ${stderr}`);
  }
  console.log("[Sandbox] Python setup complete.");
}
