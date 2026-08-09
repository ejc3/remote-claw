import { realpathSync, statfsSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute } from "node:path";
import { classifyHostStateFilesystemType } from "./secure-filesystem.js";

function allowedTestDirectory(path: string | undefined): string | null {
  if (path === undefined || !isAbsolute(path)) return null;
  try {
    const canonicalPath = realpathSync(path);
    return classifyHostStateFilesystemType(statfsSync(canonicalPath, { bigint: true }).type).allowed
      ? canonicalPath
      : null;
  } catch {
    return null;
  }
}

/** An approved local filesystem for tests that exercise the real secure opener. */
export const HOST_STATE_TEST_TEMPORARY_DIRECTORY =
  allowedTestDirectory(process.env.RUNNER_TEMP) ?? allowedTestDirectory(tmpdir()) ?? tmpdir();

export const HOST_STATE_TEST_FILESYSTEM_SUPPORTED =
  allowedTestDirectory(HOST_STATE_TEST_TEMPORARY_DIRECTORY) !== null;
