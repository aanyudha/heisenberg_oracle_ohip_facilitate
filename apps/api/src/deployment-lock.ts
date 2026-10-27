import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { projectRoot } from "./paths.js";

// Shared with Compose through ./data; independent of mode, port and DB selection.
export async function acquireDeploymentLock(
  directory = resolve(projectRoot, "data"),
) {
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, ".deployment.lock");
  const recoveryPath = path + ".recovery";
  const message =
    "Another deployment is running or recently stopped. Stop native/Docker first; after an unclean shutdown wait 30 seconds before retrying.";
  for (let attempt = 0; attempt < 2; attempt++) {
    let handle;
    try {
      handle = await open(path, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST")
        throw Error(
          "Cannot create deployment lock in data/. Check directory permissions.",
        );
      // Serialize stale recovery so two starters cannot both remove a newly acquired lease.
      const recovery = await open(recoveryPath, "wx").catch(() => {
        throw Error(
          message +
            " If a recovery marker remains after all processes stop, remove data/.deployment.lock.recovery.",
        );
      });
      try {
        const info = await stat(path).catch(() => undefined);
        if (info && Date.now() - info.mtimeMs < 30000) throw Error(message);
        await rm(path, { force: true });
      } finally {
        await recovery.close();
        await rm(recoveryPath, { force: true });
      }
      continue;
    }
    const owner = `${process.pid}:${randomUUID()}`;
    await handle.writeFile(owner);
    const heartbeat = setInterval(() => {
      // Updating this descriptor never refreshes a different process's replacement lease.
      void handle.utimes(new Date(), new Date()).catch(() => {});
    }, 2000);
    heartbeat.unref();
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      clearInterval(heartbeat);
      await handle.close();
      if ((await readFile(path, "utf8").catch(() => "")) === owner)
        await rm(path, { force: true });
    };
  }
  throw Error(message);
}
