import html from "https://esm.sh/solid-js@1.9.9/html";

export function ModeSelector(props) {
  return html`
    <div class="mode-row">
      ${() =>
        props.options.map(
          (option) => html`
            <label class="mode-option">
              <input
                type="radio"
                name=${props.name ?? "mode"}
                value=${option.value}
                checked=${() => props.currentValue() === option.value}
                onchange=${() => props.setCurrentValue(option.value)}
              />
              <span>${option.label}</span>
            </label>
          `
        )}
    </div>
  `;
}
