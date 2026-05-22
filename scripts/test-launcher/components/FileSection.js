import html from "https://esm.sh/solid-js@1.9.9/html";

function fileLabel(file) {
  return file.split("/").filter(Boolean).at(-1) ?? file;
}

export function FileSection(props) {
  return html`
    <div>
      <div class="section-title">Files</div>
      <div class="file-list">
        ${() =>
          props.files().length === 0
            ? html`<div class="empty">${typeof props.emptyMessage === "function"
                ? props.emptyMessage()
                : "No files to show."}</div>`
            : props.files().map(
                (file) => html`
                  <label class="file-item">
                    <input
                      type="checkbox"
                      checked=${() => props.selectedFiles().includes(file)}
                      onchange=${() => props.toggleFile(file)}
                    />
                    <span class="file-label" title=${file}>${fileLabel(file)}</span>
                  </label>
                `
              )}
      </div>
    </div>
  `;
}
