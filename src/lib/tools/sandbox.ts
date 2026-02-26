import Docker from "dockerode";
import path from "path";

const CONTAINER_NAME = "data-analyst-sandbox";
const IMAGE = "ubuntu:22.04";

export interface SandboxInstance {
  container: Docker.Container;
  stop: () => Promise<void>;
}

let containerCache: Docker.Container | null = null;

function dockerizeUri(uri: string): string {
  return uri
    .replace(/localhost/g, "host.docker.internal")
    .replace(/127\.0\.0\.1/g, "host.docker.internal");
}

async function initContainer(container: Docker.Container): Promise<void> {
  console.log("[Sandbox] Installing Python and pymongo (first-time setup)...");
  const { exitCode, stderr } = await execInContainer(
    container,
    "apt-get update -qq && apt-get install -y -q python3-pip python3-dev && pip3 install -q pymongo pandas numpy scipy"
  );
  if (exitCode !== 0) {
    console.error("[Sandbox] Python setup failed:", stderr);
  } else {
    console.log("[Sandbox] Python setup complete.");
  }
}

/**
 * Creates or reuses a persistent Docker container for executing commands.
 * Mounts the semantic directory and scripts directory read-only.
 */
export async function createSandbox(): Promise<SandboxInstance> {
  const docker = new Docker();

  // Reuse cached container if available (Python guaranteed already installed in this process)
  if (containerCache) {
    try {
      const info = await containerCache.inspect();
      if (info.State.Running) {
        return { container: containerCache, stop: () => Promise.resolve() };
      }
    } catch {
      containerCache = null;
    }
  }

  // Try to reuse existing container by name
  try {
    const existing = docker.getContainer(CONTAINER_NAME);
    const info = await existing.inspect();
    if (info.State.Running) {
      containerCache = existing;
      // Ensure Python is installed (may have been skipped if container pre-existed)
      const check = await execInContainer(existing, "python3 --version");
      if (check.exitCode !== 0) {
        await initContainer(existing);
      }
      return { container: existing, stop: () => Promise.resolve() };
    }
    // Container exists but not running - remove it
    await existing.remove({ force: true });
  } catch {
    // Container doesn't exist, create new
  }

  // Ensure image exists
  try {
    await docker.getImage(IMAGE).inspect();
  } catch {
    console.log(`Pulling ${IMAGE}...`);
    await new Promise((resolve, reject) => {
      docker.pull(IMAGE, (err: Error, stream: NodeJS.ReadableStream) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream, resolve, () => {});
      });
    });
  }

  const semanticPath = path.resolve(process.cwd(), "src/semantic");
  const scriptsPath = path.resolve(process.cwd(), "src/lib/tools/scripts");

  const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017";
  const mongoUriDocker = dockerizeUri(mongoUri);
  const mongoDatabases = process.env.MONGODB_DATABASES || "";

  const container = await docker.createContainer({
    name: CONTAINER_NAME,
    Image: IMAGE,
    Cmd: ["sleep", "infinity"],
    AttachStdout: true,
    AttachStderr: true,
    Env: [
      `MONGODB_URI_DOCKER=${mongoUriDocker}`,
      `MONGODB_DATABASES=${mongoDatabases}`,
    ],
    HostConfig: {
      Binds: [
        `${semanticPath}:/app/semantic:ro`,
        `${scriptsPath}:/app/scripts:ro`,
      ],
    },
    WorkingDir: "/app",
  });

  await container.start();
  containerCache = container;

  // First-time setup: install Python + pymongo
  await initContainer(container);

  return { container, stop: () => Promise.resolve() };
}

/**
 * Execute a command in the container and return output.
 */
export async function execInContainer(
  container: Docker.Container,
  cmd: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const exec = await container.exec({
    Cmd: ["/bin/bash", "-lc", cmd],
    AttachStdout: true,
    AttachStderr: true,
  });

  const stream = await exec.start({});

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let stdout = "";
    let stderr = "";

    stream.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });

    stream.on("end", async () => {
      try {
        const buffer = Buffer.concat(chunks);

        // Docker multiplexes stdout/stderr with 8-byte headers
        // Parse the stream format
        let offset = 0;
        while (offset < buffer.length) {
          if (offset + 8 > buffer.length) break;

          const streamType = buffer.readUInt8(offset);
          const length = buffer.readUInt32BE(offset + 4);

          offset += 8;
          if (offset + length > buffer.length) break;

          const content = buffer.toString("utf8", offset, offset + length);
          if (streamType === 1) {
            stdout += content;
          } else if (streamType === 2) {
            stderr += content;
          }
          offset += length;
        }

        const inspect = await exec.inspect();
        resolve({
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          exitCode: inspect.ExitCode ?? 0,
        });
      } catch (err) {
        reject(err);
      }
    });

    stream.on("error", reject);
  });
}
