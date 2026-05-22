import html from "https://esm.sh/solid-js@1.9.9/html";

export function Header() {
  return html`
    <div class="header">
      <div class="eyebrow">Local Test Runner</div>
      <h1 class="title">Test Launcher</h1>
      <p class="subtitle">
        Switch between Playwright, Vitest, and browser-mode Vitest, then browse, multi-select,
        copy the rerun command, and launch the same local flows you already use.
      </p>
    </div>
  `;
}
