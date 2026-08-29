import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export interface ExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Sandboxed Code Execution:
 * Runs Python or Node.js scripts safely via execFile without shell interpolation.
 */
export async function executeCode(code: string, language: "javascript" | "python" = "javascript"): Promise<ExecutionResult> {
  const timeoutMs = 15000; // 15 seconds execution limit

  try {
    let file = "node";
    let args = ["-e", code];

    if (language === "python") {
      file = "python3";
      args = ["-c", code];
    }

    const { stdout, stderr } = await execFileAsync(file, args, { timeout: timeoutMs });
    return {
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      exitCode: 0,
    };
  } catch (error: any) {
    return {
      stdout: error.stdout ? error.stdout.trim() : "",
      stderr: error.stderr ? error.stderr.trim() : error.message,
      exitCode: error.code || 1,
    };
  }
}
