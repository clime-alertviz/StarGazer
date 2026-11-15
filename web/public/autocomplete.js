// Accessible address combobox; only an explicit selection supplies coordinates.
export function autocomplete(
  input,
  { search, onSelect, onClear, bias, country },
) {
  input.setAttribute(
    "aria-label",
    input.getAttribute("aria-label") ||
      [...(input.labels?.[0]?.childNodes || [])]
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent.trim())
        .join(" ") ||
      input.placeholder,
  );
  input.autocomplete = "off";
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");
  const list = document.createElement("div");
  list.className = "address-results";
  list.id = `results-${crypto.randomUUID()}`;
  list.setAttribute("role", "listbox");
  input.setAttribute("aria-controls", list.id);
  input.parentNode.append(list);
  let timer,
    controller,
    version = 0,
    items = [],
    selected = -1;
  function close() {
    list.replaceChildren();
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    input.removeAttribute("aria-busy");
    items = [];
    selected = -1;
  }
  function cancel() {
    clearTimeout(timer);
    controller?.abort();
    version++;
  }
  function status(message) {
    const el = document.createElement("div");
    el.className = "address-status";
    el.setAttribute("role", "status");
    el.textContent = message;
    list.replaceChildren(el);
    input.setAttribute("aria-expanded", "true");
  }
  function choose(i) {
    const p = items[i];
    if (!p) return;
    cancel();
    input.value = p.name;
    onSelect(p);
    close();
  }
  async function run() {
    cancel();
    close();
    const query = input.value.trim();
    if (query.length < 3) return;
    const current = version;
    controller = new AbortController();
    input.setAttribute("aria-busy", "true");
    status("Looking for places…");
    try {
      const nearby = bias?.(),
        region = country?.();
      const result = await search(
        {
          query,
          ...(nearby ? { bias: nearby } : {}),
          ...(region ? { country: region } : {}),
        },
        { signal: controller.signal },
      );
      if (current !== version || !input.isConnected) return;
      close();
      items = result;
      if (!items.length) {
        status(
          "No places found. Add the town name, for example “street, town”.",
        );
        return;
      }
      list.replaceChildren();
      for (const [i, p] of items.entries()) {
        const option = document.createElement("button");
        option.type = "button";
        option.id = `${list.id}-${i}`;
        option.setAttribute("role", "option");
        option.setAttribute("aria-selected", "false");
        option.textContent = p.name;
        option.addEventListener("mousedown", (e) => e.preventDefault());
        option.addEventListener("click", () => choose(i));
        list.append(option);
      }
      input.setAttribute("aria-expanded", "true");
    } catch (error) {
      if (current === version && error.name !== "AbortError") {
        input.removeAttribute("aria-busy");
        status(error.message);
      }
    }
  }
  input.addEventListener("input", () => {
    onClear?.();
    cancel();
    close();
    if (input.value.trim().length >= 3) timer = setTimeout(run, 250);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!items.length) return;
      e.preventDefault();
      selected =
        (selected + (e.key === "ArrowDown" ? 1 : -1) + items.length) %
        items.length;
      [...list.children].forEach((el, i) =>
        el.setAttribute("aria-selected", String(i === selected)),
      );
      input.setAttribute("aria-activedescendant", list.children[selected].id);
    }
    if (e.key === "Enter" && selected >= 0) {
      e.preventDefault();
      choose(selected);
    }
    if (e.key === "Escape") {
      cancel();
      close();
    }
  });
  input.addEventListener("blur", () =>
    setTimeout(() => {
      cancel();
      close();
    }, 150),
  );
  const cleanup = () => {
    cancel();
    close();
  };
  cleanup.refresh = run;
  return cleanup;
}
