import * as fs from "node:fs";
import * as path from "node:path";

export class WorkspaceGuard {
  constructor(readonly root: string) {
    this.root = path.resolve(root);
  }

  /**
   * Validate that `filePath` resolves within the workspace root.
   * Returns the resolved absolute path on success.
   * Throws on any escape attempt or resolution failure.
   */
  validate(filePath: string): string {
    // Resolve relative to workspace root
    const resolved = path.resolve(this.root, filePath);

    // Canonicalize root first for comparison
    let realRoot: string;
    try {
      realRoot = fs.realpathSync(this.root);
    } catch {
      throw new Error("Workspace root does not exist");
    }

    let realPath: string;
    try {
      realPath = fs.realpathSync(resolved);
    } catch {
      // realpath fails if the file or any parent doesn't exist yet.
      // Walk up the path to find the nearest existing ancestor, resolve that,
      // then append the remaining non-existent segments.
      realPath = this.resolveNonExistent(resolved);
    }

    if (!realPath.startsWith(realRoot + path.sep) && realPath !== realRoot) {
      throw new Error(
        `Workspace escape blocked: "${filePath}" resolves outside workspace root`,
      );
    }

    return resolved;
  }

  /** Walk up from `target` until we find an existing ancestor, resolve it,
   *  then append the remaining segments.  Returns the canonicalised path. */
  private resolveNonExistent(target: string): string {
    let current = target;
    const missing: string[] = [];

    while (true) {
      try {
        const real = fs.realpathSync(current);
        if (missing.length === 0) return real;
        return path.join(real, ...missing.reverse());
      } catch {
        const parent = path.dirname(current);
        if (parent === current) {
          // We've reached the root without finding anything real
          throw new Error(
            `Workspace escape blocked: cannot resolve path "${target}"`,
          );
        }
        missing.push(path.basename(current));
        current = parent;
      }
    }
  }
}
