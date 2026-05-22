import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { readFile, readdir, access } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { stdout as output } from "node:process";
import { fileURLToPath } from "node:url";

output.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") {
    process.exit(0);
  }

  throw error;
});

type PlaywrightMode = "playwright:headless:local" | "playwright:ui:local";

type Runner = "playwright" | "vitest" | "browser";

type CliState = {
  runner: Runner;
  mode?: PlaywrightMode;
  selectedFiles: Set<string>;
};

type ResolvedCommand = {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  label: string;
};

type RunnerOption = {
  value: Runner;
  label: string;
  description: string;
};

type TestTreeNode = {
  name: string;
  relativePath: string;
  directories: TestTreeNode[];
  files: string[];
};

const scriptFilePath = fileURLToPath(import.meta.url);
const scriptRoot = path.dirname(scriptFilePath);
const launcherRepoRoot = path.dirname(scriptRoot);
const launcherAssetsRoot = path.join(scriptRoot, "test-launcher");
let repoRoot = process.cwd();
const validPlaywrightExtensions = [".spec.ts", ".spec.tsx"];
const validVitestExtensions = [
  ".test.ts",
  ".test.tsx",
  ".test.js",
  ".test.jsx",
];
const runnerOptions: RunnerOption[] = [
  {
    value: "playwright",
    label: "Playwright tests",
    description: "Run end-to-end specs from tests/e2e in headless or UI mode.",
  },
  {
    value: "vitest",
    label: "Vitest",
    description: "Run standard Vitest suites in the terminal.",
  },
  {
    value: "browser",
    label: "Browser-backed Vitest",
    description: "Run browser-backed Vitest suites with Playwright.",
  },
];
const excludedPathPrefixes = ["packages/core", "tests/playwright"];
const excludedPathSegments = new Set([
  ".git",
  ".next",
  "coverage",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results",
]);

const usage = `Test launcher

Usage:
  yarn test:launch
  yarn test:launch -- --repo /Users/you/projects/platform-forms-client
  yarn test:launch -- --runner playwright --mode ui --files tests/e2e/smoke.spec.ts
  yarn test:launch -- --runner vitest --files lib/utils.test.ts
  yarn test:launch -- --runner browser --list

Options:
  --repo <path>         Target forms repo to inspect and run tests in
  --runner <playwright|vitest|browser>
                         Skip the runner selector
  --mode <ui|headless>   Set the Playwright mode
  --files <a,b,c>        Run one or more test files without prompting
  --list                 Print discovered test files for the selected runner and exit
  --help                 Show this help text
`;

function isPlaywrightTestFile(name: string) {
  return validPlaywrightExtensions.some((extension) =>
    name.endsWith(extension),
  );
}

function isBrowserVitestFile(name: string) {
  return /\.browser\.test\.(ts|tsx|js|jsx)$/u.test(name);
}

function isVitestFile(name: string) {
  return validVitestExtensions.some((extension) => name.endsWith(extension));
}

function shouldIgnorePath(relativePath: string) {
  const segments = relativePath.split("/").filter(Boolean);

  if (segments.some((segment) => excludedPathSegments.has(segment))) {
    return true;
  }

  return excludedPathPrefixes.some(
    (prefix) =>
      relativePath === prefix || relativePath.startsWith(`${prefix}/`),
  );
}

function toWorkspacePath(absolutePath: string) {
  return path
    .relative(repoRoot, absolutePath)
    .split(path.sep)
    .join(path.posix.sep);
}

function getPlaywrightTestsRoot() {
  return path.join(repoRoot, "tests", "e2e");
}

async function loadEnvRepoRoot() {
  const envPath = path.join(launcherRepoRoot, ".env");

  try {
    await access(envPath);
  } catch {
    return undefined;
  }

  const envFile = await readFile(envPath, "utf8");
  const entry = envFile
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(
      (line) =>
        line.startsWith("TEST_LAUNCHER_REPO_ROOT=") &&
        line.length > "TEST_LAUNCHER_REPO_ROOT=".length,
    );

  if (!entry) {
    return undefined;
  }

  const rawValue = entry.slice("TEST_LAUNCHER_REPO_ROOT=".length).trim();
  const unquoted = rawValue.replace(/^['"]|['"]$/g, "");
  return unquoted ? path.resolve(unquoted) : undefined;
}

async function collectTestFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return collectTestFiles(absolutePath);
      }
      return isPlaywrightTestFile(entry.name)
        ? [toWorkspacePath(absolutePath)]
        : [];
    }),
  );

  return files.flat().sort((left, right) => left.localeCompare(right));
}

async function collectMatchingFiles(
  dir: string,
  matcher: (entryName: string, workspacePath: string) => boolean,
): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = path.join(dir, entry.name);
      const workspacePath = toWorkspacePath(absolutePath);

      if (entry.isDirectory()) {
        if (shouldIgnorePath(workspacePath)) {
          return [];
        }

        return collectMatchingFiles(absolutePath, matcher);
      }

      return matcher(entry.name, workspacePath) ? [workspacePath] : [];
    }),
  );

  return files.flat().sort((left, right) => left.localeCompare(right));
}

async function buildTree(currentDir: string): Promise<TestTreeNode> {
  const relativePath = path
    .relative(getPlaywrightTestsRoot(), currentDir)
    .split(path.sep)
    .join(path.posix.sep);
  const entries = await readdir(currentDir, { withFileTypes: true });

  const directories = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => buildTree(path.join(currentDir, entry.name))),
  );

  const files = entries
    .filter((entry) => !entry.isDirectory() && isPlaywrightTestFile(entry.name))
    .map((entry) => toWorkspacePath(path.join(currentDir, entry.name)))
    .sort((left, right) => left.localeCompare(right));

  return {
    name: path.basename(currentDir),
    relativePath,
    directories,
    files,
  };
}

function sortTree(node: TestTreeNode): TestTreeNode {
  node.directories.sort((left, right) => left.name.localeCompare(right.name));
  node.files.sort((left, right) => left.localeCompare(right));
  node.directories.forEach((child) => sortTree(child));
  return node;
}

function buildTreeFromFiles(name: string, files: string[]): TestTreeNode {
  const root: TestTreeNode = {
    name,
    relativePath: "",
    directories: [],
    files: [],
  };

  for (const file of files) {
    const segments = file.split("/");
    const fileName = segments.pop();

    if (!fileName) {
      continue;
    }

    let currentNode = root;
    let currentPath = "";

    for (const segment of segments) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      let nextNode = currentNode.directories.find(
        (entry) => entry.relativePath === currentPath,
      );

      if (!nextNode) {
        nextNode = {
          name: segment,
          relativePath: currentPath,
          directories: [],
          files: [],
        };
        currentNode.directories.push(nextNode);
      }

      currentNode = nextNode;
    }

    currentNode.files.push(file);
  }

  return sortTree(root);
}

async function getRunnerFiles(runner: Runner) {
  if (runner === "playwright") {
    return collectTestFiles(getPlaywrightTestsRoot());
  }

  if (runner === "browser") {
    return collectMatchingFiles(
      repoRoot,
      (entryName, workspacePath) =>
        isBrowserVitestFile(entryName) && !shouldIgnorePath(workspacePath),
    );
  }

  return collectMatchingFiles(
    repoRoot,
    (entryName, workspacePath) =>
      isVitestFile(entryName) &&
      !isBrowserVitestFile(entryName) &&
      !shouldIgnorePath(workspacePath),
  );
}

async function buildRunnerTree(runner: Runner) {
  if (runner === "playwright") {
    return buildTree(getPlaywrightTestsRoot());
  }

  const files = await getRunnerFiles(runner);
  const rootLabel =
    runner === "vitest" ? "repo vitest tests" : "repo browser tests";
  return buildTreeFromFiles(rootLabel, files);
}

function resolveCommand(state: CliState): ResolvedCommand {
  if (state.runner === "playwright") {
    const script = state.mode ?? "playwright:headless:local";
    return {
      command: "yarn",
      args: [script, "--"],
      label: script,
    };
  }

  if (state.runner === "browser") {
    return {
      command: "yarn",
      args: ["vitest", "--run"],
      env: {
        ...process.env,
        VITEST_BROWSER: "true",
      },
      label: "vitest --run (browser)",
    };
  }

  return {
    command: "yarn",
    args: ["vitest", "run"],
    env: process.env,
    label: "vitest run",
  };
}

function runnerLabel(runner: Runner) {
  return (
    runnerOptions.find((option) => option.value === runner)?.label ?? runner
  );
}

function parseArgs(argv: string[]) {
  let requestedRepoRoot: string | undefined;
  let requestedRunner: Runner | undefined;
  let requestedMode: PlaywrightMode | undefined;
  let files: string[] = [];
  let shouldList = false;
  let shouldShowHelp = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help") {
      shouldShowHelp = true;
      continue;
    }

    if (arg === "--list") {
      shouldList = true;
      continue;
    }

    if (arg === "--repo") {
      const nextValue = argv[index + 1];
      index += 1;
      requestedRepoRoot = nextValue ? path.resolve(nextValue) : undefined;
      continue;
    }

    if (arg === "--runner") {
      const nextValue = argv[index + 1];
      index += 1;
      requestedRunner =
        nextValue === "playwright" ||
        nextValue === "vitest" ||
        nextValue === "browser"
          ? nextValue
          : undefined;
      continue;
    }

    if (arg === "--mode") {
      const nextValue = argv[index + 1];
      index += 1;
      requestedMode =
        nextValue === "ui"
          ? "playwright:ui:local"
          : nextValue === "headless"
            ? "playwright:headless:local"
            : undefined;
      requestedRunner ??= "playwright";
      continue;
    }

    if (arg === "--files") {
      const nextValue = argv[index + 1] ?? "";
      index += 1;
      files = nextValue
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    }
  }

  return {
    requestedRepoRoot,
    requestedRunner,
    requestedMode,
    files,
    shouldList,
    shouldShowHelp,
  };
}

function runTests(state: CliState) {
  return runTestsWithOptions(state, { exitOnComplete: true });
}

function runTestsWithOptions(
  state: CliState,
  options: {
    exitOnComplete: boolean;
    onExit?: (code: number) => void;
  },
) {
  const selectedFiles = [...state.selectedFiles].sort((left, right) =>
    left.localeCompare(right),
  );
  const resolved = resolveCommand(state);

  if (selectedFiles.length === 0) {
    output.write("\nSelect at least one file before running.\n");
    return null;
  }

  output.write(
    `\nRunning ${runnerLabel(state.runner)} via ${resolved.label} for ${selectedFiles.length} file(s)...\n\n`,
  );

  const child = spawn(resolved.command, [...resolved.args, ...selectedFiles], {
    cwd: repoRoot,
    env: resolved.env,
    stdio: "inherit",
  });

  child.on("exit", (code) => {
    options.onExit?.(code ?? 0);

    if (options.exitOnComplete) {
      process.exit(code ?? 0);
    }
  });

  return child;
}

function openBrowser(url: string) {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  const child = spawn(command, [url], {
    stdio: "ignore",
    detached: true,
    shell: process.platform === "win32",
  });
  child.unref();
}

function contentTypeForPath(assetPath: string) {
  if (assetPath.endsWith(".css")) return "text/css; charset=utf-8";
  if (assetPath.endsWith(".js")) return "application/javascript; charset=utf-8";
  return "text/html; charset=utf-8";
}

async function startWebMode(
  initialRunner?: Runner,
  initialMode?: PlaywrightMode,
) {
  const [playwrightTree, vitestTree, browserTree] = await Promise.all([
    buildRunnerTree("playwright"),
    buildRunnerTree("vitest"),
    buildRunnerTree("browser"),
  ]);
  const runner = initialRunner ?? "playwright";
  const mode = initialMode ?? "playwright:headless:local";
  let activeRun: ChildProcess | null = null;

  const server = createServer(async (req, res) => {
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");

    if (req.method === "GET" && requestUrl.pathname === "/") {
      const html = await readFile(
        path.join(launcherAssetsRoot, "index.html"),
        "utf8",
      );
      res.writeHead(200, { "content-type": contentTypeForPath("index.html") });
      res.end(html);
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/state") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          trees: {
            playwright: playwrightTree,
            vitest: vitestTree,
            browser: browserTree,
          },
          runners: runnerOptions,
          initialRunner: runner,
          initialMode: mode,
        }),
      );
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "GET") {
      const relativeAssetPath = requestUrl.pathname.replace(/^\//, "");
      const assetPath = path.normalize(
        path.join(launcherAssetsRoot, relativeAssetPath),
      );

      if (!assetPath.startsWith(launcherAssetsRoot)) {
        res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        res.end("Forbidden");
        return;
      }

      try {
        const asset = await readFile(assetPath, "utf8");
        res.writeHead(200, { "content-type": contentTypeForPath(assetPath) });
        res.end(asset);
        return;
      } catch {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }
    }

    if (req.method === "POST" && requestUrl.pathname === "/run") {
      const body = await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
      });

      const parsed = JSON.parse(body) as {
        runner?: Runner;
        mode?: PlaywrightMode;
        files?: string[];
      };
      const selectedFiles = new Set((parsed.files ?? []).filter(Boolean));
      const selectedRunner = parsed.runner ?? runner;
      const selectedMode = parsed.mode ?? mode;

      if (activeRun) {
        res.writeHead(409, {
          "content-type": "application/json; charset=utf-8",
        });
        res.end(
          JSON.stringify({
            message:
              "A test run is already in progress. Wait for it to finish before starting another.",
          }),
        );
        return;
      }

      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          message: `Started ${runnerLabel(selectedRunner)} for ${selectedFiles.size} selected file(s). Check the terminal for output.`,
        }),
      );

      activeRun = runTestsWithOptions(
        {
          runner: selectedRunner,
          mode: selectedRunner === "playwright" ? selectedMode : undefined,
          selectedFiles,
        },
        {
          exitOnComplete: false,
          onExit: () => {
            activeRun = null;
          },
        },
      );
      return;
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Could not start test launcher server.");
  }

  const url = `http://127.0.0.1:${address.port}`;
  output.write(`\nOpened test launcher at ${url}\n`);
  output.write(
    "Use the browser UI to search, select one or more files, and run them.\n\n",
  );
  openBrowser(url);
}

async function main() {
  const {
    requestedRepoRoot,
    requestedRunner,
    requestedMode,
    files,
    shouldList,
    shouldShowHelp,
  } = parseArgs(process.argv.slice(2));
  repoRoot = requestedRepoRoot ?? (await loadEnvRepoRoot()) ?? process.cwd();
  const runner = requestedRunner ?? "playwright";

  if (shouldShowHelp) {
    output.write(usage);
    return;
  }

  if (shouldList) {
    const tests = await getRunnerFiles(runner);
    tests.forEach((file) => output.write(`${file}\n`));
    return;
  }

  if (files.length > 0) {
    runTests({
      runner,
      mode:
        runner === "playwright"
          ? (requestedMode ?? "playwright:headless:local")
          : undefined,
      selectedFiles: new Set(files),
    });
    return;
  }

  await startWebMode(runner, requestedMode);
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
