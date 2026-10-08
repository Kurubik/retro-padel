export interface MenuRow {
  id: string;
  label: string;
  note?: string;
  disabled?: boolean;
}

export interface MenuModel {
  title: string;
  sub?: string;
  rows: MenuRow[];
  index: number;
  footLeft?: string;
  footRight?: string;
}

export interface MenuHandlers {
  onSelect: (id: string) => void;
  onHighlight: (index: number) => void;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  props?: Partial<Record<string, string>>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (props) for (const [k, v] of Object.entries(props)) if (v !== undefined) node.setAttribute(k, v);
  return node;
}

export function renderMenu(root: HTMLElement, model: MenuModel, handlers: MenuHandlers): void {
  root.innerHTML = '';
  const panel = h('div', 'ui__panel menu');
  const head = h('div', 'menu__head');
  const title = h('div', 'menu__title');
  title.textContent = model.title;
  head.append(title);
  if (model.sub) {
    const sub = h('div', 'menu__sub');
    sub.textContent = model.sub;
    head.append(sub);
  }
  const list = h('div', 'menu__list', { role: 'listbox', 'aria-label': model.title });
  model.rows.forEach((row, i) => {
    const item = h('button', 'menu__item', { type: 'button', 'data-id': row.id });
    item.setAttribute('aria-selected', String(i === model.index));
    const mark = h('span', 'menu__mark');
    mark.textContent = i === model.index ? '>' : '';
    const label = h('span', 'menu__label');
    label.textContent = row.label;
    const note = h('span', 'menu__note');
    note.textContent = row.note ?? '';
    item.append(mark, label, note);
    if (row.disabled) {
      item.disabled = true;
      item.setAttribute('aria-disabled', 'true');
    } else {
      item.addEventListener('click', () => handlers.onSelect(row.id));
      item.addEventListener('pointerenter', () => handlers.onHighlight(i));
    }
    list.append(item);
  });
  panel.append(head, list);
  const foot = h('div', 'menu__foot');
  const fl = h('span');
  fl.textContent = model.footLeft ?? '';
  const fr = h('span');
  fr.textContent = model.footRight ?? '';
  foot.append(fl, fr);
  panel.append(foot);
  root.append(panel);
}

export function renderRows(
  root: HTMLElement,
  model: { title: string; sub?: string; foot?: string },
  rows: { id: string; label: string; hint?: string; value: string; on?: boolean }[],
  index: number,
  handlers: { onSelect: (id: string) => void; onHighlight: (index: number) => void }
): void {
  root.innerHTML = '';
  const panel = h('div', 'ui__panel sheet');
  const head = h('div', 'sheet__head');
  const title = h('div', 'sheet__title');
  title.textContent = model.title;
  head.append(title);
  if (model.sub) {
    const sub = h('div', 'menu__sub');
    sub.textContent = model.sub;
    head.append(sub);
  }
  panel.append(head);
  const body = h('div', 'sheet__body');
  rows.forEach((row, i) => {
    const button = h('button', 'row', { type: 'button', 'data-id': row.id });
    if (i === index) button.dataset.selected = '1';
    const left = h('span');
    const label = h('span', 'row__label');
    label.textContent = (i === index ? '> ' : '') + row.label;
    left.append(label);
    if (row.hint) {
      const hint = h('span', 'row__hint');
      hint.textContent = row.hint;
      left.append(hint);
    }
    // Navigation rows carry no value; show the control only when there is one.
    if (row.value) {
      const value = h('span', 'row__value');
      value.textContent = row.value;
      if (row.on) value.dataset.on = '1';
      button.append(left, value);
    } else {
      button.append(left);
    }
    button.addEventListener('click', () => handlers.onSelect(row.id));
    button.addEventListener('pointerenter', () => handlers.onHighlight(i));
    body.append(button);
  });
  panel.append(body);
  if (model.foot) {
    const foot = h('div', 'sheet__foot');
    foot.textContent = model.foot;
    panel.append(foot);
  }
  root.append(panel);
}
