import { createMemo, createSignal } from "https://esm.sh/solid-js@1.9.9";
import { render } from "https://esm.sh/solid-js@1.9.9/web";
import html from "https://esm.sh/solid-js@1.9.9/html";
import { Header } from "./components/Header.js";
import { ModeSelector } from "./components/ModeSelector.js";
import { Breadcrumbs } from "./components/Breadcrumbs.js";
import { DirectorySection } from "./components/DirectorySection.js";
import { FileSection } from "./components/FileSection.js";
import { SelectedSpecsPanel } from "./components/SelectedSpecsPanel.js";

async function loadState() {
  const response = await fetch("/api/state");
  if (!response.ok) {
    throw new Error("Failed to load launcher state.");
  }

  return response.json();
}

function findNode(node, relativePath) {
  if (node.relativePath === relativePath) {
    return node;
  }

  for (const child of node.directories) {
    const found = findNode(child, relativePath);
    if (found) {
      return found;
    }
  }

  return null;
}

function relativeSegments(relativePath) {
  return relativePath ? relativePath.split("/").filter(Boolean) : [];
}

function shellQuote(value) {
  return /^[A-Za-z0-9_./:-]+$/.test(value) ? value : JSON.stringify(value);
}

function App(props) {
  const modes = [
    { value: "playwright:headless:local", label: "playwright:headless:local" },
    { value: "playwright:ui:local", label: "playwright:ui:local" },
  ];

  const [currentRunner, setCurrentRunner] = createSignal(props.initialRunner);
  const [currentPath, setCurrentPath] = createSignal("");
  const [currentMode, setCurrentMode] = createSignal(props.initialMode);
  const [selectedFiles, setSelectedFiles] = createSignal([]);
  const [status, setStatus] = createSignal({ message: "", kind: "default" });

  const currentTree = createMemo(() => props.trees[currentRunner()] ?? props.trees.playwright);
  const currentNode = createMemo(() => findNode(currentTree(), currentPath()) ?? currentTree());
  const orderedFiles = createMemo(() =>
    [...selectedFiles()].sort((left, right) => left.localeCompare(right))
  );
  const currentRunnerOption = createMemo(
    () => props.runners.find((runner) => runner.value === currentRunner()) ?? props.runners[0]
  );
  const command = createMemo(() => {
    const runner = currentRunner();

    if (runner === "playwright") {
      const modeFlag = currentMode() === "playwright:ui:local" ? "ui" : "headless";

      if (orderedFiles().length === 0) {
        return (
          "yarn test:launch -- --runner playwright --mode " +
          modeFlag +
          " --files tests/e2e/example.spec.ts"
        );
      }

      return [
        "yarn",
        "test:launch",
        "--",
        "--runner",
        "playwright",
        "--mode",
        modeFlag,
        "--files",
        orderedFiles().join(","),
      ]
        .map(shellQuote)
        .join(" ");
    }

    const sampleFile =
      runner === "browser"
        ? "tests/browser/example.browser.test.tsx"
        : "lib/example.test.ts";

    if (orderedFiles().length === 0) {
      return "yarn test:launch -- --runner " + runner + " --files " + shellQuote(sampleFile);
    }

    return [
      "yarn",
      "test:launch",
      "--",
      "--runner",
      runner,
      "--files",
      orderedFiles().join(","),
    ]
      .map(shellQuote)
      .join(" ");
  });

  const selectRunner = (runner) => {
    setCurrentRunner(runner);
    setCurrentPath("");
    setSelectedFiles([]);
    setStatus({ message: "", kind: "default" });
  };

  const toggleFile = (file) => {
    setSelectedFiles((current) =>
      current.includes(file) ? current.filter((entry) => entry !== file) : [...current, file]
    );
  };

  const clearSelection = () => {
    setSelectedFiles([]);
  };

  const toggleAllInCurrentDirectory = () => {
    const node = currentNode();
    const allSelected =
      node.files.length > 0 && node.files.every((file) => selectedFiles().includes(file));

    if (allSelected) {
      setSelectedFiles((current) => current.filter((file) => !node.files.includes(file)));
      return;
    }

    setSelectedFiles((current) => [...new Set([...current, ...node.files])]);
  };

  const copyCommand = async () => {
    if (orderedFiles().length === 0) {
      setStatus({
        message: "Select at least one test before copying the command.",
        kind: "default",
      });
      return;
    }

    try {
      await navigator.clipboard.writeText(command());
      setStatus({ message: "Command copied to clipboard.", kind: "success" });
    } catch {
      setStatus({
        message: "Clipboard copy failed. You can still copy the command from the preview.",
        kind: "default",
      });
    }
  };

  const runTests = async () => {
    if (orderedFiles().length === 0) {
      setStatus({ message: "Select at least one test first.", kind: "default" });
      return;
    }

    setStatus({
      message: "Starting " + currentRunnerOption().label + " in the terminal...",
      kind: "default",
    });

    const response = await fetch("/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runner: currentRunner(),
        mode: currentMode(),
        files: orderedFiles(),
      }),
    });

    const result = await response.json();
    setStatus({ message: result.message, kind: "success" });
  };

  return html`
    <div class="shell">
      ${Header()}

      <div class="layout">
        <section class="panel">
          <div class="section-title">Runner</div>
          ${ModeSelector({
            name: "runner",
            options: props.runners,
            currentValue: currentRunner,
            setCurrentValue: selectRunner,
          })}
          ${() =>
            currentRunner() === "playwright"
              ? html`
                  <div class="section-title">Playwright mode</div>
                  ${ModeSelector({
                    name: "mode",
                    options: modes,
                    currentValue: currentMode,
                    setCurrentValue: setCurrentMode,
                  })}
                `
              : ""}
          <div class="runner-description">${() => currentRunnerOption().description}</div>
          ${Breadcrumbs({
            currentPath,
            setCurrentPath,
            relativeSegments,
            rootLabel: () => currentTree().name,
          })}

          <div class="actions-row">
            <button class="action-button" type="button" onclick=${toggleAllInCurrentDirectory}>
              Toggle all files here
            </button>
            <button class="action-button" type="button" onclick=${clearSelection}>
              Clear selection
            </button>
          </div>

          ${DirectorySection({ currentNode, setCurrentPath })}
          ${FileSection({ currentNode, selectedFiles, toggleFile })}
        </section>

        ${SelectedSpecsPanel({
          orderedFiles,
          toggleFile,
          copyCommand,
          command,
          runTests,
          status,
          title: "Selected tests",
        })}
      </div>
    </div>
  `;
}

async function main() {
  const root = document.getElementById("app");

  if (!root) {
    return;
  }

  try {
    const { trees, runners, initialRunner, initialMode } = await loadState();
    render(() => App({ trees, runners, initialRunner, initialMode }), root);
  } catch (error) {
    render(
      () =>
        html`<div class="shell">
          <div class="status">${error instanceof Error ? error.message : String(error)}</div>
        </div>`,
      root
    );
  }
}

main();
